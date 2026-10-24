import { describe, expect, it } from "vitest";
import type { ActionNode, DslPlan, DslStep } from "@overclock/contracts";
import { addReadGuards, compileProgram, inheritSubmitConditions, dependencyAnalysis, evaluate, commonSubexpressionReuse, hasErrors, lowerPlan, redundantObservationElimination, renderTemplate, topoSort, validateProgram, verificationPlacement, type Scope } from "@overclock/compiler";
import { apps, ordersModel, supportModel } from "../fixtures/appmodel";

const records = [{ orderId: "ORD-1" }, { orderId: "ORD-2" }];

const steps: DslStep[] = [
  { id: "open_order", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
  { id: "read_order", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }, { name: "email", control: "orders.detail.customer_email", parse: "string" }] },
  { id: "find_ticket", op: "goto", app: "Support", url: "/tickets?q={$rec.orderId}" },
  { id: "read_tickets", op: "extractTable", table: "support.list.table", columns: [{ name: "ticketId", header: "Ticket" }, { name: "status", header: "Status" }], key: "ticketId" },
  { id: "decide", op: "compute", assign: [{ name: "ticket", expr: "first($out.read_tickets.rows)" }, { name: "needs", expr: "lower($out.read_order.status) == 'refunded' && $out.read_tickets.rows[0].status != 'resolved'" }] },
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

function plan(s: DslStep[] = steps, extra: Partial<DslPlan["phases"][number]> = {}): DslPlan {
  return {
    strategy: { name: "per-record", summary: "test", rationale: "test" },
    phases: [{ id: "reconcile", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: s, ...extra }],
    outcomes: [{ id: "o1", description: "refunded tickets resolved" }],
    assumptions: [],
    risks: [],
  };
}

function lower(p: DslPlan) {
  return lowerPlan({ plan: p, models: [ordersModel, supportModel], apps, goal: "test", inputs: { records }, programId: "p1", strategyId: "s1" });
}

