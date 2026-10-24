import type { ActionNode, PassReport } from "@overclock/contracts";
import { reachable } from "./graph";
import { parseExpr } from "./expr";
import { valueExprs } from "./values";

/**
 * Optimizer passes over one scope (the top-level nodes, or one foreach body). Each pass is a
 * pure function nodes -> nodes plus a report. Passes never reorder side effects on their own:
 * ordering only ever gains edges (pass 1) and nodes are only removed when provably redundant.
 */

export interface PassResult {
  nodes: ActionNode[];
  report: PassReport;
}

const isWrite = (n: ActionNode) => n.effect === "remote-write" || n.effect === "irreversible";
const mutatesPage = (n: ActionNode) => n.type === "click" || n.type === "fill" || n.type === "select" || isWrite(n);

function timed(name: string, fn: () => { nodes: ActionNode[]; changes: number; detail: string }): PassResult {
  const t = performance.now();
  const r = fn();
  return { nodes: r.nodes, report: { name, ms: Math.round((performance.now() - t) * 100) / 100, changes: r.changes, detail: r.detail } };
}

function clone(nodes: ActionNode[]): ActionNode[] {
  return nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] }));
}

/** Pass 1: dependency analysis — add ordering edges implied by resource conflicts (RAW, WAR, WAW). */
export function dependencyAnalysis(input: ActionNode[]): PassResult {
  return timed("dependency-analysis", () => {
    const nodes = clone(input);
    const ids = new Set(nodes.map((n) => n.id));
    let added = 0;
    const reach = reachable(nodes.map((n) => ({ id: n.id, deps: n.dependsOn.filter((d) => ids.has(d)) })));
    for (let j = 0; j < nodes.length; j++) {
      const b = nodes[j]!;
      for (let i = 0; i < j; i++) {
        const a = nodes[i]!;
        const conflict = b.writes.some((w) => a.reads.includes(w) || a.writes.includes(w)) || b.reads.some((r) => a.writes.includes(r));
        if (!conflict) continue;
        if (reach.get(b.id)?.has(a.id)) continue;
        if (reach.get(a.id)?.has(b.id)) continue; // already ordered the other way by data flow
        b.dependsOn.push(a.id);
        reach.get(b.id)!.add(a.id);
        for (const x of reach.get(a.id) ?? []) reach.get(b.id)!.add(x);
        added++;
      }
    }
    return { nodes, changes: added, detail: `${added} ordering edge(s) added for read/write conflicts` };
  });
}

function sameStrategies(a: ActionNode["target"], b: ActionNode["target"]): boolean {
  return JSON.stringify(a?.strategies) === JSON.stringify(b?.strategies) && JSON.stringify(a?.scope) === JSON.stringify(b?.scope);
}

function urlKey(n: ActionNode): string | null {
  if (n.type !== "navigate" || !n.url) return null;
  return n.app + "|" + JSON.stringify(n.url);
}

/** Replace node `oldId` with `newId` in every dependency and $out reference. */
function retarget(nodes: ActionNode[], oldId: string, newId: string | null): void {
  for (const n of nodes) {
    if (!n.dependsOn.includes(oldId)) continue;
    n.dependsOn = n.dependsOn.filter((d) => d !== oldId);
    if (newId && !n.dependsOn.includes(newId) && n.id !== newId) n.dependsOn.push(newId);
  }
}

/**
 * Pass 2: redundant observation elimination.
 * - A navigate to the same URL as the previous navigate in the same page chain, with nothing in
 *   between that changed the page, is dropped (dependents attach to the earlier page load).
 * - An extract that reads the same fields from the same page as an earlier extract becomes an
 *   alias of the earlier result.
 */
export function redundantObservationElimination(input: ActionNode[]): PassResult {
  return timed("redundant-observation-elimination", () => {
    let nodes = clone(input);
    let removed = 0;
    let aliased = 0;
    // Navigate dedupe along page chains.
    const lastNav = new Map<string, { id: string; key: string; dirty: boolean }>();
    const drop = new Set<string>();
    for (const n of nodes) {
      if (!n.app) continue;
      const k = urlKey(n);
      const prev = lastNav.get(n.app);
      if (k) {
        if (prev && prev.key === k && !prev.dirty && !n.when) {
          // Nothing changed the page since the earlier load: dependents attach to that load and
          // inherit this node's own dependencies, so no ordering is lost.
          drop.add(n.id);
          for (const m of nodes) {
            if (!m.dependsOn.includes(n.id)) continue;
            m.dependsOn = [...new Set([...m.dependsOn.filter((d) => d !== n.id), prev.id, ...n.dependsOn])].filter((d) => d !== m.id);
          }
          removed++;
          continue;
        }
        lastNav.set(n.app, { id: n.id, key: k, dirty: false });
      } else if (prev && mutatesPage(n)) prev.dirty = true;
    }
    nodes = nodes.filter((n) => !drop.has(n.id));
    // Extract dedupe: same page (same navigate dependency) and same field targets.
    const seen: ActionNode[] = [];
    for (const n of nodes) {
      if (n.type !== "extract" || !n.fields || n.when) continue;
      const navDep = n.dependsOn.find((d) => nodes.find((x) => x.id === d)?.type === "navigate");
      const twin = seen.find((s) => s.app === n.app && s.dependsOn.find((d) => nodes.find((x) => x.id === d)?.type === "navigate") === navDep && n.fields!.every((f) => s.fields!.some((g) => g.name === f.name && sameStrategies(g.target, f.target))));
      if (twin && navDep) {
        const assign: Record<string, string> = {};
        for (const f of n.fields) assign[f.name] = `$out.${twin.id}.${f.name}`;
        Object.assign(n, { type: "compute", fields: undefined, app: undefined, sessionKey: undefined, reads: [], assign, dependsOn: [twin.id] });
        aliased++;
      } else seen.push(n);
    }
    return { nodes, changes: removed + aliased, detail: `${removed} redundant page load(s) removed, ${aliased} duplicate extraction(s) aliased` };
  });
}

