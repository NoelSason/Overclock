import type { PhaseTemplate, SegmentTemplate } from "@overclock/contracts";

/**
 * Template-graph helpers: effective segment dependencies, critical path, and a layered layout.
 *
 * Segment `dependsOn` only references segments in the same phase; phases depend on phases.
 * A phase dependency is expanded to edges from the sink segments of the upstream phase to the
 * source segments of the downstream phase, so the critical path can cross phase boundaries.
 */

export interface SegmentEdge {
  from: string;
  to: string;
  /** True when the edge comes from a phase-level dependency rather than segment.dependsOn. */
  implicit: boolean;
}

export function segmentEdges(phases: PhaseTemplate[], segments: SegmentTemplate[]): SegmentEdge[] {
  const ids = new Set(segments.map((s) => s.id));
  const edges: SegmentEdge[] = [];
  for (const s of segments) for (const d of s.dependsOn) if (ids.has(d)) edges.push({ from: d, to: s.id, implicit: false });

  const byPhase = new Map<string, SegmentTemplate[]>();
  for (const s of segments) byPhase.set(s.phaseId, [...(byPhase.get(s.phaseId) ?? []), s]);
  const hasInPhaseDep = new Set(edges.map((e) => e.to));
  const isInPhaseDep = new Set(edges.map((e) => e.from));
  for (const p of phases) {
    const sources = (byPhase.get(p.id) ?? []).filter((s) => !hasInPhaseDep.has(s.id));
    for (const up of p.dependsOn) {
      const sinks = (byPhase.get(up) ?? []).filter((s) => !isInPhaseDep.has(s.id));
      for (const a of sinks) for (const b of sources) edges.push({ from: a.id, to: b.id, implicit: true });
    }
  }
  return edges;
}

export interface CriticalPath {
  segmentIds: Set<string>;
  edgeKeys: Set<string>;
  totalMs: number;
}

export const edgeKey = (from: string, to: string) => `${from}->${to}`;

/** Longest path by `estimatedMs`. Returns an empty path if the graph has a cycle or no estimates. */
export function criticalPath(segments: SegmentTemplate[], edges: SegmentEdge[]): CriticalPath {
  const empty: CriticalPath = { segmentIds: new Set(), edgeKeys: new Set(), totalMs: 0 };
  if (segments.length === 0 || segments.every((s) => !(s.estimatedMs > 0))) return empty;
  const preds = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  const succ = new Map<string, string[]>();
  for (const s of segments) {
    preds.set(s.id, []);
    succ.set(s.id, []);
    indeg.set(s.id, 0);
  }
  for (const e of edges) {
    preds.get(e.to)?.push(e.from);
    succ.get(e.from)?.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const est = new Map(segments.map((s) => [s.id, Math.max(0, s.estimatedMs)]));
  const dist = new Map<string, number>();
  const via = new Map<string, string | null>();
  const queue = segments.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    let best = 0;
    let bestPred: string | null = null;
    for (const p of preds.get(id) ?? []) {
      const d = dist.get(p) ?? 0;
      if (d > best) {
        best = d;
        bestPred = p;
      }
    }
    dist.set(id, best + (est.get(id) ?? 0));
    via.set(id, bestPred);
    for (const n of succ.get(id) ?? []) {
      indeg.set(n, (indeg.get(n) ?? 0) - 1);
      if (indeg.get(n) === 0) queue.push(n);
    }
  }
  if (visited !== segments.length) return empty;
  let end: string | null = null;
  let max = -1;
  for (const [id, d] of dist) if (d > max) [end, max] = [id, d];
  const out: CriticalPath = { segmentIds: new Set(), edgeKeys: new Set(), totalMs: max };
  for (let cur = end; cur; cur = via.get(cur) ?? null) {
    out.segmentIds.add(cur);
    const p = via.get(cur);
    if (p) out.edgeKeys.add(edgeKey(p, cur));
  }
  return out;
}

// --- Layout ---------------------------------------------------------------------------------

export const NODE_W = 228;
export const NODE_H = 104;
const COL_GAP = 48;
const ROW_GAP = 16;
const PAD = 16;
const HEADER = 30;
const PHASE_GAP_X = 72;
const PHASE_GAP_Y = 32;

export interface PhaseBox {
  phase: PhaseTemplate;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SegmentPos {
  segment: SegmentTemplate;
  /** Relative to the phase box. */
  x: number;
  y: number;
}

/** Phases left-to-right by dependency level (parallel phases stack); segments by in-phase depth. */
export function layoutTemplate(phases: PhaseTemplate[], segments: SegmentTemplate[]): { phases: PhaseBox[]; segments: SegmentPos[] } {
  const phaseIds = new Set(phases.map((p) => p.id));
  const level = new Map<string, number>();
  const levelOf = (id: string, seen: Set<string>): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const p = phases.find((x) => x.id === id);
    const deps = (p?.dependsOn ?? []).filter((d) => phaseIds.has(d));
    const l = deps.length ? Math.max(...deps.map((d) => levelOf(d, seen))) + 1 : 0;
    level.set(id, l);
    return l;
  };
  for (const p of phases) levelOf(p.id, new Set());

