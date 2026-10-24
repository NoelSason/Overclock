import type { AppModel, EventPayload } from "@overclock/contracts";
import { renderTemplate, type CompiledSegment } from "@overclock/compiler";
import { compareCosts, equivalent, findAccessPathCandidates, keyFor, outputsFromRow, rowKey, scanNodes, type AccessPathCandidate, type LatencyModel } from "@overclock/optimizer";
import type { TaskInstance } from "@overclock/scheduler";
import type { Executor } from "./executor";

interface Tracked {
  c: AccessPathCandidate;
  state: "watching" | "scanning" | "ready" | "disabled";
  rows: Map<string, Record<string, string>>;
  scanPhase?: string | undefined;
  lastEvalAt: number;
  lastDecision?: string | undefined;
  substituted: number;
  scanStartedAt?: number | undefined;
}

const MIN_REMAINING = 5;
const MARGIN = 1.2;

/**
 * Online access-path optimization for streaming runs: decide from measured latency whether a
 * shared list scan beats the remaining per-record detail reads, run the scan through the normal
 * scheduler, prove equivalence on records already read the slow way, then serve unstarted
 * records from the scan. Every decision is emitted as a reopt.decision event with its numbers.
 */
export class AccessPathController {
  private readonly tracked = new Map<string, Tracked>();
  private scanSeq = 0;

  constructor(
    private readonly o: {
      executor: () => Executor;
      models: AppModel[];
      latency: LatencyModel;
      emit(e: EventPayload): void;
      now(): number;
      enabled: boolean;
    },
  ) {}

  onReleased(segments: CompiledSegment[]): void {
    if (!this.o.enabled) return;
    for (const c of findAccessPathCandidates(segments, this.o.models)) {
      if (this.tracked.has(c.segmentId)) continue;
      this.tracked.set(c.segmentId, { c, state: "watching", rows: new Map(), lastEvalAt: 0, substituted: 0 });
      this.o.emit({ type: "log", level: "info", message: `access path candidate: ${c.segmentId} (${c.detailTemplate}) could be served by scanning ${c.app} ${c.listPath}${c.pages ? ` (${c.pages} pages)` : ""}` });
    }
  }

  private tasksOf(segmentId: string): TaskInstance[] {
    return [...this.o.executor().scheduler.tasks.values()].filter((t) => t.segmentId === segmentId);
  }

  onTaskFinished(t: TaskInstance): void {
    const tr = this.tracked.get(t.segmentId);
    if (tr && tr.state === "watching") this.evaluate(tr);
    if (t.phaseId.startsWith("__scan")) {
      for (const x of this.tracked.values()) if (x.scanPhase === t.phaseId) this.maybeFinishScan(x);
    }
  }

  private evaluate(tr: Tracked): void {
    const now = this.o.now();
    if (now - tr.lastEvalAt < 1500) return;
    tr.lastEvalAt = now;
    const tasks = this.tasksOf(tr.c.segmentId);
    const done = tasks.filter((t) => t.state === "COMPLETED");
    const remaining = tasks.filter((t) => t.state === "PENDING" || t.state === "READY").length;
    if (done.length < 1) return;
    const measured = this.o.latency.segmentMs(this.o.executor().segment(tr.c.segmentId)!);
    const nav = this.o.latency.navMs(tr.c.app);
    const pages = tr.c.pages ?? Math.max(1, Math.ceil(tasks.length / 10));
    const cap = this.o.executor().aimd.get(tr.c.app)?.limit ?? 4;
    const parallelPages = !!(tr.c.pageParam && tr.c.pages);
    const cost = compareCosts({ remaining, detailMs: measured.ms, navMs: nav.ms, pages, workers: cap, parallelPages });
    const switchIt = remaining >= MIN_REMAINING && cost.detailMs > cost.scanMs * MARGIN;
    const reason = `${tr.c.segmentId}: ${remaining} records still need ${tr.c.detailTemplate} (${Math.round(measured.ms)} ms each, ${measured.source}, ${cap} concurrent) ≈ ${(cost.detailMs / 1000).toFixed(1)} s vs scanning ${tr.c.listPath} (${pages} page(s)${tr.c.pages ? "" : ", estimated"}, ${parallelPages ? "parallel" : "sequential"}) ≈ ${(cost.scanMs / 1000).toFixed(1)} s`;
    const decision = switchIt ? "switch" : "keep";
    if (decision !== tr.lastDecision) {
      tr.lastDecision = decision;
      this.o.emit({ type: "reopt.decision", switched: switchIt, reason: switchIt ? `start list scan — ${reason}` : `keep detail reads — ${reason}${remaining < MIN_REMAINING ? " (too few records left to pay off)" : ""}`, remainingMs: Math.round(cost.detailMs), alternativeMs: Math.round(cost.scanMs), alternative: `list scan of ${tr.c.app} ${tr.c.listPath}` });
    }
    if (switchIt) this.startScan(tr, pages, parallelPages);
  }

