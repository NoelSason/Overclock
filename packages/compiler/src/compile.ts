import type { ActionNode, ExecutionProgram, PassReport, TemplateGraph } from "@overclock/contracts";
import { bottomLevels, criticalPath } from "./graph";
import { commonSubexpressionReuse, dependencyAnalysis, locatorReuse, redundantObservationElimination, verificationPlacement, type PassResult } from "./passes";
import { formSegments, phasesOf, type CompiledSegment, type PhaseInfo } from "./segments";
import { templateExprs } from "./expr";

export interface CompiledProgram {
  program: ExecutionProgram;
  phases: PhaseInfo[];
  segments: Map<string, CompiledSegment>;
  graph: TemplateGraph;
  passes: PassReport[];
  /** Per-record critical path through one phase's segments (ms), and total work. */
  stats: { segments: number; writeSegments: number; perRecordCriticalMs: Record<string, number>; perRecordWorkMs: Record<string, number>; maxParallelismPerRecord: number; contendedLocks: string[] };
  /** Segment priority (bottom level within its phase, ms). */
  priority: Map<string, number>;
  compileMs: number;
}

export type NodeEstimator = (n: ActionNode) => number;

/** Fallback latency model before anything has been measured. */
export const defaultEstimator: NodeEstimator = (n) => {
  switch (n.type) {
    case "navigate":
      return 250;
    case "click":
      return n.effect === "remote-write" || n.effect === "irreversible" ? 450 + 280 : 200;
    case "fill":
    case "select":
      return 30;
    case "extract":
      return n.table ? 4 * 320 : 15 * (n.fields?.length ?? 1);
    case "waitFor":
      return 200;
    default:
      return 1;
  }
};

function runScope(nodes: ActionNode[], reports: PassReport[], scope: string): ActionNode[] {
  const passes: ((x: ActionNode[]) => PassResult)[] = [dependencyAnalysis, redundantObservationElimination, locatorReuse, commonSubexpressionReuse, verificationPlacement];
  let cur = nodes;
  for (const p of passes) {
    const r = p(cur);
    cur = r.nodes;
    const existing = reports.find((x) => x.name === r.report.name);
    if (existing) {
      existing.ms += r.report.ms;
      existing.changes += r.report.changes;
      if (r.report.changes) existing.detail += ` | ${scope}: ${r.report.detail}`;
    } else reports.push({ ...r.report, detail: `${scope}: ${r.report.detail}` });
  }
  return cur;
}

/**
 * Compile validated IR into a schedulable template graph: run the optimizer passes per scope,
 * form segments (pass 5), extract concurrency (pass 6), and attach resource-aware priorities
 * (pass 7). Instances per record are created later by the scheduler (late foreach expansion).
 */
export function compileProgram(program: ExecutionProgram, estimate: NodeEstimator = defaultEstimator): CompiledProgram {
  const t0 = performance.now();
  const reports: PassReport[] = [];
  const phases: PhaseInfo[] = [];
  const segments = new Map<string, CompiledSegment>();
  const priority = new Map<string, number>();
  const perRecordCriticalMs: Record<string, number> = {};
  const perRecordWorkMs: Record<string, number> = {};
  let maxPar = 1;
  const contended = new Set<string>();

  const tSeg = performance.now();
  for (const { phase, body } of phasesOf(program.nodes)) {
    const optimized = runScope(body, reports, phase.id);
    const segs = formSegments(phase.id, optimized, estimate);
    phase.segmentIds = segs.map((s) => s.id);
    for (const s of segs) segments.set(s.id, s);
    phases.push(phase);
    const dag = segs.map((s) => ({ id: s.id, deps: s.dependsOn }));
    const cp = criticalPath(dag, (n) => segments.get(n.id)!.estimatedMs);
    perRecordCriticalMs[phase.id] = Math.round(cp.length);
    perRecordWorkMs[phase.id] = Math.round(segs.reduce((a, s) => a + s.estimatedMs, 0));
    maxPar = Math.max(maxPar, perRecordWorkMs[phase.id]! / Math.max(1, cp.length));
    for (const [id, v] of bottomLevels(dag, (n) => segments.get(n.id)!.estimatedMs)) priority.set(id, v);
    // Lock keys that do not vary per record serialize every instance of the segment.
    if (phase.kind === "foreach") for (const s of segs) for (const w of s.writes) if (templateExprs(w).length === 0) contended.add(w);
  }
  const segCount = segments.size;
  const writes = [...segments.values()].filter((s) => s.kind === "write").length;
  reports.push({
    name: "navigation-grouping",
    ms: Math.round((performance.now() - tSeg) * 100) / 100,
    changes: segCount,
    detail: `${[...phases].reduce((n, p) => n + (p.kind === "foreach" ? 1 : 0), 0)} per-record phase(s); nodes grouped into ${segCount} segment(s), ${writes} ending in a verified write`,
  });
  reports.push({
    name: "concurrency-extraction",
    ms: 0,
    changes: Math.round(maxPar * 100) / 100,
    detail: `max intra-record parallelism ${maxPar.toFixed(2)}x; records are independent within a phase unless their write locks collide`,
  });
  reports.push({
    name: "resource-aware-scheduling",
    ms: 0,
    changes: priority.size,
    detail: `critical-path priorities for ${priority.size} segment(s)${contended.size ? `; per-run constant locks serialize: ${[...contended].join(", ")}` : "; all write locks are per-record"}`,
  });
  const order = ["dependency-analysis", "redundant-observation-elimination", "locator-reuse", "common-subexpression-reuse", "navigation-grouping", "concurrency-extraction", "resource-aware-scheduling", "verification-placement"];
  reports.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const graph: TemplateGraph = {
    phases: phases.map((p) => ({ id: p.id, kind: p.kind, dependsOn: p.dependsOn, segmentIds: p.segmentIds })),
    segments: [...segments.values()].map(({ nodes: _n, ...s }) => s),
  };
  return {
    program,
    phases,
    segments,
    graph,
    passes: reports,
    stats: { segments: segCount, writeSegments: writes, perRecordCriticalMs, perRecordWorkMs, maxParallelismPerRecord: maxPar, contendedLocks: [...contended] },
    priority,
    compileMs: performance.now() - t0,
  };
}