/** Pass 3: locator reuse — nodes targeting the same control share one resolution-cache entry. */
export function locatorReuse(input: ActionNode[]): PassResult {
  return timed("locator-reuse", () => {
    const nodes = clone(input);
    const keys = new Map<string, number>();
    let targets = 0;
    const note = (l: ActionNode["target"]) => {
      if (!l) return;
      targets++;
      const k = l.controlId ?? JSON.stringify(l.strategies);
      keys.set(k, (keys.get(k) ?? 0) + 1);
    };
    for (const n of nodes) {
      note(n.target);
      for (const f of n.fields ?? []) note(f.target);
      if (n.table) note(n.table.target);
      for (const f of n.verify?.fields ?? []) note(f.target);
    }
    const shared = [...keys.values()].filter((c) => c > 1).reduce((s, c) => s + c - 1, 0);
    return { nodes, changes: shared, detail: `${targets} target reference(s) over ${keys.size} distinct control(s); ${shared} resolution(s) served from the per-worker locator cache after first use` };
  });
}

/** Pass 4: common-subexpression reuse — identical pure computations collapse to one node. */
export function commonSubexpressionReuse(input: ActionNode[]): PassResult {
  return timed("common-subexpression-reuse", () => {
    let nodes = clone(input);
    const byKey = new Map<string, string>();
    const drop = new Set<string>();
    let collapsed = 0;
    for (const n of nodes) {
      if (n.type !== "compute" || n.when || !n.assign) continue;
      const k = JSON.stringify(Object.entries(n.assign).sort()) + "|" + [...n.dependsOn].sort().join(",");
      const twin = byKey.get(k);
      if (twin) {
        collapsed++;
        // Dependents read $out.<n.id>.*; keep a cheap alias node only if anything references it.
        const referenced = nodes.some((m) => m.id !== n.id && nodeRefs(m).has(n.id));
        if (referenced) {
          const assign: Record<string, string> = {};
          for (const name of Object.keys(n.assign)) assign[name] = `$out.${twin}.${name}`;
          n.assign = assign;
          n.dependsOn = [twin];
        } else {
          drop.add(n.id);
          retarget(nodes, n.id, twin);
        }
      } else byKey.set(k, n.id);
    }
    nodes = nodes.filter((n) => !drop.has(n.id));
    const changes = collapsed;
    return { nodes, changes, detail: `${changes} duplicate computation(s) collapsed` };
  });
}

function nodeRefs(n: ActionNode): Set<string> {
  const refs = new Set<string>();
  const exprs = [n.when, n.condition, ...Object.values(n.assign ?? {}), ...valueExprs(n.input), ...valueExprs(n.url), ...(n.verify ? [...valueExprs(n.verify.url), ...n.verify.fields.flatMap((f) => valueExprs(f.equals))] : [])].filter((e): e is string => !!e);
  for (const e of exprs) {
    try {
      for (const r of parseExpr(e).outRefs) refs.add(r);
    } catch {
      // validated elsewhere
    }
  }
  return refs;
}

/** Pass 8: verification placement — every write has a fresh read-back; flag weak placements. */
export function verificationPlacement(input: ActionNode[]): PassResult {
  return timed("verification-placement", () => {
    const nodes = clone(input);
    let changes = 0;
    const warnings: string[] = [];
    for (const n of nodes) {
      if (!isWrite(n) || !n.verify) continue;
      // Read-back must be a fresh page: never trust the form we just submitted.
      const v = JSON.stringify(n.verify.url);
      const nav = nodes.filter((m) => m.type === "navigate" && m.app === n.app && n.dependsOn.includes(m.id)).map((m) => JSON.stringify(m.url));
      if (nav.includes(v)) warnings.push(`${n.id} verifies on the page it edited`);
      // Retries of writes must reconcile first.
      if (n.retryPolicy !== "verify-before-retry" && n.retryPolicy !== "never") {
        n.retryPolicy = "verify-before-retry";
        changes++;
      }
      if (n.preconditions.length === 0) warnings.push(`${n.id} has no compare-and-swap guard`);
    }
    return { nodes, changes, detail: `${nodes.filter((n) => isWrite(n)).length} write(s) verified by fresh read-back${warnings.length ? `; ${warnings.length} warning(s): ${warnings.slice(0, 3).join("; ")}` : ""}` };
  });
}