  private startScan(tr: Tracked, pages: number, parallel: boolean): void {
    tr.state = "scanning";
    tr.scanStartedAt = this.o.now();
    const phaseId = `__scan${++this.scanSeq}`;
    tr.scanPhase = phaseId;
    const sched = this.o.executor().scheduler;
    sched.addPhase({ id: phaseId, kind: "once", dependsOn: [], segmentIds: [] });
    const segs: CompiledSegment[] = [];
    const pageList = parallel ? Array.from({ length: pages }, (_, i) => i + 1) : [null];
    for (const p of pageList) {
      const prefix = `${phaseId}_p${p ?? "all"}`;
      const nodes = scanNodes(tr.c, p, prefix);
      segs.push({ id: `${phaseId}.${p ?? "all"}`, phaseId, app: tr.c.app, nodeIds: nodes.map((n) => n.id), nodes, dependsOn: [], effect: "read", kind: "scan", reads: nodes[0]!.reads, writes: [], label: `${tr.c.app} · scan ${tr.c.listPath}${p ? ` page ${p}` : ""} (access path)`, estimatedMs: this.o.latency.navMs(tr.c.app).ms + 80 });
    }
    sched.addSegments(phaseId, segs, "open");
    sched.sealPhase(phaseId);
    this.o.emit({ type: "fragment", fragmentId: `frag-${phaseId}`, phaseId, segmentIds: segs.map((s) => s.id), state: "released", label: `access path: scan ${tr.c.app} ${tr.c.listPath}`, reason: "optimizer-generated read fragment (no model call)", effect: "read" });
    this.o.executor().wake();
  }

  private maybeFinishScan(tr: Tracked): void {
    if (tr.state !== "scanning" || !tr.scanPhase) return;
    const sched = this.o.executor().scheduler;
    const scanTasks = [...sched.tasks.values()].filter((t) => t.phaseId === tr.scanPhase);
    if (scanTasks.some((t) => !["COMPLETED", "FAILED", "SKIPPED", "CANCELLED"].includes(t.state))) return;
    if (scanTasks.some((t) => t.state !== "COMPLETED")) {
      tr.state = "disabled";
      this.o.emit({ type: "reopt.decision", switched: false, reason: `list scan of ${tr.c.listPath} failed; continuing with detail reads`, remainingMs: 0, alternativeMs: null });
      return;
    }
    for (const t of scanTasks) {
      for (const [nodeId, out] of Object.entries(t.record.scope.out)) {
        if (!nodeId.endsWith("_rows")) continue;
        for (const row of ((out as { rows?: Record<string, string>[] })?.rows ?? [])) {
          const k = rowKey(tr.c, row);
          if (k) tr.rows.set(k, row);
        }
      }
    }
    // Equivalence: scanned values must match detail reads that already ran.
    const done = this.tasksOf(tr.c.segmentId).filter((t) => t.state === "COMPLETED").slice(0, 3);
    const diffs: string[] = [];
    let compared = 0;
    for (const t of done) {
      const key = keyFor(tr.c, { rec: t.record.scope.rec, out: t.record.scope.out, input: t.record.scope.input, phase: t.record.scope.phase, key: t.recordKey });
      const row = tr.rows.get(key);
      if (!row) continue;
      compared++;
      const eq = equivalent(tr.c, row, t.record.scope.out);
      if (!eq.ok) diffs.push(`${key}: ${eq.diffs.join(", ")}`);
    }
    const scanMs = Math.round(this.o.now() - (tr.scanStartedAt ?? this.o.now()));
    if (compared === 0 || diffs.length) {
      tr.state = "disabled";
      this.o.emit({ type: "reopt.decision", switched: false, reason: compared === 0 ? `scan finished in ${scanMs} ms but no already-read record was found in it to prove equivalence; keeping detail reads` : `scan values differ from detail reads (${diffs.slice(0, 2).join("; ")}); keeping detail reads`, remainingMs: 0, alternativeMs: scanMs });
      return;
    }
    tr.state = "ready";
    const remaining = this.tasksOf(tr.c.segmentId).filter((t) => t.state === "PENDING" || t.state === "READY").length;
    this.o.emit({ type: "reopt.decision", switched: true, reason: `scan of ${tr.c.listPath} returned ${tr.rows.size} rows in ${scanMs} ms and matched ${compared} detail read(s) exactly; serving ${remaining} unstarted record(s) from it`, remainingMs: 0, alternativeMs: scanMs, alternative: `list scan of ${tr.c.app} ${tr.c.listPath}` });
    this.o.executor().wake();
  }

  /** Executor hook: outputs for a ready detail-read task from the scan, or null to read normally. */
  substitute(t: TaskInstance): Record<string, unknown> | null {
    const tr = this.tracked.get(t.segmentId);
    if (!tr || tr.state !== "ready") return null;
    const scope = { rec: t.record.scope.rec, out: t.record.scope.out, input: t.record.scope.input, phase: t.record.scope.phase, key: t.recordKey };
    const key = keyFor(tr.c, scope);
    const row = tr.rows.get(key);
    if (!row) return null;
    tr.substituted++;
    return outputsFromRow(tr.c, row, renderTemplate(tr.c.detailTemplate, scope));
  }

  summary(): { candidates: number; scans: number; substituted: number } {
    const xs = [...this.tracked.values()];
    return { candidates: xs.length, scans: xs.filter((x) => x.scanPhase).length, substituted: xs.reduce((s, x) => s + x.substituted, 0) };
  }
}
