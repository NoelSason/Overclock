import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RunConfigSchema, type AppControl, type AppModel, type DslPlan, type DslStep, type RecordOutcome } from "@overclock/contracts";
import { BrowserManager } from "@overclock/browser-runtime";
import { compileProgram, lowerPlan } from "@overclock/compiler";
import { LatencyModel } from "@overclock/optimizer";
import { observe, toAppControls } from "@overclock/perception";
import { Tracer } from "@overclock/telemetry";
import { Executor } from "../../services/engine/src/executor";
import { decidePublication, stateChecker } from "../../services/engine/src/publication";
import { model } from "../fixtures/appmodel";
import { startMiniApp, type MiniApp } from "../fixtures/mini-app";

/**
 * Publication gate: a run may publish a capability (or count as a successful reuse) only when every
 * skipped write has evidence of a legitimate no-op. Real perception, compilation, and browser
 * execution on the generic mini-app; the plan adds an activity entry per item under a condition.
 */

let app: MiniApp;
let browser: BrowserManager;
let mini: AppModel;
let ids: { region: string; entry: string; add: string };
const ENTRY = "concat('Reconciled ', $rec.id)";
const RECORDS = ["I-1", "I-2", "I-3"].map((id) => ({ id }));

beforeAll(async () => {
  app = await startMiniApp();
  browser = new BrowserManager({ headless: true });
  const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
  const page = await ctx.newPage();
  await page.goto(app.origin + "/items/I-1/activity");
  const controls: AppControl[] = toAppControls("mini", await observe(page));
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
  };
  mini = model("mini", app.origin, controls);
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
});
beforeEach(() => app.activity.clear());

/** Add the entry when `when` holds; a condition that never holds is a rule the plan never applies. */
function steps(when: string): DslStep[] {
  return [
    { id: "open_activity", op: "goto", app: "mini", url: "/items/{$rec.id}/activity" },
    { id: "write_entry", op: "fill", control: ids.entry, value: ENTRY, when },
    { id: "add_entry", op: "submit", control: ids.add, when, writes: ["app:mini:item:{$rec.id}"], guards: [], verify: { url: "/items/{$rec.id}/activity", fields: [{ name: "entry", control: ids.region, equals: ENTRY }] }, irreversible: false },
  ];
}

async function runAndDecide(when: string): Promise<{ outcomes: RecordOutcome[]; decision: Awaited<ReturnType<typeof decidePublication>> }> {
  const apps = [{ name: "mini", origin: app.origin }];
  const plan: DslPlan = { strategy: { name: "t", summary: "t", rationale: "t" }, phases: [{ id: "log", kind: "foreach", over: "$input.records", key: "$rec.id", dependsOn: [], steps: steps(when) }], outcomes: [{ id: "o", description: "o" }], assumptions: [], risks: [] };
  const lowered = lowerPlan({ plan, models: [mini], apps, goal: "g", inputs: { records: RECORDS }, programId: "p", strategyId: "s" });
  expect(lowered.issues.filter((i) => i.severity === "error")).toEqual([]);
  const t0 = performance.now();
  const executor = new Executor({
    runId: "pub",
    config: RunConfigSchema.parse({ goal: "g", applications: apps, records: RECORDS, maxWorkers: 1 }),
    emit: () => undefined,
    now: () => performance.now() - t0,
    tracer: new Tracer(),
    browser,
    apps,
    compiled: compileProgram(lowered.program),
    latency: new LatencyModel(),
    signal: new AbortController().signal,
    workers: { initial: 1, max: 1, adaptive: false },
    thumbnails: false,
    onThumbnail: () => undefined,
  });
  await executor.start({ incremental: false });
  const outcomes = executor.outcomes();
  const states = stateChecker(browser, [app.origin], undefined);
  const decision = await decidePublication({ outcomes, executor, checkState: states.check }).finally(() => states.close());
  return { outcomes, decision };
}

describe("publication gate for skipped writes", () => {
  it("regression: a rule that never fires skips every record and cannot authorize publication", async () => {
    const writesBefore = app.activityCommits;
    const { outcomes, decision } = await runAndDecide("false");
    // The run itself reports success: every record SKIPPED, none FAILED, and the skips stay skips.
    expect(outcomes.map((o) => o.status)).toEqual(["SKIPPED", "SKIPPED", "SKIPPED"]);
    expect(app.activityCommits).toBe(writesBefore);
    expect(decision.allowed).toBe(false);
    expect(decision.skips.map((s) => s.evidence)).toEqual([null, null, null]);
    expect(decision.reasons.join(" ")).toMatch(/3 skipped write\(s\) without evidence of a legitimate no-op/);
    // The fresh state check is read-only: nothing was written while checking.
    expect(app.activityCommits).toBe(writesBefore);
    expect(app.activity.size).toBe(0);
  }, 60_000);

  it("publishes when the rule fires and verifies elsewhere in the run (legitimate skip)", async () => {
    const { outcomes, decision } = await runAndDecide("$rec.id != 'I-2'");
    expect(outcomes.map((o) => [o.recordKey, o.status])).toEqual([
      ["I-1", "VERIFIED"],
      ["I-2", "SKIPPED"],
      ["I-3", "VERIFIED"],
    ]);
    expect(decision.skips).toEqual([expect.objectContaining({ recordKey: "I-2", evidence: "rule-applied" })]);
    expect(decision.allowed).toBe(true);
  }, 60_000);

  it("publishes when every skip is a record already in the end state the write asserts", async () => {
    for (const { id } of RECORDS) app.activity.set(id, [`Reconciled ${id}`]);
    const { outcomes, decision } = await runAndDecide("false");
    expect(outcomes.every((o) => o.status === "SKIPPED")).toBe(true);
    expect(decision.skips.map((s) => s.evidence)).toEqual(["state-verified", "state-verified", "state-verified"]);
    expect(decision.allowed).toBe(true);
  }, 60_000);

  it("refuses when one record is unproven even if the others are in their end state", async () => {
    app.activity.set("I-1", ["Reconciled I-1"]);
    app.activity.set("I-3", ["Reconciled I-3"]);
    const { decision } = await runAndDecide("false");
    expect(decision.skips.map((s) => [s.recordKey, s.evidence])).toEqual([
      ["I-1", "state-verified"],
      ["I-2", null],
      ["I-3", "state-verified"],
    ]);
    expect(decision.allowed).toBe(false);
  }, 60_000);
});
