import { describe, expect, it } from "vitest";
import type { DslPlan, DslStep } from "@overclock/contracts";
import { compileProgram, lowerPlan } from "@overclock/compiler";
import { AimdController, LockManager, Scheduler, type TaskInstance } from "@overclock/scheduler";
import { apps, ordersModel, supportModel } from "../fixtures/appmodel";

const perRecord: DslStep[] = [
  { id: "open_order", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
  { id: "read_order", op: "extract", fields: [{ name: "status", control: "orders.detail.status", parse: "string" }, { name: "cust", control: "orders.detail.customer_id", parse: "string" }] },
  { id: "find_ticket", op: "goto", app: "Support", url: "/tickets?q={$rec.orderId}" },
  { id: "read_tickets", op: "extractTable", table: "support.list.table", columns: [{ name: "ticketId", header: "Ticket" }], key: "ticketId" },
  { id: "decide", op: "compute", assign: [{ name: "go", expr: "true" }] },
  { id: "open_edit", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}/edit" },
  { id: "set", op: "fill", control: "orders.edit.customer_id", value: "$out.read_order.cust" },
  {
    id: "save",
    op: "submit",
    control: "orders.edit.submit",
    writes: ["app:crm:customer:{$out.read_order.cust}"],
    guards: [],
    verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "c", control: "orders.detail.customer_id", equals: "$out.read_order.cust" }] },
    irreversible: false,
  },
];

