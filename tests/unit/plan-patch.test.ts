import { describe, expect, it } from "vitest";
import type { DslPlan } from "@overclock/contracts";
import { applyPlanPatch } from "../../packages/discovery/src/planner";

const base: DslPlan = {
  strategy: { name: "per-record", summary: "s", rationale: "r" },
  phases: [
    {
      id: "per_order",
      kind: "foreach",
      over: "$input.records",
      key: "$rec.orderId",
      dependsOn: [],
      steps: [
        { id: "open", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
        { id: "read", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }] },
        { id: "decide", op: "compute", assign: [{ name: "go", expr: "$out.read.status == 'refunded'" }] },
      ],
    },
    { id: "holds", kind: "once", dependsOn: ["per_order"], steps: [{ id: "noop", op: "compute", assign: [{ name: "x", expr: "1" }] }] },
  ],
  outcomes: [{ id: "o", description: "d" }],
  assumptions: [],
  risks: [],
};

const ids = (p: DslPlan, phase = 0) => p.phases[phase]!.steps.map((s) => s.id);

describe("plan patches", () => {
  it("replaces, inserts, and deletes steps without touching the rest", () => {
    const out = applyPlanPatch(base, {
      edits: [
        { op: "replaceSteps", stepId: "decide", steps: [{ id: "decide", op: "compute", assign: [{ name: "go", expr: "lower(trim($out.read.status)) == 'refunded'" }], when: "", note: "" }] },
        { op: "insertAfter", stepId: "read", steps: [{ id: "read_more", op: "extract", fields: [{ name: "email", control: "orders.detail.customer_email", parse: "string" }] }] },
        { op: "replaceSteps", stepId: "noop", steps: [] },
      ],
    });
    expect(ids(out)).toEqual(["open", "read", "read_more", "decide"]);
    expect(ids(out, 1)).toEqual([]);
    // Model sentinels ("" for an absent `when`) are normalized away, as for a full plan.
    expect(out.phases[0]!.steps.find((s) => s.id === "decide")).not.toHaveProperty("when");
    expect(base.phases[0]!.steps).toHaveLength(3); // the input plan is not mutated
  });

  it("replaces a whole phase", () => {
    const out = applyPlanPatch(base, { edits: [{ op: "replacePhase", phaseId: "holds", phase: { id: "holds", kind: "once", dependsOn: ["per_order"], steps: [{ id: "count", op: "compute", assign: [{ name: "n", expr: "len($phase.per_order)" }] }] } }] });
    expect(ids(out, 1)).toEqual(["count"]);
  });

  it("rejects edits to unknown steps or phases and steps that don't fit the schema", () => {
    expect(() => applyPlanPatch(base, { edits: [{ op: "replaceSteps", stepId: "nope", steps: [] }] })).toThrow(/unknown step/);
    expect(() => applyPlanPatch(base, { edits: [{ op: "replacePhase", phaseId: "nope", phase: {} }] })).toThrow(/unknown phase/);
    expect(() => applyPlanPatch(base, { edits: [{ op: "insertAfter", stepId: "read", steps: [{ id: "bad", op: "teleport" }] }] })).toThrow();
  });
});
