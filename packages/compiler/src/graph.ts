/** Generic DAG utilities used by the compiler, optimizer, and scheduler. */

export interface DagNode {
  id: string;
  deps: readonly string[];
}

export class CycleError extends Error {
  constructor(readonly cycle: string[]) {
    super(`Dependency cycle: ${cycle.join(" -> ")}`);
  }
}

/** Stable topological order (Kahn), preserving input order among ready nodes. Throws on cycles or missing deps. */
export function topoSort<T extends DagNode>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) for (const d of n.deps) if (!byId.has(d)) throw new Error(`Missing dependency "${d}" referenced by "${n.id}"`);
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const d of new Set(n.deps)) {
      indeg.set(n.id, indeg.get(n.id)! + 1);
      children.get(d)!.push(n.id);
    }
  }
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out: T[] = [];
  while (ready.length) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!);
    const id = ready.shift()!;
    out.push(byId.get(id)!);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) ready.push(c);
    }
  }
  if (out.length !== nodes.length) throw new CycleError(findCycle(nodes));
  return out;
}

export function findCycle(nodes: readonly DagNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const d of byId.get(id)?.deps ?? []) {
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.get(d)) {
        const c = dfs(d);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const n of nodes) if (!state.get(n.id)) {
    const c = dfs(n.id);
    if (c) return c.reverse();
  }
  return [];
}

/**
 * Bottom level of each node: the longest weighted path from the node to any sink, inclusive of
 * its own weight. Scheduling the node with the highest bottom level first is critical-path priority.
 */
export function bottomLevels<T extends DagNode>(nodes: readonly T[], weight: (n: T) => number): Map<string, number> {
  const order = topoSort(nodes);
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) children.get(d)!.push(n.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const bl = new Map<string, number>();
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i]!;
    const kids = children.get(n.id)!;
    bl.set(n.id, weight(byId.get(n.id)!) + (kids.length ? Math.max(...kids.map((k) => bl.get(k)!)) : 0));
  }
  return bl;
}

/** Critical path (node ids) and its total weight. */
export function criticalPath<T extends DagNode>(nodes: readonly T[], weight: (n: T) => number): { path: string[]; length: number } {
  if (nodes.length === 0) return { path: [], length: 0 };
  const bl = bottomLevels(nodes, weight);
  const children = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) children.get(d)!.push(n.id);
  const roots = nodes.filter((n) => n.deps.length === 0);
  let cur = roots.reduce((a, b) => (bl.get(a.id)! >= bl.get(b.id)! ? a : b));
  const path = [cur.id];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (;;) {
    const kids = children.get(cur.id)!;
    if (!kids.length) break;
    const next = kids.reduce((a, b) => (bl.get(a)! >= bl.get(b)! ? a : b));
    path.push(next);
    cur = byId.get(next)!;
  }
  return { path, length: bl.get(path[0]!)! };
}

/** Transitive reduction is not needed; this reports reachability for concurrency analysis. */
export function reachable(nodes: readonly DagNode[]): Map<string, Set<string>> {
  const order = topoSort(nodes);
  const reach = new Map<string, Set<string>>();
  for (const n of order) {
    const s = new Set<string>();
    for (const d of n.deps) {
      s.add(d);
      for (const x of reach.get(d) ?? []) s.add(x);
    }
    reach.set(n.id, s);
  }
  return reach;
}