function compiled(extraPhases: DslPlan["phases"] = []) {
  const plan: DslPlan = {
    strategy: { name: "t", summary: "t", rationale: "t" },
    phases: [{ id: "per_record", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: perRecord }, ...extraPhases],
    outcomes: [{ id: "o", description: "o" }],
    assumptions: [],
    risks: [],
  };
  const records = [{ orderId: "A" }, { orderId: "B" }, { orderId: "C" }, { orderId: "B" }];
  const { program, issues } = lowerPlan({ plan, models: [ordersModel, supportModel], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s" });
  expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  return { c: compileProgram(program), inputs: { records } };
}

function harness(extraPhases: DslPlan["phases"] = [], opts: { criticalPath?: boolean } = {}) {
  const { c, inputs } = compiled(extraPhases);
  let clock = 0;
  const log: string[] = [];
  const s = new Scheduler(c, inputs, { now: () => clock, onLockConflict: (t, k) => log.push(`conflict ${t.taskId} ${k}`), onPhaseError: (p, e) => log.push(`phase-error ${p} ${e}`) }, { criticalPathPriority: opts.criticalPath ?? true, leaseMs: () => 10_000 });
  s.start();
  /** Fake execution: reads produce outputs, writes "verify". */
  const run = (t: TaskInstance, cust: (key: string) => string) => {
    for (const n of t.segment.nodes) {
      if (n.id === "read_order") t.record.scope.out[n.id] = { status: "refunded", cust: cust(t.recordKey) };
      if (n.id === "read_tickets") t.record.scope.out[n.id] = { rows: [{ ticketId: `T-${t.recordKey}` }] };
      if (n.id === "decide") t.record.scope.out[n.id] = { go: true };
    }
    s.complete(t.taskId, t.segment.kind === "write" ? "VERIFIED" : "COMPLETED", t.segment.nodeIds);
  };
  const drain = (cust: (key: string) => string, maxSteps = 500) => {
    const order: string[] = [];
    for (let i = 0; i < maxSteps && !s.isDone(); i++) {
      const inline = s.takeInline();
      if (inline) {
        run(inline, cust);
        continue;
      }
      const t = s.lease("w1", () => true);
      if (!t) {
        clock += 1000;
        continue;
      }
      order.push(t.taskId);
      run(t, cust);
    }
    return order;
  };
  return { s, c, log, drain, run, tick: (ms: number) => (clock += ms) };
}

describe("scheduler", () => {
  it("expands records with stable ids, drops duplicate records, and runs to completion", () => {
    const h = harness();
    expect(h.s.duplicatesDropped).toEqual(["per_record:B"]);
    expect([...h.s.tasks.keys()].filter((k) => k.endsWith("@A"))).toHaveLength(h.c.segments.size);
    h.drain(() => "C-1");
    expect(h.s.isDone()).toBe(true);
    expect([...h.s.tasks.values()].every((t) => t.state === "VERIFIED" || t.state === "COMPLETED")).toBe(true);
  });

  it("only releases a task when all of its dependencies finished", () => {
    const h = harness();
    const write = [...h.c.segments.values()].find((s) => s.kind === "write")!;
    const first = h.s.lease("w1", () => true)!;
    expect(first.segmentId).not.toBe(write.id);
    expect(h.s.tasks.get(`${write.id}@A`)!.state).toBe("PENDING");
  });

  it("serializes writes that lock the same resource across records", () => {
    const h = harness();
    // Every record resolves to the same customer -> the write locks collide.
    const sharedCust = () => "C-SAME";
    // Run all reads and computes first.
    for (let i = 0; i < 50; i++) {
      const inl = h.s.takeInline();
      if (inl) {
        h.run(inl, sharedCust);
        continue;
      }
      const t = h.s.lease("w1", () => true);
      if (!t) break;
      if (t.segment.kind === "write") {
        // Hold the first write's lease open and try to lease another write.
        const other = h.s.lease("w2", () => true);
        expect(other?.segment.kind === "write").toBe(false);
        expect(h.log.some((l) => l.startsWith("conflict") && l.includes("app:crm:customer:C-SAME"))).toBe(true);
        h.run(t, sharedCust);
        if (other) h.run(other, sharedCust);
        break;
      }
      h.run(t, sharedCust);
    }
  });

  it("prioritizes the critical path (long chains before leaves)", () => {
    const h = harness();
    const first = h.s.lease("w1", () => true)!;
    const highest = Math.max(...[...h.c.priority.entries()].filter(([id]) => h.c.segments.get(id)!.app).map(([, v]) => v));
    expect(h.c.priority.get(first.segmentId)).toBe(highest);
  });

  it("skips dependents when an upstream task fails", () => {
    const h = harness();
    let t = h.s.lease("w1", () => true)!;
    while (t.segmentId !== "per_record.s1") t = h.s.lease("w1", () => true)!;
    h.s.fail(t.taskId, "FAILED", "boom");
    const write = [...h.c.segments.values()].find((s) => s.kind === "write")!;
    expect(h.s.tasks.get(`${write.id}@${t.recordKey}`)!.state).toBe("SKIPPED");
  });

  it("invalidates stale upstream reads but never re-executes verified writes", () => {
    const h = harness();
    h.drain(() => "C-1", 6);
    const write = [...h.c.segments.values()].find((s) => s.kind === "write")!;
    const rec = "A";
    // Bring record A to its write.
    for (let i = 0; i < 40; i++) {
      const inl = h.s.takeInline();
      if (inl) h.run(inl, () => "C-1");
      const t = h.s.lease("w1", (app) => true);
      if (!t) break;
      if (t.taskId === `${write.id}@${rec}`) {
        const reset = h.s.invalidate(t.taskId, "stale");
        expect(reset).toContain(t.taskId);
        expect(reset.some((id) => id.startsWith("per_record.s1@"))).toBe(true);
        expect(h.s.tasks.get(`per_record.s1@${rec}`)!.state).toBe("READY");
        expect(h.s.records.get(`per_record|${rec}`)!.scope.out.read_order).toBeUndefined();
        break;
      }
      h.run(t, () => "C-1");
    }
  });

  it("refuses to recompute reads that a committed write of the same record used", () => {
    // Two writes per record share read_order. Once the first write committed, recomputing
    // read_order for the second write would decide again from post-write state.
    const twoWrites: DslStep[] = [
      ...perRecord,
      { id: "open_tedit", op: "goto", app: "Support", url: "/tickets/T-{$rec.orderId}/edit", when: "$out.read_order.status == 'refunded'" },
      { id: "set_status", op: "select", control: "support.edit.status", value: "'resolved'", when: "$out.read_order.status == 'refunded'" },
      {
        id: "save2",
        op: "submit",
        control: "support.edit.submit",
        when: "$out.read_order.status == 'refunded'",
        writes: ["app:support:ticket:T-{$rec.orderId}"],
        guards: [],
        verify: { url: "/tickets/T-{$rec.orderId}", fields: [{ name: "status", control: "support.detail.status", equals: "'resolved'" }] },
        irreversible: false,
      },
    ];
    const plan: DslPlan = { strategy: { name: "t", summary: "t", rationale: "t" }, phases: [{ id: "per_record", kind: "foreach", over: "$input.records", key: "$rec.orderId", dependsOn: [], steps: twoWrites }], outcomes: [{ id: "o", description: "o" }], assumptions: [], risks: [] };
    const records = [{ orderId: "A" }];
    const { program, issues } = lowerPlan({ plan, models: [ordersModel, supportModel], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s" });
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    const c = compileProgram(program);
    const s = new Scheduler(c, { records }, { now: () => 0 }, { leaseMs: () => 10_000 });
    s.start();
    const writes = [...c.segments.values()].filter((x) => x.kind === "write");
    expect(writes).toHaveLength(2);
    const [first, second] = writes.map((w) => `${w.id}@A`);
    let checked = false;
    for (let i = 0; i < 40 && !checked; i++) {
      const t = s.takeInline() ?? s.lease("w1", () => true);
      if (!t) break;
      if (t.taskId === second) {
        expect(s.tasks.get(first!)!.state).toBe("VERIFIED");
        expect(s.committedDependents(t.taskId)).toEqual([first]);
        checked = true;
        break;
      }
      for (const n of t.segment.nodes) if (n.id === "read_order") t.record.scope.out[n.id] = { status: "refunded", cust: "C-1" };
      s.complete(t.taskId, t.segment.kind === "write" ? "VERIFIED" : "COMPLETED", t.segment.nodeIds);
    }
    expect(checked).toBe(true);
  });

  it("expands a dependent phase from aggregated outputs of the previous phase", () => {
    const holds: DslPlan["phases"][number] = {
      id: "holds",
      kind: "foreach",
      over: "pluck(filterBy(entries(countBy(pluck($phase.per_record, 'out.read_order'), 'cust')), 'value', '>=', 2), 'key')",
      key: "$rec.value",
      dependsOn: ["per_record"],
      steps: [{ id: "open_cust", op: "goto", app: "Orders", url: "/customers/{$rec.value}" }],
    };
    const h = harness([holds]);
    h.drain((k) => (k === "C" ? "C-2" : "C-1"));
    const holdTasks = [...h.s.tasks.values()].filter((t) => t.phaseId === "holds");
    expect(holdTasks.map((t) => t.recordKey)).toEqual(["C-1"]);
    expect(h.s.isDone()).toBe(true);
  });
});

describe("locks", () => {
  it("supports exact and prefix locks", () => {
    const l = new LockManager();
    expect(l.tryAcquire(["a:1"], "t1").ok).toBe(true);
    expect(l.tryAcquire(["a:1"], "t2").ok).toBe(false);
    expect(l.tryAcquire(["a:*"], "t3").ok).toBe(false);
    expect(l.tryAcquire(["a:2"], "t2").ok).toBe(true);
    l.release("t1");
    l.release("t2");
    expect(l.tryAcquire(["a:*"], "t3").ok).toBe(true);
  });
});

describe("AIMD concurrency controller", () => {
  it("grows while healthy and halves on throttling", () => {
    let t = 0;
    const c = new AimdController("Orders", { min: 1, max: 16, initial: 4, windowMs: 1000, errorThreshold: 0.2 }, () => t);
    for (let w = 0; w < 4; w++) {
      for (let i = 0; i < 10; i++) {
        t += 100;
        c.record({ ms: 200, ok: true });
      }
    }
    expect(c.limit).toBeGreaterThan(4);
    const before = c.limit;
    c.record({ ms: 0, ok: false, throttled: true });
    c.record({ ms: 0, ok: false, throttled: true });
    expect(c.limit).toBe(Math.floor(before / 2));
  });
});
