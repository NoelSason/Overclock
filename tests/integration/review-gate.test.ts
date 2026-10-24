import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RunConfigSchema, type AppModel, type DslPlan, type EventPayload } from "@overclock/contracts";
import { BrowserManager } from "@overclock/browser-runtime";
import { crawlApp } from "@overclock/discovery";
import { ClaudeProvider, ModelLedger, claudeConfigFromEnv } from "@overclock/models";
import { LatencyModel } from "@overclock/optimizer";
import { RecoveryEngine } from "@overclock/recovery";
import { ReviewRejectedError, runStagedSwarm, type SwarmDeps } from "@overclock/swarm";
import { Tracer } from "@overclock/telemetry";
import type { Executor } from "../../services/engine/src/executor";
import type { RunController } from "../../services/engine/src/run";
import { runStreamingPipeline } from "../../services/engine/src/streaming";
import { startMiniApp, type MiniApp } from "../fixtures/mini-app";

/**
 * The write gate of mode E (streaming), end to end: real discovery, incremental compilation, and
 * browser execution against the generic mini-app, with a fake Messages API scripting the planner,
 * the repair, and the critique. A write may run only after a critique of that exact plan passed.
 * An unavailable, truncated, invalid, or rejecting critique must leave the application untouched.
 */

type Kind = "planner" | "patch" | "critique";
type CritiqueReply = "truncated" | "invalid" | "error" | { coverage: { rule: string; stepIds: string[]; implemented: boolean }[]; risks: { severity: "high" | "medium" | "low"; stepId: string; issue: string; suggestion: string }[] };

let app: MiniApp;
let browser: BrowserManager;
let model: Server;
let ids: { entry: string; add: string; region: string };
const saved = { ...process.env };
const seen: Kind[] = [];
let script: { planner: string[]; patch: string[]; critique: CritiqueReply[]; /** Served once the scripted lists run out (candidates plan in parallel in mode D). */ repeat?: { planner: string; patch: string; critique: CritiqueReply } };

const RECORDS = ["I-1", "I-2", "I-3", "I-4", "I-5", "I-6"].map((id) => ({ id }));
const ENTRY = "concat('Reviewed ', $rec.id)";
const PASS: CritiqueReply = { coverage: [{ rule: "Add the entry to each item", stepIds: ["add_entry"], implemented: true }], risks: [] };
/** A valid patch that changes nothing: the step is replaced by itself. */
const noopPatch = () => JSON.stringify({ edits: [{ op: "replaceSteps", stepId: "write_entry", steps: [plan().phases[0]!.steps[1]] }] });
const MISSING_RULE: CritiqueReply = { coverage: [{ rule: "Add the entry to each item", stepIds: [], implemented: false }], risks: [] };

function plan(): DslPlan {
  return {
    strategy: { name: "per-record", summary: "add an entry per item", rationale: "one write per record" },
    phases: [
      {
        id: "log",
        kind: "foreach",
        over: "$input.records",
        key: "$rec.id",
        dependsOn: [],
        steps: [
          { id: "open_activity", op: "goto", app: "mini", url: "/items/{$rec.id}/activity" },
          { id: "write_entry", op: "fill", control: ids.entry, value: ENTRY },
          { id: "add_entry", op: "submit", control: ids.add, writes: ["app:mini:item:{$rec.id}"], guards: [], verify: { url: "/items/{$rec.id}/activity", fields: [{ name: "entry", control: ids.region, equals: ENTRY }] }, irreversible: false },
        ],
      },
    ],
    outcomes: [{ id: "o", description: "every item has the entry" }],
    assumptions: [],
    risks: [],
  };
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A streamed text reply, in small chunks so the plan stream watcher sees it arrive incrementally. */
function streamText(res: ServerResponse, text: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  sse(res, "message_start", { type: "message_start", message: { type: "message", id: "msg", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 120) sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 120) } });
  sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 100 } });
  sse(res, "message_stop", { type: "message_stop" });
  res.end();
}

function critiqueReply(res: ServerResponse, reply: CritiqueReply): void {
  if (reply === "error") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "internal error" } }));
    return;
  }
  const [text, stop] = reply === "truncated" ? ['{"coverage":[{"rule":"Add the', "max_tokens"] : reply === "invalid" ? ["The plan looks fine to me.", "end_turn"] : [JSON.stringify(reply), "end_turn"];
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "message", id: "msg", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 50 } }));
}

