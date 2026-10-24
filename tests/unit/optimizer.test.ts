import { describe, expect, it } from "vitest";
import type { DslPlan, DslStep } from "@overclock/contracts";
import { compileProgram, lowerPlan } from "@overclock/compiler";
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
});
