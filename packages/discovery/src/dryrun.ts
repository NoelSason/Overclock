import type { AppBinding } from "@overclock/contracts";
import { BrowserWorker, runSegment, type BrowserManager, type RecordScope, type StorageState } from "@overclock/browser-runtime";
import { evaluate, toStr, type CompiledProgram } from "@overclock/compiler";
import type { LatencyModel } from "@overclock/optimizer";

export interface DryRunResult {
  ok: boolean;
  ms: number;
  segments: { segmentId: string; ms: number; ok: boolean; skipped?: string; error?: string }[];
  failures: string[];
  blockedMutations: number;
}

/**
 * Adversarial Verifier, dry-run part: execute a candidate's read-only segments for its first
 * record in an isolated context that aborts every non-GET request. This validates locators and
 * table columns against the live UI and measures real latencies before anything is committed.
 * Write segments and everything downstream of them are skipped; scans are capped at 2 pages.
 */
export async function dryRunCandidate(args: {
  compiled: CompiledProgram;
  browser: BrowserManager;
  storageState?: StorageState | undefined;
  apps: AppBinding[];
  inputs: Record<string, unknown>;
  latency?: LatencyModel;
  signal?: AbortSignal;
}): Promise<DryRunResult> {
  const start = performance.now();
  const origins = args.apps.map((a) => a.origin);
  const ctx = await args.browser.newContext({ allowedOrigins: origins, blockMutations: true, storageState: args.storageState });
  const worker = new BrowserWorker("dry-run", ctx, new Map(args.apps.map((a) => [a.name, a.origin])), () => undefined);
  const out: DryRunResult = { ok: true, ms: 0, segments: [], failures: [], blockedMutations: 0 };
  const phaseOutputs: Record<string, unknown> = {};
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  try {
    for (const phase of args.compiled.phases) {
      if (args.signal?.aborted) break;
      let rec: Record<string, unknown> = {};
      let key = "_";
      if (phase.kind === "foreach") {
        if (!/\$input\.records/.test(phase.over ?? "")) {
          out.segments.push(...phase.segmentIds.map((id) => ({ segmentId: id, ms: 0, ok: true, skipped: "derived list (needs full upstream results)" })));
          continue;
        }
        const list = evaluate(phase.over ?? "[]", { input: args.inputs, phase: phaseOutputs, out: {}, rec: {} });
        if (!Array.isArray(list) || list.length === 0) continue;
        rec = list[0] as Record<string, unknown>;
        key = toStr(evaluate(phase.key ?? "$rec.id", { input: args.inputs, rec, out: {}, phase: phaseOutputs }));
      }
      const scope: RecordScope = { key, rec, input: args.inputs, out: {}, phase: phaseOutputs };
      const skipped = new Set<string>();
      for (const segId of phase.segmentIds) {
        const seg = args.compiled.segments.get(segId)!;
        if (seg.kind === "write" || seg.dependsOn.some((d) => skipped.has(d))) {
          skipped.add(segId);
          out.segments.push({ segmentId: segId, ms: 0, ok: true, skipped: seg.kind === "write" ? "write (never executed in dry run)" : "depends on a write" });
          continue;
        }
        if (!seg.app && !worker.currentPage()) {
          // A compute segment with no page yet: evaluate it on any app page.
          await worker.pageFor(args.apps[0]!.name);
        }
        const nodes = seg.nodes.map((n) => (n.table?.pagination ? { ...n, table: { ...n.table, pagination: { ...n.table.pagination, maxPages: 2 } } } : n));
        const t0 = performance.now();
        try {
          await runSegment(
            worker,
            { taskId: `dry:${segId}`, app: seg.app, nodes, scope, allowedOrigins: allowed, locatorOverrides: new Map() },
            {
              signal: args.signal,
              onAction: (a) => {
                if (!args.latency || !a.ok) return;
                if (a.actionType === "navigate" && seg.app) args.latency.observeNav(seg.app, a.ms);
                else args.latency.observeAction(a.actionType, a.ms);
              },
            },
          );
          out.segments.push({ segmentId: segId, ms: Math.round(performance.now() - t0), ok: true });
        } catch (err) {
          const msg = (err as Error).message.split("\n")[0]!.slice(0, 240);
          out.ok = false;
          out.failures.push(`${seg.label}: ${msg}`);
          out.segments.push({ segmentId: segId, ms: Math.round(performance.now() - t0), ok: false, error: msg });
          skipped.add(segId);
        }
      }
      phaseOutputs[phase.id] = phase.kind === "once" ? scope.out : [{ key, rec, out: scope.out, ok: true }];
    }
  } finally {
    out.blockedMutations = args.browser.guardStats.get(ctx)?.blockedMutations ?? 0;
    await ctx.close();
  }
  out.ms = Math.round(performance.now() - start);
  return out;
}