beforeAll(async () => {
  app = await startMiniApp();
  browser = new BrowserManager({ headless: true });
  const crawled: AppModel = (await crawlApp({ browser, app: { name: "mini", origin: app.origin }, maxPerPattern: 1, maxPages: 12 })).model;
  const find = (pred: (c: AppModel["controls"][string]) => boolean, what: string) => {
    const c = Object.values(crawled.controls).find(pred);
    if (!c) throw new Error(`the crawl did not find ${what}`);
    return c.id;
  };
  ids = {
    entry: find((c) => c.kind === "textarea", "the entry textarea"),
    add: find((c) => c.kind === "button" && c.name === "Add entry", "the Add entry button"),
    region: find((c) => c.kind === "fact" && c.role === "region" && c.name === "Activity", "the Activity region"),
  };
  model = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { system?: string };
      const system = String(body.system ?? "");
      const kind: Kind = system.startsWith("You are the Adversarial Verifier") ? "critique" : system.includes("# Repair format") ? "patch" : "planner";
      seen.push(kind);
      if (kind === "critique") return critiqueReply(res, script.critique.shift() ?? script.repeat?.critique ?? "error");
      const text = (kind === "planner" ? script.planner : script.patch).shift() ?? script.repeat?.[kind];
      if (text === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `no scripted ${kind} reply left` } }));
      }
      streamText(res, text);
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
}, 60_000);

afterAll(async () => {
  process.env = { ...saved };
  model?.closeAllConnections();
  await new Promise<void>((r) => model?.close(() => r()));
  await browser?.close();
  await app?.close();
});

beforeEach(() => {
  app.activity.clear();
  app.activityCommits = 0;
  seen.length = 0;
});

function swarmDeps(mode: "overclock" | "overclock-staged", events: EventPayload[]): SwarmDeps {
  const t0 = performance.now();
  const config = RunConfigSchema.parse({ goal: "Add the entry 'Reviewed <id>' to the activity log of each item.", applications: [{ name: "mini", origin: app.origin }], records: RECORDS, mode, maxWorkers: 2 });
  return {
    runId: "review-gate",
    config,
    emit: (e) => events.push(e),
    now: () => performance.now() - t0,
    browser,
    claude: new ClaudeProvider({ ...claudeConfigFromEnv(), plannerSpeed: "standard", helperSpeed: "standard" }, new ModelLedger(undefined)),
    jev: null,
    latency: new LatencyModel(),
    signal: new AbortController().signal,
    saveArtifact: () => undefined,
  };
}

async function runModeE(): Promise<{ events: EventPayload[]; error: unknown }> {
  const events: EventPayload[] = [];
  const emit = (e: EventPayload) => events.push(e);
  const deps = swarmDeps("overclock", events);
  // The pipeline uses only these members of its run controller; a full RunController needs an engine runtime.
  const run = { runId: "review-gate", tracer: new Tracer(), setStatus: () => undefined, publishProgram: () => undefined, storeThumb: () => undefined } as unknown as RunController;
  let error: unknown = null;
  await runStreamingPipeline({ run, swarmDeps: deps, executeState: undefined, recovery: new RecoveryEngine({ emit }), setExecutor: (_e: Executor) => undefined, setProgram: () => undefined }).catch((err: unknown) => (error = err));
  return { events, error };
}

const reviews = (events: EventPayload[]) => events.filter((e): e is Extract<EventPayload, { type: "review" }> => e.type === "review");
const writeReleases = (events: EventPayload[]) => events.filter((e) => e.type === "fragment" && e.effect === "write" && (e.state === "canary" || e.state === "released"));

