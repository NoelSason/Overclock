import { describe, expect, it } from "vitest";
import type { DslPlan, DslStep } from "@overclock/contracts";
import { bottomLevels, compileProgram, lowerPlan, recordFirstPriority } from "@overclock/compiler";
import { estimateCost, LatencyModel, recommendWorkers, selectCandidate, simulate } from "@overclock/optimizer";
import { apps, ordersModel, supportModel } from "../fixtures/appmodel";

const records = Array.from({ length: 40 }, (_, i) => ({ orderId: `O-${i}` }));

function compile(phases: DslPlan["phases"]) {
  const plan: DslPlan = { strategy: { name: "x", summary: "x", rationale: "x" }, phases, outcomes: [{ id: "o", description: "o" }], assumptions: [], risks: [] };
  const r = lowerPlan({ plan, models: [ordersModel, supportModel], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s" });
  expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  return compileProgram(r.program);
}

const detailRead: DslStep[] = [
  { id: "open", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
  { id: "read", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }] },
];
const perRecord = compile([{ id: "r", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: detailRead }]);
const tableScan = compile([
  { id: "scan", kind: "once", dependsOn: [], steps: [{ id: "list", op: "goto", app: "Orders", url: "/orders" }, { id: "rows", op: "extractTable", table: "orders.list.table", columns: [{ name: "id", header: "Order ID" }, { name: "status", header: "Status" }], key: "id", paginateNext: "orders.list.next", maxPages: 4 }] },
  { id: "r", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: ["scan"], steps: [{ id: "pick", op: "compute", assign: [{ name: "row", expr: "lookup($phase.scan.rows.rows, 'id', $rec.orderId)" }] }] },
]);

describe("list-scheduling simulator", () => {
  it("matches total work with one worker and scales with workers", () => {
    const lat = new LatencyModel();
    lat.observeNav("Orders", 200);
    const seg = (s: Parameters<LatencyModel["segmentMs"]>[0]) => lat.segmentMs(s).ms;
    const one = simulate({ compiled: perRecord, records: 40, workers: 1, segmentMs: seg, overheadMs: 0 });
    const eight = simulate({ compiled: perRecord, records: 40, workers: 8, segmentMs: seg, overheadMs: 0 });
    expect(one.makespanMs).toBeCloseTo(40 * (200 + 15), -1);
    expect(eight.makespanMs).toBeLessThan(one.makespanMs / 6);
    const capped = simulate({ compiled: perRecord, records: 40, workers: 8, perAppCap: { Orders: 2 }, segmentMs: seg, overheadMs: 0 });
    expect(capped.makespanMs).toBeCloseTo(one.makespanMs / 2, -2);
  });

  it("ranks a table-scan strategy above per-record page loads when reads dominate", () => {
    const lat = new LatencyModel();
    lat.observeNav("Orders", 300);
    const base = { records: 40, latency: lat, remainingModelMs: 0, modelCostUsd: 0, failureRate: { value: 0.01, source: "default" as const }, repairMs: { value: 2000, source: "default" as const } };
    const a = estimateCost({ ...base, compiled: perRecord, workers: 4 }).estimate;
    const b = estimateCost({ ...base, compiled: tableScan, workers: 4 }).estimate;
    const sel = selectCandidate([
      { id: "a", name: "per-record", estimate: a, valid: true },
      { id: "b", name: "table-scan", estimate: b, valid: true },
    ]);
    expect(sel.winner?.id).toBe("b");
    expect(sel.reason).toMatch(/table-scan/);
  });

  it("recommends the smallest worker count near the best makespan", () => {
    const lat = new LatencyModel();
    lat.observeNav("Orders", 250);
    const r = recommendWorkers({ compiled: tableScan, records: 40, latency: lat, remainingModelMs: 0, modelCostUsd: 0, failureRate: { value: 0, source: "default" }, repairMs: { value: 0, source: "default" } }, 16);
    // The scan is one sequential task: extra workers cannot help.
    expect(r.workers).toBe(1);
  });

  it("schedules exactly as re-sorting the ready list before every event would", () => {
    const lat = new LatencyModel();
    lat.observeNav("Orders", 180);
    lat.observeNav("Support", 90);
    const seg = (s: Parameters<LatencyModel["segmentMs"]>[0]) => lat.segmentMs(s).ms;
    const mixed = compile([
      { id: "r", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: detailRead },
      { id: "t", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: [{ id: "open_t", op: "goto", app: "Support", url: "/tickets?q={$rec.orderId}" }, { id: "pick", op: "compute", assign: [{ name: "x", expr: "1" }] }] },
    ]);
    for (const compiled of [perRecord, tableScan, mixed])
      for (const workers of [1, 3, 8])
        for (const perAppCap of [undefined, { Orders: 2 }]) {
          const input = { compiled, records: 40, workers, perAppCap, segmentMs: seg };
          expect(simulate(input)).toEqual(referenceSimulate(input));
        }
  });
});

/** The simulator as first written (stable re-sort of the ready list before every event), kept as the reference. */
function referenceSimulate(input: Parameters<typeof simulate>[0]): ReturnType<typeof simulate> {
  const { compiled, workers } = input;
  const overhead = input.overheadMs ?? 4;
  let clock = 0;
  let busy = 0;
  let totalTasks = 0;
  const phaseResults: ReturnType<typeof simulate>["phases"] = [];
  const contended = new Set(compiled.stats.contendedLocks);
  for (const phase of compiled.phases) {
    const segs = phase.segmentIds.map((id) => compiled.segments.get(id)!);
    const items = phase.kind === "once" ? 1 : /\$input\.records/.test(phase.over ?? "") ? input.records : (input.derivedPhaseItems?.(phase.id) ?? Math.max(1, Math.round(input.records * 0.15)));
    const bl = bottomLevels(
      segs.map((s) => ({ id: s.id, deps: s.dependsOn })),
      (n) => input.segmentMs(compiled.segments.get(n.id)!),
    );
    type T = { seg: (typeof segs)[number]; ms: number; deps: number; dependents: T[]; prio: number };
    const tasks: T[] = [];
    for (let r = 0; r < items; r++) {
      const local = new Map<string, T>();
      for (const s of segs) {
        const t: T = { seg: s, ms: input.segmentMs(s) + (s.app ? overhead : 0), deps: s.dependsOn.length, dependents: [], prio: recordFirstPriority(bl.get(s.id) ?? 0, r) };
        local.set(s.id, t);
        tasks.push(t);
      }
      for (const s of segs) for (const d of s.dependsOn) local.get(d)!.dependents.push(local.get(s.id)!);
    }
    totalTasks += tasks.length;
    const start = clock;
    const ready = tasks.filter((t) => t.deps === 0);
    const running: { end: number; t: T }[] = [];
    const appRunning = new Map<string, number>();
    let lockBusy = false;
    let done = 0;
    const finish = (t: T) => {
      done++;
      for (const d of t.dependents) if (--d.deps === 0) ready.push(d);
    };
    while (done < tasks.length) {
      ready.sort((a, b) => b.prio - a.prio);
      for (let i = ready.length - 1; i >= 0; i--) if (!ready[i]!.seg.app) finish(ready.splice(i, 1)[0]!);
      let assigned = true;
      while (assigned && running.length < workers) {
        assigned = false;
        for (let i = 0; i < ready.length; i++) {
          const t = ready[i]!;
          if (!t.seg.app) continue;
          if ((appRunning.get(t.seg.app) ?? 0) >= (input.perAppCap?.[t.seg.app] ?? Infinity)) continue;
          const locked = t.seg.writes.some((w) => contended.has(w));
          if (locked && lockBusy) continue;
          ready.splice(i, 1);
          appRunning.set(t.seg.app, (appRunning.get(t.seg.app) ?? 0) + 1);
          if (locked) lockBusy = true;
          running.push({ end: clock + t.ms, t });
          busy += t.ms;
          assigned = true;
          break;
        }
      }
      if (running.length === 0) {
        if (ready.some((t) => !t.seg.app)) continue;
        break;
      }
      running.sort((a, b) => a.end - b.end);
      const next = running.shift();
      if (!next) break;
      clock = next.end;
      appRunning.set(next.t.seg.app!, appRunning.get(next.t.seg.app!)! - 1);
      if (next.t.seg.writes.some((w) => contended.has(w))) lockBusy = false;
      finish(next.t);
    }
    phaseResults.push({ id: phase.id, items, ms: Math.round(clock - start), tasks: tasks.length });
  }
  return { makespanMs: Math.round(clock), phases: phaseResults, tasks: totalTasks, busyMs: Math.round(busy), utilization: clock > 0 ? busy / (clock * workers) : 0 };
}
