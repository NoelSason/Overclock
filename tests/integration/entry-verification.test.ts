import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RunConfigSchema, type AppControl, type AppModel, type DslPlan, type DslStep, type EventPayload, type RecordOutcome, type VerificationSpec } from "@overclock/contracts";
import { BrowserManager, readBack, type ActionEnv } from "@overclock/browser-runtime";
import { compileProgram, hasErrors, lowerPlan } from "@overclock/compiler";
import { LatencyModel } from "@overclock/optimizer";
import { observe, toAppControls } from "@overclock/perception";
import { Tracer } from "@overclock/telemetry";
import { Executor } from "../../services/engine/src/executor";
import { model } from "../fixtures/appmodel";
import { startMiniApp, type MiniApp } from "../fixtures/mini-app";

/**
 * Verification of appended entries (notes, comments, log lines). A write that adds an entry is
 * VERIFIED only when a fresh read of the targeted entity shows exactly one entry equal to the
 * intended text. Everything here runs on the generic mini-app with real perception, lowering,
 * compilation, and execution; nothing is specific to any arena application.
 */

let app: MiniApp;
let browser: BrowserManager;
let mini: AppModel;
/** The same mini-app bound under a second name, as a separate application to read from. */
let reader: AppModel;
let ids: { region: string; entry: string; add: string; status: string; save: string; edit: string };

beforeAll(async () => {
  app = await startMiniApp();
  browser = new BrowserManager({ headless: true });
  // Observe the pages the way a scout would, and build the app model from what perception sees.
  const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
  const page = await ctx.newPage();
  const controls: AppControl[] = [];
  for (const path of ["/items/I-1/activity", "/items/I-1/edit", "/items/I-1"]) {
    await page.goto(app.origin + path);
    controls.push(...toAppControls("mini", await observe(page)));
  }
  await page.goto(app.origin + "/items/I-1");
  reader = model("reader", app.origin, toAppControls("reader", await observe(page)));
  await ctx.close();
  const find = (pred: (c: AppControl) => boolean, what: string) => {
    const c = controls.find(pred);
    if (!c) throw new Error(`perception did not find ${what}`);
    return c.id;
  };
  ids = {
    region: find((c) => c.kind === "fact" && c.role === "region" && c.name === "Activity", "the Activity region"),
    entry: find((c) => c.kind === "textarea", "the entry textarea"),
    add: find((c) => c.kind === "button" && c.name === "Add entry", "the Add entry button"),
    status: find((c) => c.kind === "select", "the status select"),
    save: find((c) => c.kind === "button" && c.name === "Save", "the Save button"),
    edit: find((c) => c.kind === "fact" && c.name === "Status", "the Status fact"),
  };
  mini = model("mini", app.origin, controls);
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
});
beforeEach(() => {
  app.activity.clear();
  app.decoy = null;
  app.draft = null;
  app.failActivity = "none";
  app.activityCommits = 0;
});

const ENTRY = "concat('Reconciled ', $rec.id)";

function addEntrySteps(extra: Partial<Extract<DslStep, { op: "submit" }>> = {}): DslStep[] {
  return [
    { id: "open_activity", op: "goto", app: "mini", url: "/items/{$rec.id}/activity" },
    { id: "write_entry", op: "fill", control: ids.entry, value: ENTRY },
    {
      id: "add_entry",
      op: "submit",
      control: ids.add,
      writes: ["app:mini:item:{$rec.id}"],
      guards: [],
      verify: { url: "/items/{$rec.id}/activity", fields: [{ name: "entry", control: ids.region, equals: ENTRY }] },
      irreversible: false,
      ...extra,
    },
  ];
}

function plan(steps: DslStep[]): DslPlan {
  return { strategy: { name: "t", summary: "t", rationale: "t" }, phases: [{ id: "log", kind: "foreach", over: "$input.records", key: "$rec.id", dependsOn: [], steps }], outcomes: [{ id: "o", description: "o" }], assumptions: [], risks: [] };
}

