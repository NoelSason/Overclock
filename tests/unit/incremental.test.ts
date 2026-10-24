import { describe, expect, it } from "vitest";
import type { DslStep } from "@overclock/contracts";
import { compileProgram, defaultEstimator, IncrementalCompiler, lowerPlan } from "@overclock/compiler";
import { apps, ordersModel, supportModel } from "../fixtures/appmodel";

const records = [{ orderId: "ORD-1" }, { orderId: "ORD-2" }];
const steps: DslStep[] = [
  { id: "open_order", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
  { id: "read_order", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }] },
  { id: "find_ticket", op: "goto", app: "Support", url: "/tickets?q={$rec.orderId}" },
  { id: "read_tickets", op: "extractTable", table: "support.list.table", columns: [{ name: "ticketId", header: "Ticket" }, { name: "status", header: "Status" }], key: "ticketId" },
  { id: "decide", op: "compute", assign: [{ name: "needs", expr: "lower($out.read_order.status) == 'refunded'" }, { name: "ticket", expr: "first($out.read_tickets.rows)" }] },
  { id: "open_edit", op: "goto", app: "Support", url: "/tickets/{$out.decide.ticket.ticketId}/edit", when: "$out.decide.needs" },
  { id: "set_status", op: "select", control: "support.edit.status", value: "'resolved'", when: "$out.decide.needs" },
  {
    id: "save",
    op: "submit",
    control: "support.edit.submit",
    when: "$out.decide.needs",
    writes: ["app:support:ticket:{$out.decide.ticket.ticketId}"],
    guards: [],
    verify: { url: "/tickets/{$out.decide.ticket.ticketId}", fields: [{ name: "status", control: "support.detail.status", equals: "'resolved'" }] },
    irreversible: false,
  },
];

function compiler() {
  return new IncrementalCompiler({ models: [ordersModel, supportModel], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s", estimate: defaultEstimator });
}

describe("incremental compiler", () => {
  it("releases read fragments while later steps are still unknown, and writes only when complete", () => {
    const c = compiler();
    const info = c.addPhase({ id: "per_order", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [] })!;
    expect(info.kind).toBe("foreach");
    const log: string[][] = [];
    for (const s of steps) {
      const r = c.addStep("per_order", s);
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      log.push(r.released.map((x) => `${x.segment.nodeIds.join("+")}${x.write ? " [write]" : ""}`));
    }
    log.push(c.sealPhase("per_order").released.map((x) => x.segment.nodeIds.join("+")));
    // The Orders read chain is released as soon as the stream moves on to the next app.
    expect(log[0]).toEqual([]);
    expect(log[1]).toEqual([]);
    expect(log[2]).toEqual(["open_order+read_order"]);
    expect(log[4]?.some((x) => x.includes("read_tickets"))).toBe(true);
    expect(log[7]).toEqual(["open_edit+set_status+save [write]"]);
    // Every node ends up in exactly one released fragment.
    const all = c.releasedOrder.flatMap((r) => r.segment.nodeIds.filter((id) => !id.endsWith("__renav")));
    expect(new Set(all)).toEqual(new Set(steps.map((s) => s.id)));
  });

  it("never releases form fills before their submit, even when another step streams in between", () => {
    // Seen live: goto edit -> select -> compute -> submit. The compute step made the stream "move
    // on", the select was released alone, and the submit could no longer join its page.
    const c = compiler();
    c.addPhase({ id: "per_order", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [] });
    const between: DslStep = { id: "note_text", op: "compute", assign: [{ name: "why", expr: "concat('refund ', $rec.orderId)" }] };
    const order = [...steps.slice(0, 7), between, steps[7]!];
    const released: string[] = [];
    for (const st of order) {
      const r = c.addStep("per_order", st);
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      for (const x of r.released) released.push(`${x.segment.nodeIds.join("+")}${x.write ? " [write]" : ""}`);
    }
    c.sealPhase("per_order");
    expect(released.some((x) => x === "open_edit+set_status")).toBe(false);
    expect(released).toContain("open_edit+set_status+save [write]");
    expect(c.unreleasedSteps("per_order")).toEqual([]);
  });

  it("streams the same work as the staged compiler (plus explicit re-navigations)", () => {
    const c = compiler();
    c.addPhase({ id: "per_order", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [] });
    // Feed the step list in two batches, like a stream that pauses mid-plan.
    for (const s of steps.slice(0, 4)) c.addStep("per_order", s);
    for (const s of steps.slice(4)) c.addStep("per_order", s);
    c.sealPhase("per_order");
    const staged = compileProgram(lowerPlan({ plan: { strategy: { name: "x", summary: "", rationale: "" }, phases: [{ id: "per_order", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps }], outcomes: [{ id: "o", description: "o" }], assumptions: [], risks: [] }, models: [ordersModel, supportModel], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s" }).program);
    const stagedWrites = [...staged.segments.values()].filter((s) => s.kind === "write").map((s) => s.nodeIds.join("+"));
    const streamedWrites = c.releasedOrder.filter((r) => r.write).map((r) => r.segment.nodeIds.join("+"));
    expect(streamedWrites).toEqual(stagedWrites);
    // Released segments only depend on earlier released segments.
    const seen = new Set<string>();
    for (const r of c.releasedOrder) {
      for (const d of r.segment.dependsOn) expect(seen.has(d)).toBe(true);
      seen.add(r.segment.id);
    }
  });

  it("holds back steps that reference controls nobody observed", () => {
    const c = compiler();
    c.addPhase({ id: "per_order", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [] });
    c.addStep("per_order", steps[0]!);
    const bad = c.addStep("per_order", { id: "read_bad", op: "extract", fields: [{ name: "x", control: "orders.detail.nope", parse: "string" }] });
    expect(bad.released).toEqual([]);
    expect(bad.issues.some((i) => i.code === "unknown-control")).toBe(true);
    expect(c.unreleasedSteps("per_order")).toContain("read_bad");
  });
});