describe("mode E review gate", () => {
  it("control: a passed critique releases the writes, and each item gets exactly one entry", async () => {
    script = { planner: [JSON.stringify(plan())], patch: [], critique: [PASS] };
    const { events, error } = await runModeE();
    expect(error).toBeNull();
    expect(reviews(events).map((r) => r.status)).toEqual(["passed"]);
    expect(app.activityCommits).toBe(RECORDS.length);
    for (const { id } of RECORDS) expect(app.activity.get(id)).toEqual([`Reviewed ${id}`]);
  }, 120_000);

  for (const [name, replies] of [
    ["truncated twice (out of output tokens)", ["truncated", "truncated"]],
    ["not valid JSON twice", ["invalid", "invalid"]],
    ["an API error on every attempt", ["error", "error", "error", "error", "error", "error"]],
  ] as const) {
    it(`fails closed when the critique is ${name}: no write runs`, async () => {
      script = { planner: [JSON.stringify(plan())], patch: [], critique: [...replies] };
      const { events, error } = await runModeE();
      expect(error).toBeInstanceOf(ReviewRejectedError);
      expect(reviews(events).map((r) => r.status)).toEqual(["unavailable", "rejected"]);
      expect(writeReleases(events)).toEqual([]);
      expect(app.activityCommits).toBe(0);
    }, 120_000);
  }

  it("re-critiques a repaired plan and rejects it when the finding remains: no write runs", async () => {
    script = { planner: [JSON.stringify(plan())], patch: [noopPatch()], critique: [MISSING_RULE, MISSING_RULE] };
    const { events, error } = await runModeE();
    expect(error).toBeInstanceOf(ReviewRejectedError);
    expect(seen).toEqual(["planner", "critique", "patch", "critique"]);
    expect(reviews(events).map((r) => r.status)).toEqual(["risks", "risks", "rejected"]);
    expect(writeReleases(events)).toEqual([]);
    expect(app.activityCommits).toBe(0);
  }, 120_000);

  it("runs a repaired plan only after its own critique passed", async () => {
    script = { planner: [JSON.stringify(plan())], patch: [noopPatch()], critique: [MISSING_RULE, PASS] };
    const { events, error } = await runModeE();
    expect(error).toBeNull();
    expect(seen).toEqual(["planner", "critique", "patch", "critique"]);
    expect(reviews(events).map((r) => r.status)).toEqual(["risks", "passed"]);
    expect(app.activityCommits).toBe(RECORDS.length);
  }, 120_000);

  it("critiques the plan after a streaming fallback (it used to run unreviewed) and fails closed when that critique is unavailable", async () => {
    // The first planner output is invalid, so the planner's own repair round runs; the streamed
    // fragments then may not match the final plan, which forces the staged fallback path.
    const broken = { ...plan(), phases: [{ ...plan().phases[0]!, kind: "sometimes" }] };
    script = { planner: [JSON.stringify(broken), JSON.stringify(plan())], patch: [noopPatch()], critique: ["truncated", "truncated"] };
    const { events, error } = await runModeE();
    expect(seen).toEqual(["planner", "planner", "patch", "critique", "critique"]);
    expect(events.some((e) => e.type === "log" && e.message.startsWith("streaming fallback:"))).toBe(true);
    expect(error).toBeInstanceOf(ReviewRejectedError);
    expect(app.activityCommits).toBe(0);
  }, 120_000);

  it("after a streaming fallback, runs the repaired plan once its critique passed", async () => {
    const broken = { ...plan(), phases: [{ ...plan().phases[0]!, kind: "sometimes" }] };
    script = { planner: [JSON.stringify(broken), JSON.stringify(plan())], patch: [noopPatch()], critique: [PASS] };
    const { events, error } = await runModeE();
    expect(error).toBeNull();
    expect(seen).toEqual(["planner", "planner", "patch", "critique"]);
    expect(reviews(events).map((r) => [r.subject, r.status])).toEqual([["repaired plan", "passed"]]);
    expect(app.activityCommits).toBe(RECORDS.length);
  }, 120_000);
});

describe("mode D review gate", () => {
  // Mode D selects a candidate before anything executes; a candidate whose review fails is invalid,
  // so with every candidate rejected there is no program to run.
  const stage = async () => {
    const events: EventPayload[] = [];
    let error: unknown = null;
    const r = await runStagedSwarm(swarmDeps("overclock-staged", events)).catch((err: unknown) => ((error = err), null));
    return { events, error, selected: r?.selected ?? null, review: r?.review ?? null };
  };

  it("control: selects a candidate whose critique passed", async () => {
    script = { planner: [], patch: [], critique: [], repeat: { planner: JSON.stringify(plan()), patch: noopPatch(), critique: PASS } };
    const { selected, review, error } = await stage();
    expect(error).toBeNull();
    expect(selected).not.toBeNull();
    expect(review).toMatchObject({ status: "passed", rounds: 1 });
  }, 120_000);

  it("rejects every candidate when the critique is unavailable", async () => {
    script = { planner: [], patch: [], critique: [], repeat: { planner: JSON.stringify(plan()), patch: noopPatch(), critique: "truncated" } };
    const { error, selected, events } = await stage();
    expect(selected).toBeNull();
    expect(String(error)).toMatch(/critique unavailable/);
    expect(reviews(events).every((r) => r.status === "unavailable" || r.status === "rejected")).toBe(true);
  }, 120_000);

  it("re-critiques a repaired candidate and rejects it when the finding remains (it used to be kept unreviewed)", async () => {
    script = { planner: [], patch: [], critique: [], repeat: { planner: JSON.stringify(plan()), patch: noopPatch(), critique: MISSING_RULE } };
    const { error, selected, events } = await stage();
    expect(selected).toBeNull();
    expect(String(error)).toMatch(/blocking finding/);
    const candidates = new Set(reviews(events).map((r) => r.subject));
    for (const c of candidates) expect(reviews(events).filter((r) => r.subject === c).map((r) => r.status)).toEqual(["risks", "risks", "rejected"]);
  }, 120_000);
});
