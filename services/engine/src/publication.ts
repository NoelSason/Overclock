import type { RecordOutcome } from "@overclock/contracts";
import { readBack, writeTargetUrl, type ActionEnv, type BrowserManager, type StorageState } from "@overclock/browser-runtime";
import type { Page } from "playwright";
import type { Executor, SkippedWrite } from "./executor";

/**
 * Whether a run's results may authorize publishing a capability, or count as a successful reuse.
 *
 * Every record must be VERIFIED or SKIPPED, as before, and every skipped write needs evidence that
 * it was a legitimate no-op. A skipped write took no action and produced no receipt: a
 * model-written condition that never comes true skips every record and still reports success. So
 * a skip counts only with one of these:
 *
 * - **rule applied:** the same write template made a VERIFIED write on another record of this
 *   run, so its condition demonstrably comes true and its write lands;
 * - **state verified:** a fresh read, in a context that blocks every mutation, shows the record
 *   already passes the write's own verification: the end state the write asserts is present.
 *
 * Anything else is an unproven skip, and the run can't authorize publication. Evidence never turns
 * a skip into a VERIFIED outcome; outcomes and receipts are unchanged.
 *
 * Limit: the engine has no independent oracle (the arena's checker is the harness's, not the
 * engine's). "Rule applied" shows a write template fires in this run; it can't show its condition
 * is right for every record, which the plan's adversarial review checks. The same limit applies to
 * verified writes: a read-back proves the plan's intended values landed, not that they were right.
 */
export interface SkipEvidence {
  taskId: string;
  segmentId: string;
  recordKey: string;
  evidence: "rule-applied" | "state-verified" | null;
  detail: string;
}

export interface PublicationDecision {
  allowed: boolean;
  /** Why not, when not allowed. */
  reasons: string[];
  skips: SkipEvidence[];
}

/** A fresh, mutation-blocked read of a skipped write's end state. */
export type StateCheck = (s: SkippedWrite) => Promise<{ ok: boolean; detail: string }>;

export async function decidePublication(args: { outcomes: readonly RecordOutcome[]; executor: Pick<Executor, "skippedWrites" | "verifiedWriteTemplates"> | null | undefined; checkState: StateCheck }): Promise<PublicationDecision> {
  const reasons: string[] = [];
  const { outcomes } = args;
  if (!outcomes.length) reasons.push("no record outcomes");
  const bad = outcomes.filter((o) => o.status !== "VERIFIED" && o.status !== "SKIPPED");
  if (bad.length) reasons.push(`${bad.length} record(s) not verified (${[...new Set(bad.map((o) => o.status))].join(", ")})`);
  const skips: SkipEvidence[] = [];
  if (!reasons.length && args.executor) {
    const applied = args.executor.verifiedWriteTemplates();
    for (const s of args.executor.skippedWrites()) {
      if (applied.has(s.segmentId)) {
        skips.push({ taskId: s.taskId, segmentId: s.segmentId, recordKey: s.recordKey, evidence: "rule-applied", detail: `${s.segmentId} made a verified write on another record` });
        continue;
      }
      if (!s.node.verify) {
        skips.push({ taskId: s.taskId, segmentId: s.segmentId, recordKey: s.recordKey, evidence: null, detail: `no write of ${s.segmentId} verified in this run, and the step has no verification to check its end state` });
        continue;
      }
      const r = await args.checkState(s);
      skips.push({ taskId: s.taskId, segmentId: s.segmentId, recordKey: s.recordKey, evidence: r.ok ? "state-verified" : null, detail: r.ok ? `a fresh read shows the end state ${s.node.id} asserts` : `no write of ${s.segmentId} verified in this run, and a fresh read doesn't show the end state it asserts (${r.detail})` });
    }
    const unproven = skips.filter((x) => !x.evidence);
    if (unproven.length) reasons.push(`${unproven.length} skipped write(s) without evidence of a legitimate no-op: ${unproven.slice(0, 3).map((x) => `${x.taskId}: ${x.detail}`).join("; ")}${unproven.length > 3 ? "; …" : ""}`);
  }
  return { allowed: reasons.length === 0, reasons, skips };
}

/** State checks in one mutation-blocked context with the run's own session, a page per origin. */
export function stateChecker(browser: BrowserManager, origins: string[], storageState: StorageState | undefined): { check: StateCheck; close(): Promise<void> } {
  let ctx: Awaited<ReturnType<BrowserManager["newContext"]>> | null = null;
  const pages = new Map<string, Page>();
  const allowed = new Set(origins);
  return {
    async check(s) {
      try {
        ctx ??= await browser.newContext({ allowedOrigins: origins, blockMutations: true, storageState });
        let page = pages.get(s.origin);
        if (!page) {
          page = await ctx.newPage();
          pages.set(s.origin, page);
        }
        const env: ActionEnv = { page, origin: s.origin, allowedOrigins: allowed, scope: s.scope, locatorOverrides: s.overrides, defaultTimeoutMs: 10_000 };
        const rb = await readBack(env, s.node.verify!, { timeoutMs: 10_000, entityUrl: writeTargetUrl(s.nodes, s.node.id, s.scope, s.origin) });
        return { ok: rb.ok, detail: rb.ok ? "matches" : rb.fields.filter((f) => !f.ok).map((f) => `${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.actual)}`).join(", ") || "read-back failed" };
      } catch (err) {
        return { ok: false, detail: (err as Error).message.split("\n")[0]! };
      }
    },
    async close() {
      await ctx?.close().catch(() => undefined);
    },
  };
}