describe("lowering and validation", () => {
  it("lowers a valid plan with resolved locators and passes validation", () => {
    const { program, issues } = lower(plan());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(validateProgram(program)).toEqual([]);
    const fe = program.nodes[0]!;
    expect(fe.type).toBe("foreach");
    const save = fe.body!.find((n) => n.id === "save")!;
    expect(save.effect).toBe("remote-write");
    expect(save.retryPolicy).toBe("verify-before-retry");
    expect(save.target?.controlId).toBe("support.edit.submit");
    expect(save.verify?.fields[0]?.target.controlId).toBe("support.detail.status");
    expect(fe.body!.find((n) => n.id === "decide")!.dependsOn.sort()).toEqual(["read_order", "read_tickets"]);
  });

  it("checks compare-and-swap guards before the form is modified", () => {
    const guarded = steps.map((st) => (st.op === "submit" ? { ...st, guards: [{ control: "support.edit.status", equals: "$out.read_tickets.rows[0].status" }] } : st));
    const { program } = lower(plan(guarded as DslStep[]));
    const body = program.nodes[0]!.body!;
    const select = body.find((n) => n.id === "set_status")!;
    const save = body.find((n) => n.id === "save")!;
    expect(select.preconditions).toHaveLength(1);
    expect(select.preconditions[0]!.kind).toBe("fieldEquals");
    expect(save.preconditions).toHaveLength(0);
  });

  it("drops a guard that expects the value the same form is about to write", () => {
    // Seen live: a repaired plan guarded the note box with the note text it was about to type,
    // so the guard could only pass after the write had already happened.
    const guarded = steps.map((st) => (st.op === "submit" ? { ...st, guards: [{ control: "support.edit.status", equals: "'resolved'" }] } : st));
    const { program, issues } = lower(plan(guarded as DslStep[]));
    expect(issues.some((i) => i.code === "self-defeating-guard" && i.severity === "warning")).toBe(true);
    const body = program.nodes[0]!.body!;
    expect(body.find((n) => n.id === "set_status")!.preconditions).toHaveLength(0);
    expect(body.find((n) => n.id === "save")!.preconditions).toHaveLength(0);
  });

  it("re-opens a page when acting on it needs a decision computed from that page's own reads", () => {
    // Seen live: open the ticket, read it, read the order elsewhere, decide from both, then act on
    // the ticket page. Joining the ticket chain would make it depend on itself.
    const cyc: DslStep[] = [
      { id: "open_order", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
      { id: "read_order", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }] },
      { id: "open_ticket", op: "goto", app: "Support", url: "/tickets/{$rec.ticketId}" },
      { id: "read_ticket", op: "extract", fields: [{ name: "status", control: "support.detail.status", parse: "string" }] },
      { id: "decide", op: "compute", assign: [{ name: "go", expr: "$out.read_order.status == 'refunded' && $out.read_ticket.status != 'resolved'" }] },
      { id: "set_status", op: "select", control: "support.edit.status", value: "'resolved'", when: "$out.decide.go" },
      {
        id: "save",
        op: "submit",
        control: "support.edit.submit",
        when: "$out.decide.go",
        writes: ["app:support:ticket:{$rec.ticketId}"],
        guards: [],
        verify: { url: "/tickets/{$rec.ticketId}", fields: [{ name: "status", control: "support.detail.status", equals: "'resolved'" }] },
        irreversible: false,
      },
    ];
    const { program, issues } = lower(plan(cyc));
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const c = compileProgram(program);
    const write = [...c.segments.values()].find((x) => x.kind === "write")!;
    expect(write.nodeIds[0]).toBe("set_status__renav");
    expect(write.nodes[0]!.type).toBe("navigate");
    expect(write.nodes[0]!.url).toEqual(program.nodes[0]!.body!.find((n) => n.id === "open_ticket")!.url);
    const decideSeg = [...c.segments.values()].find((x) => x.nodeIds.includes("decide"))!;
    expect(write.dependsOn).toContain(decideSeg.id);
  });

  it("adds the compare-and-swap guard a plan forgot for a field it read and then overwrites", () => {
    const readThenEdit: DslStep[] = [
      steps[0]!,
      steps[1]!,
      { id: "open_edit", op: "goto", app: "Support", url: "/tickets/{$rec.orderId}/edit" },
      { id: "read_form", op: "extract", fields: [{ name: "status", control: "support.edit.status", parse: "string" }] },
      { id: "set_status", op: "select", control: "support.edit.status", value: "'resolved'" },
      { ...(steps[7] as Extract<DslStep, { op: "submit" }>), when: undefined, guards: [] },
    ];
    const { plan: guarded, added } = addReadGuards(plan(readThenEdit));
    expect(added).toEqual([{ stepId: "save", control: "support.edit.status" }]);
    const save = guarded.phases[0]!.steps.find((x) => x.id === "save") as Extract<DslStep, { op: "submit" }>;
    expect(save.guards).toEqual([{ control: "support.edit.status", equals: "$out.read_form.status" }]);
    // Lowering applies it: the guard checks the form before the select changes it.
    const { program, issues } = lower(plan(readThenEdit));
    expect(issues.some((i) => i.code === "auto-guard")).toBe(true);
    expect(program.nodes[0]!.body!.find((n) => n.id === "set_status")!.preconditions[0]).toMatchObject({ kind: "fieldEquals", expected: { expr: "$out.read_form.status" } });
    // A read under a different condition doesn't guard the edit, and existing guards stay as they are.
    const conditional = readThenEdit.map((x) => (x.id === "read_form" ? { ...x, when: "$out.read_order.status == 'refunded'" } : x));
    expect(addReadGuards(plan(conditional as DslStep[])).added).toEqual([]);
  });

  it("drops guards that compare with a computed value, keeps reads, and auto-guards only from reads before the form changed", () => {
    // Seen live: guards: [{ control: <customer id input>, equals: "$out.decide3.targetCust" }], the
    // value the edit is about to write. Such a guard fails whenever a change is needed.
    const edit = (guards: { control: string; equals: string }[], extra: DslStep[] = []): DslStep[] => [
      steps[0]!,
      steps[1]!,
      { id: "pick", op: "compute", assign: [{ name: "target", expr: "if($out.read_order.status == 'refunded', 'resolved', 'open')" }, { name: "seen", expr: "$out.read_order.status" }] },
      { id: "open_edit", op: "goto", app: "Support", url: "/tickets/{$rec.orderId}/edit" },
      { id: "set_status", op: "select", control: "support.edit.status", value: "$out.pick.target" },
      ...extra,
      { ...(steps[7] as Extract<DslStep, { op: "submit" }>), when: undefined, guards },
    ];
    const computed = addReadGuards(plan(edit([{ control: "support.edit.status", equals: "$out.pick.target" }])));
    expect(computed.dropped).toEqual([{ stepId: "save", control: "support.edit.status", equals: "$out.pick.target" }]);
    expect((computed.plan.phases[0]!.steps.find((x) => x.id === "save") as Extract<DslStep, { op: "submit" }>).guards).toEqual([]);
    expect(lower(plan(edit([{ control: "support.edit.status", equals: "$out.pick.target" }]))).issues.some((i) => i.code === "computed-guard")).toBe(true);
    // A compute field that only copies a read, a direct read, and a literal precondition are kept.
    for (const equals of ["$out.pick.seen", "$out.read_order.status", "lower(trim($out.read_order.status))", "'open'"]) expect(addReadGuards(plan(edit([{ control: "support.edit.status", equals }]))).dropped).toEqual([]);
    // An extract after the form changed reads the new value, so it never becomes a guard.
    const late = addReadGuards(plan(edit([], [{ id: "confirm", op: "extract", fields: [{ name: "status", control: "support.edit.status", parse: "string" }] }])));
    expect(late.added).toEqual([]);
  });

  it("gates an edit's fills with its submit's condition, but never gotos or extracts", () => {
    const ungated = steps.map((st) => (st.id === "set_status" ? { ...st, when: undefined } : st)) as DslStep[];
    const out = inheritSubmitConditions(plan(ungated));
    const byId = new Map(out.phases[0]!.steps.map((x) => [x.id, x]));
    expect(byId.get("set_status")!.when).toBe("$out.decide.needs");
    expect(byId.get("read_order")!.when).toBeUndefined();
    // A fill that already has its own condition keeps it.
    const own = steps.map((st) => (st.id === "set_status" ? { ...st, when: "true" } : st)) as DslStep[];
    expect(inheritSubmitConditions(plan(own)).phases[0]!.steps.find((x) => x.id === "set_status")!.when).toBe("true");
    // Lowering applies it.
    const { program } = lower(plan(ungated));
    expect(program.nodes[0]!.body!.find((n) => n.id === "set_status")!.when).toBe("$out.decide.needs");
  });

  it("rejects controls that were never observed", () => {
    const bad = steps.map((s) => (s.id === "set_status" ? { ...s, control: "support.edit.priority" } : s));
    expect(lower(plan(bad as DslStep[])).issues.some((i) => i.code === "unknown-control")).toBe(true);
  });

  it("rejects writes disguised as clicks and requires approval for irreversible actions", () => {
    const click: DslStep = { id: "del", op: "click", control: "orders.detail.delete", purpose: "other" };
    const r = lower(plan([steps[0]!, click]));
    expect(r.issues.some((i) => i.code === "write-via-click")).toBe(true);
    const irr: DslStep = { ...(steps[7] as Extract<DslStep, { op: "submit" }>), id: "del2", control: "orders.detail.delete", when: undefined, writes: ["app:orders:order:{$rec.orderId}"], verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "s", control: "orders.detail.status", equals: "'x'" }] } };
    const r2 = lower(plan([steps[0]!, irr]));
    const node = r2.program.nodes[0]!.body!.find((n) => n.id === "del2")!;
    expect(node.effect).toBe("irreversible");
    expect(node.requiresApproval).toBe(true);
    expect(node.retryPolicy).toBe("never");
  });

  it("rejects missing verification, bad expressions, $rec outside foreach, and unbounded loops", () => {
    const noVerify = steps.map((s) => (s.op === "submit" ? { ...s, verify: { url: s.verify.url, fields: [] } } : s));
    expect(lower(plan(noVerify as DslStep[])).issues.some((i) => i.code === "missing-verification")).toBe(true);
    const badExpr = steps.map((s) => (s.id === "decide" ? { ...s, assign: [{ name: "x", expr: "require('fs')" }] } : s));
    expect(lower(plan(badExpr as DslStep[])).issues.some((i) => i.code === "bad-expression")).toBe(true);
    const once = lower({ ...plan(), phases: [{ id: "p", kind: "once", dependsOn: [], steps: [steps[0]!] }] });
    expect(once.issues.some((i) => i.code === "rec-outside-foreach")).toBe(true);
    const { program } = lower(plan());
    const unbounded = { ...program, nodes: program.nodes.map((n) => ({ ...n, maxIterations: undefined })) };
    expect(validateProgram(unbounded).some((i) => i.code === "unbounded-loop")).toBe(true);
  });

  it("detects dependency cycles", () => {
    const cyc = steps.map((s) => (s.id === "read_order" ? { ...s, after: ["decide"] } : s));
    const { program } = lower(plan(cyc as DslStep[]));
    expect(validateProgram(program).some((i) => i.code === "cycle")).toBe(true);
  });

  it("rejects unsafe retry policies and unverified writes in raw IR", () => {
    const { program } = lower(plan());
    const tampered = structuredClone(program);
    const save = tampered.nodes[0]!.body!.find((n) => n.id === "save")!;
    save.retryPolicy = "safe";
    delete save.verify;
    const issues = validateProgram(tampered);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(["unsafe-retry", "missing-verification"]));
    expect(hasErrors(issues)).toBe(true);
  });
});

