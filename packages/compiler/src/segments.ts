import type { ActionNode, Effect, PhaseTemplate, SegmentTemplate } from "@overclock/contracts";
import { topoSort } from "./graph";

export interface CompiledSegment extends SegmentTemplate {
  nodes: ActionNode[];
}

const isWrite = (n: ActionNode) => n.effect === "remote-write" || n.effect === "irreversible";
const EFFECT_RANK: Record<Effect, number> = { read: 0, "local-write": 1, "remote-write": 2, irreversible: 3 };

function label(app: string | undefined, nodes: ActionNode[]): string {
  const ops = nodes.map((n) => {
    if (n.type === "navigate" && n.url) {
      const u = "template" in n.url ? n.url.template : "value" in n.url ? String(n.url.value) : "…";
      return `open ${u.replace(/\{[^}]*\}/g, "…")}`;
    }
    if (isWrite(n)) return "submit";
    if (n.type === "extract" && n.table) return "scan table";
    return n.type;
  });
  return `${app ?? "compute"} · ${ops.join(" → ")}`;
}

/** Node types that never change page or app state: a page they ran on can be re-opened safely. */
export const PURE_TYPES: ReadonlySet<string> = new Set(["navigate", "extract", "compute", "assert", "waitFor", "branch", "checkpoint"]);

/**
 * Pass 5 (navigation grouping): partition a scope's nodes into segments — maximal page chains on
 * one app that a single worker executes back to back. Invariants:
 *  - a segment contains at most one remote write and ends with it (so a retry after
 *    reconciliation never repeats an earlier, already-committed write);
 *  - a node joins the open segment of its app only if it continues that page chain and every
 *    other dependency is already upstream of the segment (the segment graph stays acyclic);
 *  - pure computations at join points become browser-free compute segments;
 *  - a page action that cannot join its chain without a cycle (it needs a decision computed from
 *    that same chain's reads) starts a new segment that re-opens the page, provided only reads
 *    ran on the page since it was opened.
 */