async function execute(steps: DslStep[], records: Record<string, unknown>[]): Promise<{ outcomes: RecordOutcome[]; events: EventPayload[]; executor: Executor }> {
  const apps = [
    { name: "mini", origin: app.origin },
    { name: "reader", origin: app.origin },
  ];
  const lowered = lowerPlan({ plan: plan(steps), models: [mini, reader], apps, goal: "g", inputs: { records }, programId: "p", strategyId: "s" });
  expect(lowered.issues.filter((i) => i.severity === "error")).toEqual([]);
  expect(hasErrors(lowered.issues)).toBe(false);
  const compiled = compileProgram(lowered.program);
  const events: EventPayload[] = [];
  const t0 = performance.now();
  const executor = new Executor({
    runId: "test",
    config: RunConfigSchema.parse({ goal: "g", applications: apps, records, maxWorkers: 1 }),
    emit: (e) => events.push(e),
    now: () => performance.now() - t0,
    tracer: new Tracer(),
    browser,
    apps,
    compiled,
    latency: new LatencyModel(),
    signal: new AbortController().signal,
    workers: { initial: 1, max: 1, adaptive: false },
    thumbnails: false,
    onThumbnail: () => undefined,
  });
  await executor.start({ incremental: false });
  return { outcomes: executor.outcomes(), events, executor };
}

const receiptsOf = (events: EventPayload[]) => events.filter((e): e is Extract<EventPayload, { type: "receipt" }> => e.type === "receipt");

describe("read-back of a collection region", () => {
  async function check(id: string, opts: { entityUrl?: string } = {}) {
    const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
    const page = await ctx.newPage();
    const env: ActionEnv = { page, origin: app.origin, allowedOrigins: new Set([app.origin]), scope: { key: id, rec: { id }, input: {}, out: {}, phase: {} }, locatorOverrides: new Map(), defaultTimeoutMs: 5000 };
    const spec: VerificationSpec = { url: { template: "/items/{$rec.id}/activity" }, fields: [{ name: "entry", target: mini.controls[ids.region]!.locator, equals: { expr: ENTRY }, attr: "text", match: "entry" }] };
    const rb = await readBack(env, spec, { timeoutMs: 5000, entityUrl: opts.entityUrl });
    await ctx.close();
    return rb;
  }

  it("fails on an empty log (its empty-state text is not an entry match)", async () => {
    const rb = await check("I-1");
    expect(rb.ok).toBe(false);
    expect(rb.fields[0]).toMatchObject({ matches: 0 });
    expect(rb.duplicate).toBe(false);
  });

  it("passes with exactly one matching entry among unrelated ones", async () => {
    app.activity.set("I-1", ["Called the customer", "Reconciled I-1", "Reconciled I-1 (draft copy)"]);
    const rb = await check("I-1");
    expect(rb.ok).toBe(true);
    expect(rb.fields[0]).toMatchObject({ matches: 1, actual: "Reconciled I-1" });
  });

  it("reports duplicates instead of passing", async () => {
    app.activity.set("I-1", ["Reconciled I-1", "Reconciled I-1"]);
    const rb = await check("I-1");
    expect(rb.ok).toBe(false);
    expect(rb.duplicate).toBe(true);
    expect(rb.fields[0]).toMatchObject({ matches: 2 });
  });

  it("ignores the text in an unrelated longer entry, a form field draft, and another region", async () => {
    app.activity.set("I-1", ["Reconciled I-1 (draft copy)", "Re: Reconciled I-1"]);
    app.draft = "Reconciled I-1";
    app.decoy = "Reconciled I-1";
    const rb = await check("I-1");
    expect(rb.ok).toBe(false);
    expect(rb.fields[0]).toMatchObject({ matches: 0 });
  });

  it("fails when the verification page shows a different entity than the write targeted", async () => {
    app.activity.set("I-1", ["Reconciled I-1"]);
    const rb = await check("I-1", { entityUrl: `${app.origin}/items/I-2/activity` });
    expect(rb.ok).toBe(false);
    expect(rb.entityMismatch).toContain("I-2");
  });
});