describe("segment formation and concurrency extraction", () => {
  it("groups page chains into segments, keeps cross-app reads parallel, and ends segments at writes", () => {
    const { program } = lower(plan());
    const c = compileProgram(program);
    const segs = [...c.segments.values()];
    expect(segs.map((s) => [s.nodeIds, s.kind, s.dependsOn])).toEqual([
      [["open_order", "read_order"], "read", []],
      [["find_ticket", "read_tickets"], "scan", []],
      [["decide"], "compute", ["reconcile.s1", "reconcile.s2"]],
      [["open_edit", "set_status", "save"], "write", ["reconcile.s3"]],
    ]);
    expect(c.stats.maxParallelismPerRecord).toBeGreaterThan(1);
    expect(c.passes.map((p) => p.name)).toEqual([
      "dependency-analysis",
      "redundant-observation-elimination",
      "locator-reuse",
      "common-subexpression-reuse",
      "navigation-grouping",
      "concurrency-extraction",
      "resource-aware-scheduling",
      "verification-placement",
    ]);
  });

  it("never puts two writes in one segment", () => {
    const second: DslStep = { ...(steps[7] as Extract<DslStep, { op: "submit" }>), id: "save2" };
    const more = [...steps, { id: "reopen", op: "goto", app: "Support", url: "/tickets/{$out.decide.ticket.ticketId}/edit" } as DslStep, { ...(steps[6] as DslStep), id: "set2" } as DslStep, second];
    const c = compileProgram(lower(plan(more)).program);
    for (const s of c.segments.values()) expect(s.nodes.filter((n) => n.effect === "remote-write").length).toBeLessThanOrEqual(1);
  });

  it("flags per-run constant locks that serialize every record", () => {
    const constLock = steps.map((s) => (s.op === "submit" ? { ...s, writes: ["app:support:global-settings"] } : s));
    const c = compileProgram(lower(plan(constLock as DslStep[])).program);
    expect(c.stats.contendedLocks).toContain("app:support:global-settings");
  });
});