export function formSegments(phaseId: string, nodes: ActionNode[], estimate: (n: ActionNode) => number, external: ReadonlyMap<string, string> = new Map()): CompiledSegment[] {
  const scopeIds = new Set(nodes.map((n) => n.id));
  const order = topoSort(nodes.map((n) => ({ ...n, deps: n.dependsOn.filter((d) => scopeIds.has(d)) })));
  const segs: (CompiledSegment & { closed: boolean })[] = [];
  const segOf = new Map<string, string>();
  const byId = new Map<string, (typeof segs)[number]>();
  /** Transitive upstream segments (computed on demand; the graph is small). */
  const upstreamOf = (id: string): Set<string> => {
    const out = new Set<string>();
    // Released (external) segments are not in this scope: they have no known upstream here.
    const stack = [...(byId.get(id)?.dependsOn ?? [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (out.has(d)) continue;
      out.add(d);
      stack.push(...(byId.get(d)?.dependsOn ?? []));
    }
    return out;
  };

  const newSeg = (n: ActionNode, deps: Set<string>) => {
    const s = {
      id: `${phaseId}.s${segs.length + 1}`,
      phaseId,
      app: n.app,
      nodeIds: [] as string[],
      nodes: [] as ActionNode[],
      dependsOn: [...deps],
      effect: "read" as Effect,
      kind: (n.app ? "read" : "compute") as SegmentTemplate["kind"],
      reads: [] as string[],
      writes: [] as string[],
      label: "",
      estimatedMs: 0,
      closed: false,
    };
    segs.push(s);
    byId.set(s.id, s);
    return s;
  };

  for (const raw of order) {
    const n = nodes.find((x) => x.id === raw.id)!;
    // Dependencies on already-released segments (incremental compilation) count as real segment deps.
    const deps = n.dependsOn.filter((d) => scopeIds.has(d) || external.has(d));
    const depSegs = new Set(deps.map((d) => segOf.get(d) ?? external.get(d)!));
    let target: (typeof segs)[number] | undefined;
    if (n.app) {
      // Continue an open chain on the same app whose last node we depend on. Page state lives on
      // one worker, so a page-continuing node must join that chain; its other dependencies are
      // hoisted to the segment's start (allowed whenever that cannot create a cycle).
      // The page-continuity dependency is the most recent earlier node on the same app, so try
      // candidates latest-first (data dependencies on older reads must not capture the chain).
      const pos = new Map(nodes.map((x, i) => [x.id, i]));
      const candidates = [...deps].sort((a, b) => pos.get(b)! - pos.get(a)!);
      for (const d of candidates) {
        const s = segOf.has(d) ? byId.get(segOf.get(d)!) : undefined;
        if (!s) continue;
        if (s.closed || s.app !== n.app || s.nodeIds.at(-1) !== d) continue;
        if (n.type === "navigate" && s.nodes.some(isWrite)) continue;
        const extra = [...depSegs].filter((x) => x !== s.id && !upstreamOf(s.id).has(x));
        if (extra.some((x) => x === s.id || upstreamOf(x).has(s.id))) continue;
        s.dependsOn.push(...extra);
        target = s;
        break;
      }
    } else if (depSegs.size === 1) {
      const s = byId.get([...depSegs][0]!);
      if (s && !s.closed && (n.type === "compute" || n.type === "assert" || n.type === "branch")) target = s;
    }
    if (!target && n.app && n.type !== "navigate") {
      // A page action that cannot join its page's chain would run on a page no worker loaded.
      const pageDep = deps.map((d) => (segOf.has(d) ? byId.get(segOf.get(d)!) : undefined)).find((s) => s?.app === n.app);
      if (pageDep && !pageDep.closed) {
        const nav = [...pageDep.nodes].reverse().find((x) => x.type === "navigate");
        const since = nav ? pageDep.nodes.slice(pageDep.nodes.indexOf(nav) + 1) : [];
        if (!nav || !since.every((x) => PURE_TYPES.has(x.type))) throw new Error(`Cannot place ${n.id}: its page chain on ${n.app} would form a cycle`);
        const renav: ActionNode = { ...nav, id: `${n.id}__renav`, dependsOn: [...nav.dependsOn], description: `re-open page for ${n.id}` };
        target = newSeg(renav, depSegs);
        target.nodeIds.push(renav.id);
        target.nodes.push(renav);
        target.kind = "read";
        target.estimatedMs += estimate(renav);
        segOf.set(renav.id, target.id);
      }
    }
    const seg = target ?? newSeg(n, depSegs);
    seg.nodeIds.push(n.id);
    seg.nodes.push(n);
    segOf.set(n.id, seg.id);
    if (EFFECT_RANK[n.effect] > EFFECT_RANK[seg.effect]) seg.effect = n.effect;
    for (const r of n.reads) if (!seg.reads.includes(r)) seg.reads.push(r);
    for (const w of n.writes) if (!seg.writes.includes(w)) seg.writes.push(w);
    seg.estimatedMs += estimate(n);
    if (n.app) seg.app ??= n.app;
    if (isWrite(n)) {
      seg.kind = "write";
      seg.closed = true;
    } else if (n.type === "extract" && n.table && seg.kind !== "write") seg.kind = "scan";
    else if (n.app && seg.kind === "compute") seg.kind = "read";
  }
  for (const s of segs) s.label = label(s.app, s.nodes);
  return segs.map(({ closed: _c, ...s }) => ({ ...s, dependsOn: [...new Set(s.dependsOn)].sort() }));
}

export interface PhaseInfo extends PhaseTemplate {
  over?: string | undefined;
  key?: string | undefined;
  maxIterations?: number | undefined;
}

/** Recover phase structure from lowered IR (foreach nodes and once-phase checkpoints). */
export function phasesOf(nodes: ActionNode[]): { phase: PhaseInfo; body: ActionNode[] }[] {
  const phaseIds = new Set(nodes.filter((n) => n.type === "foreach" || n.type === "checkpoint").map((n) => n.id));
  const out: { phase: PhaseInfo; body: ActionNode[] }[] = [];
  for (const n of nodes) {
    if (n.type === "foreach") {
      out.push({ phase: { id: n.id, kind: "foreach", dependsOn: n.dependsOn.filter((d) => phaseIds.has(d)), segmentIds: [], over: n.over, key: n.key, maxIterations: n.maxIterations }, body: n.body ?? [] });
    } else if (n.type === "checkpoint" && n.dependsOn.length > 0) {
      const members = new Set(n.dependsOn);
      const body = nodes.filter((m) => members.has(m.id));
      const deps = new Set<string>();
      for (const b of body) for (const d of b.dependsOn) if (phaseIds.has(d)) deps.add(d);
      // Inside the phase, dependencies on other phases are barriers, not node edges.
      const local = body.map((b) => ({ ...b, dependsOn: b.dependsOn.filter((d) => !phaseIds.has(d)) }));
      out.push({ phase: { id: n.id, kind: "once", dependsOn: [...deps], segmentIds: [] }, body: local });
    }
  }
  return out;
}