describe("executor: writes that append an entry", () => {
  it("lowers verification on a region to entry matching", () => {
    const lowered = lowerPlan({ plan: plan(addEntrySteps()), models: [mini], apps: [{ name: "mini", origin: app.origin }], goal: "g", inputs: { records: [{ id: "I-1" }] }, programId: "p", strategyId: "s" });
    const save = lowered.program.nodes[0]!.body!.find((n) => n.id === "add_entry")!;
    expect(save.verify!.fields[0]!.match).toBe("entry");
  });

  it("verifies one entry written once", async () => {
    const { outcomes, events } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]).toMatchObject({ recordKey: "I-1", status: "VERIFIED", writes: 1 });
    expect(app.activity.get("I-1")).toEqual(["Reconciled I-1"]);
    expect(receiptsOf(events).map((r) => r.status)).toEqual(["VERIFIED"]);
  });

  it("fails without retrying when the submission produced a duplicate", async () => {
    app.failActivity = "commit-twice";
    const { outcomes, events } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]!.status).toBe("FAILED");
    expect(app.activityCommits).toBe(2); // one POST, never repeated
    expect(receiptsOf(events).some((r) => r.status === "VERIFIED")).toBe(false);
  });

  it("retries a failed submission and verifies the single entry that landed", async () => {
    app.failActivity = "silent-reject";
    const { outcomes } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]).toMatchObject({ status: "VERIFIED", writes: 1 });
    expect(app.activity.get("I-1")).toEqual(["Reconciled I-1"]);
  });

  it("never verifies a submission that keeps failing, even with the text in the draft and elsewhere on the page", async () => {
    app.failActivity = "silent-reject-always";
    app.decoy = "Reconciled I-1";
    const { outcomes, events } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]!.status).toBe("FAILED");
    expect(app.activity.get("I-1") ?? []).toEqual([]);
    expect(receiptsOf(events).some((r) => r.status === "VERIFIED")).toBe(false);
  });

  it("reconciles an ambiguous submission that committed (500 after commit) without a second write", async () => {
    app.failActivity = "after-commit-500";
    const { outcomes } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]).toMatchObject({ status: "VERIFIED" });
    expect(app.activityCommits).toBe(1);
    expect(app.activity.get("I-1")).toEqual(["Reconciled I-1"]);
  });

  it("reconciles an ambiguous submission that did not commit (503) by writing once more", async () => {
    app.failActivity = "before-commit-503";
    const { outcomes } = await execute(addEntrySteps(), [{ id: "I-1" }]);
    expect(outcomes[0]).toMatchObject({ status: "VERIFIED" });
    expect(app.activityCommits).toBe(1);
  });

  it("regression: a record whose entry write never ran is not VERIFIED after an earlier write committed", async () => {
    // Seen live: the record's first write committed, the entry write then failed a guard, the
    // invalidation re-ran the record's reads against the post-write state, the decision now said
    // "no entry needed", the entry step was skipped, and the record was reported VERIFIED.
    app.items.get("I-2")!.status = "open";
    const steps: DslStep[] = [
      // Reads come from another application, so they form their own segment (as in the live run).
      { id: "open_item", op: "goto", app: "reader", url: "/items/{$rec.id}" },
      { id: "read_item", op: "extract", fields: [{ name: "status", control: Object.values(reader.controls).find((c) => c.kind === "fact" && c.name === "Status")!.id, parse: "string" }] },
      { id: "decide", op: "compute", assign: [{ name: "needsWork", expr: "$out.read_item.status == 'open'" }] },
      { id: "open_edit", op: "goto", app: "mini", url: "/items/{$rec.id}/edit", when: "$out.decide.needsWork" },
      { id: "close_item", op: "select", control: ids.status, value: "'closed'", when: "$out.decide.needsWork" },
      {
        id: "save_item",
        op: "submit",
        control: ids.save,
        when: "$out.decide.needsWork",
        writes: ["app:mini:item:{$rec.id}"],
        guards: [],
        verify: { url: "/items/{$rec.id}", fields: [{ name: "status", control: ids.edit, equals: "'closed'" }] },
        irreversible: false,
      },
      // The entry write runs after the item write (as in the live run); its guard fails.
      ...addEntrySteps({ when: "$out.decide.needsWork", writes: ["app:mini:item-log:{$rec.id}"], guards: [{ control: ids.entry, equals: "'a draft that is not there'" }] }).map((s) =>
        s.op === "submit" ? s : { ...s, when: "$out.decide.needsWork", ...(s.op === "goto" ? { after: ["save_item"] } : {}) },
      ),
    ];
    const { outcomes } = await execute(steps, [{ id: "I-2" }]);
    expect(app.items.get("I-2")!.status).toBe("closed");
    expect(app.activity.get("I-2") ?? []).toEqual([]);
    expect(outcomes[0]!.status).toBe("FAILED");
    expect(outcomes[0]!.notes.join(" ")).toContain("already committed");
  });
});