  const segsByPhase = new Map<string, SegmentTemplate[]>();
  for (const s of segments) segsByPhase.set(s.phaseId, [...(segsByPhase.get(s.phaseId) ?? []), s]);

  const inner = new Map<string, { width: number; height: number; pos: SegmentPos[] }>();
  for (const p of phases) {
    const segs = segsByPhase.get(p.id) ?? [];
    const ids = new Set(segs.map((s) => s.id));
    const depth = new Map<string, number>();
    const depthOf = (s: SegmentTemplate, seen: Set<string>): number => {
      const c = depth.get(s.id);
      if (c !== undefined) return c;
      if (seen.has(s.id)) return 0;
      seen.add(s.id);
      const deps = s.dependsOn.filter((d) => ids.has(d)).map((d) => segs.find((x) => x.id === d)!);
      const d = deps.length ? Math.max(...deps.map((x) => depthOf(x, seen))) + 1 : 0;
      depth.set(s.id, d);
      return d;
    };
    const cols: SegmentTemplate[][] = [];
    for (const s of segs) (cols[depthOf(s, new Set())] ??= []).push(s);
    const pos: SegmentPos[] = [];
    cols.forEach((col, ci) => col.forEach((s, ri) => pos.push({ segment: s, x: PAD + ci * (NODE_W + COL_GAP), y: HEADER + PAD + ri * (NODE_H + ROW_GAP) })));
    const nCols = Math.max(1, cols.length);
    const nRows = Math.max(1, ...cols.map((c) => c?.length ?? 0));
    inner.set(p.id, { width: PAD * 2 + nCols * NODE_W + (nCols - 1) * COL_GAP, height: HEADER + PAD * 2 + nRows * NODE_H + (nRows - 1) * ROW_GAP, pos });
  }

  const byLevel = new Map<number, PhaseTemplate[]>();
  for (const p of phases) byLevel.set(level.get(p.id) ?? 0, [...(byLevel.get(level.get(p.id) ?? 0) ?? []), p]);
  const boxes: PhaseBox[] = [];
  let x = 0;
  for (const l of [...byLevel.keys()].sort((a, b) => a - b)) {
    let y = 0;
    let colW = 0;
    for (const p of byLevel.get(l)!) {
      const box = inner.get(p.id)!;
      boxes.push({ phase: p, x, y, width: box.width, height: box.height });
      y += box.height + PHASE_GAP_Y;
      colW = Math.max(colW, box.width);
    }
    x += colW + PHASE_GAP_X;
  }
  return { phases: boxes, segments: [...inner.values()].flatMap((b) => b.pos) };
}

/** Segments in display order (phase level, then layout column, then row). */
export function orderedSegments(phases: PhaseTemplate[], segments: SegmentTemplate[]): SegmentTemplate[] {
  const layout = layoutTemplate(phases, segments);
  const boxIndex = new Map(layout.phases.map((b, i) => [b.phase.id, i]));
  return [...layout.segments]
    .sort((a, b) => (boxIndex.get(a.segment.phaseId) ?? 0) - (boxIndex.get(b.segment.phaseId) ?? 0) || a.x - b.x || a.y - b.y)
    .map((p) => p.segment);
}

// --- Cached per-program derivations ----------------------------------------------------------

export interface ProgramGraph {
  edges: SegmentEdge[];
  critical: CriticalPath;
  layout: ReturnType<typeof layoutTemplate>;
  /** Segments in display order (graph columns / heatmap columns). */
  ordered: SegmentTemplate[];
  byId: Map<string, SegmentTemplate>;
}

const graphCache = new WeakMap<object, ProgramGraph>();

/** Derived graph data for a compiled program, cached by program object identity. */
export function programGraph(program: { phases: PhaseTemplate[]; segments: SegmentTemplate[] }): ProgramGraph {
  const hit = graphCache.get(program);
  if (hit) return hit;
  const edges = segmentEdges(program.phases, program.segments);
  const g: ProgramGraph = {
    edges,
    critical: criticalPath(program.segments, edges),
    layout: layoutTemplate(program.phases, program.segments),
    ordered: orderedSegments(program.phases, program.segments),
    byId: new Map(program.segments.map((s) => [s.id, s])),
  };
  graphCache.set(program, g);
  return g;
}