/**
 * Behavior-preservation harness for optimizer passes: a symbolic executor over a fake browser
 * where every extraction returns a value determined by (current url, field), and every write is
 * recorded with its inputs. A pass preserves behavior iff the recorded writes are identical.
 */
function simulate(nodes: ActionNode[], rec: Record<string, unknown>): string[] {
  const out: Record<string, unknown> = {};
  const url: Record<string, string> = {};
  const writes: string[] = [];
  const pending: Record<string, string[]> = {};
  const scope = (): Scope => ({ rec, out, input: {}, phase: {} });
  for (const n of topoSort(nodes.map((x) => ({ ...x, deps: x.dependsOn })))) {
    if (n.when && !evaluate(n.when, scope())) continue;
    const s = scope();
    switch (n.type) {
      case "navigate":
        url[n.app!] = n.url && "template" in n.url ? renderTemplate(n.url.template, s) : String((n.url as { value: unknown }).value);
        pending[n.app!] = [];
        break;
      case "extract":
        out[n.id] = Object.fromEntries((n.fields ?? []).map((f) => [f.name, `${url[n.app!]}#${f.target.controlId}`]));
        break;
      case "compute":
        out[n.id] = Object.fromEntries(Object.entries(n.assign ?? {}).map(([k, e]) => [k, evaluate(e, s)]));
        break;
      case "fill":
      case "select":
        pending[n.app!]!.push(`${n.target?.controlId}=${JSON.stringify(n.input && "expr" in n.input ? evaluate(n.input.expr, s) : null)}`);
        break;
      case "click":
        if (n.effect === "remote-write") writes.push(`${url[n.app!]}:${pending[n.app!]!.join(",")}`);
        break;
    }
  }
  return writes;
}

describe("optimizer passes preserve behavior", () => {
  const body = () => lower(plan()).program.nodes[0]!.body!;

  it("redundant observation elimination removes duplicate page loads and reads without changing writes", () => {
    const dup: ActionNode[] = structuredClone(body());
    const reopen = { ...structuredClone(dup.find((n) => n.id === "open_order")!), id: "open_order_again", dependsOn: ["read_order"] };
    const reread = { ...structuredClone(dup.find((n) => n.id === "read_order")!), id: "read_order_again", dependsOn: ["open_order_again"] };
    dup.splice(2, 0, reopen, reread);
    const decide = dup.find((n) => n.id === "decide")!;
    decide.assign!.needs = decide.assign!.needs!.replace("$out.read_order.status", "$out.read_order_again.status");
    decide.dependsOn.push("read_order_again");
    const r = redundantObservationElimination(dup);
    expect(r.report.changes).toBe(2);
    expect(r.nodes.find((n) => n.id === "open_order_again")).toBeUndefined();
    expect(r.nodes.find((n) => n.id === "read_order_again")!.type).toBe("compute");
    for (const rec of [{ orderId: "ORD-1" }, { orderId: "ORD-9" }]) expect(simulate(r.nodes, rec)).toEqual(simulate(dup, rec));
  });

  it("dependency analysis only adds ordering, and orders conflicting writes", () => {
    const nodes = structuredClone(body());
    const save = nodes.find((n) => n.id === "save")!;
    const extraWrite = { ...structuredClone(save), id: "save_b", dependsOn: ["open_edit"] };
    nodes.push(extraWrite);
    const r = dependencyAnalysis(nodes);
    expect(r.nodes.find((n) => n.id === "save_b")!.dependsOn).toContain("save");
    for (const n of nodes) expect(r.nodes.find((m) => m.id === n.id)!.dependsOn).toEqual(expect.arrayContaining(n.dependsOn));
  });

  it("CSE and verification placement keep writes identical", () => {
    const nodes = structuredClone(body());
    const twin = { ...structuredClone(nodes.find((n) => n.id === "decide")!), id: "decide_twin" };
    nodes.splice(5, 0, twin);
    const r = commonSubexpressionReuse(nodes);
    expect(r.report.changes).toBe(1);
    const v = verificationPlacement(r.nodes);
    expect(simulate(v.nodes, { orderId: "ORD-1" })).toEqual(simulate(nodes, { orderId: "ORD-1" }));
  });
});
