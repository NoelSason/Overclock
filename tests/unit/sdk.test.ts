import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RunConfigSchema,
  VariationConfig,
  applyEvent,
  createRunView,
  type CheckResult,
  type EngineHealth,
  type EventPayload,
  type PublicScenario,
  type RecordOutcome,
  type RunConfig,
  type RunEvent,
  type RunResultResponse,
  type RunStatus,
  type RunSummary,
} from "@overclock/contracts";
import { Arena, Overclock, OverclockError, SseParser, configFromScenario, readSseMessages, type SseMessage } from "@overclock/sdk";
import { main } from "../../apps/cli/src/main";
import { parseCsvRecords } from "../../apps/cli/src/records";

// ---------------------------------------------------------------------------------------------
// Mock servers

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: unknown;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      else res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function write(res: ServerResponse, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => res.write(data, (err) => (err ? reject(err) : resolve())));
}

/** Writes `text` as UTF-8, optionally in fixed-size byte slices (which split multi-byte characters). */
async function writeSse(res: ServerResponse, text: string, chunkSize?: number): Promise<void> {
  const buf = Buffer.from(text, "utf8");
  if (!chunkSize) return write(res, buf);
  for (let i = 0; i < buf.length; i += chunkSize) await write(res, buf.subarray(i, i + chunkSize));
}

function sseMessage(ev: RunEvent, pretty: boolean): string {
  const json = pretty ? JSON.stringify(ev, null, 2) : JSON.stringify(ev);
  return `id: ${ev.seq}\nevent: run-event\n${json
    .split("\n")
    .map((l) => `data: ${l}`)
    .join("\n")}\n\n`;
}

const SUMMARY_BASE: Omit<RunSummary, "runId"> = {
  mode: "overclock",
  status: "completed",
  wallMs: 4200,
  discoveryMs: 800,
  compileMs: 300,
  executionMs: 3100,
  records: 2,
  tasks: 2,
  verified: 2,
  failed: 0,
  unconfirmed: 0,
  skipped: 0,
  needsApproval: 0,
  recordsVerified: 2,
  recoveries: 1,
  modelCalls: 1,
  inputTokens: 1200,
  outputTokens: 300,
  modelCostUsd: 0.012,
  workerUtilization: 0.8,
  maxConcurrency: 2,
  strategy: "parallel per-record",
  firstActionMs: 1100,
  firstVerifiedMs: 1300,
  overlapMs: 700,
  recoveryMs: 250,
  stageMs: { discovery: 100, planning: 900, execution: 1100 },
};

function runEvents(runId: string, config: RunConfig): RunEvent[] {
  const payloads: EventPayload[] = [
    { type: "run.created", config },
    { type: "run.status", status: "discovering" },
    { type: "stage", stage: "discovery", phase: "start" },
    { type: "stage", stage: "discovery", phase: "end" },
    { type: "stage", stage: "planning", phase: "start" },
    { type: "run.status", status: "compiling" },
    { type: "run.status", status: "running" },
    { type: "stage", stage: "execution", phase: "start" },
    {
      type: "tasks.created",
      tasks: [
        { taskId: "t1", segmentId: "s1", phaseId: "p1", recordKey: "ORD-1" },
        { taskId: "t2", segmentId: "s1", phaseId: "p1", recordKey: "ORD-2" },
      ],
    },
    { type: "worker.state", workerId: "w1", state: "EXECUTING", taskId: "t1", app: "Orders" },
    { type: "model.call", provider: "anthropic", model: "claude-opus-5-5", purpose: "plan", ms: 900, inputTokens: 1200, outputTokens: 300, costUsd: 0.012, ok: true },
    { type: "action", taskId: "t1", nodeId: "n1", actionType: "click", ms: 120, ok: true, modelCalls: 0 },
    { type: "task.state", taskId: "t1", state: "VERIFIED", workerId: "w1" },
    { type: "receipt", taskId: "t1", recordKey: "ORD-1", status: "VERIFIED", nodeId: "n1", fields: [{ name: "status", expected: "shipped", actual: "shipped" }] },
    // Planning ends after execution started at t=700: 700ms of overlap.
    { type: "stage", stage: "planning", phase: "end" },
    { type: "log", level: "info", message: "naïve ✓ — multi-byte text" },
    { type: "task.state", taskId: "t2", state: "VERIFIED", workerId: "w1" },
    { type: "worker.state", workerId: "w1", state: "IDLE" },
    { type: "stage", stage: "execution", phase: "end" },
    { type: "run.status", status: "completed" },
    { type: "run.completed", summary: { ...SUMMARY_BASE, runId } },
  ];
  return payloads.map((p, i) => ({ ...p, runId, seq: i + 1, ts: 1_760_000_000_000 + i * 100, t: i * 100 }) as RunEvent);
}

interface StreamPlan {
  /** Write at most this many events on this connection. */
  limit?: number;
  /** Destroy the socket after this many events (simulates a network drop). */
  dropAfter?: number;
  /** Close cleanly without sending `end`. */
  closeWithoutEnd?: boolean;
  /** After the events, keep the connection open. */
  hold?: boolean;
  /** While holding, send `: ping` heartbeats (default true). */
  heartbeat?: boolean;
  /** Send `end` but leave the connection open. */
  endWithoutClose?: boolean;
  chunkSize?: number;
  pretty?: boolean;
}

interface StreamRequest {
  connection: number;
  after: string | null;
  lastEventId: string | undefined;
}

interface MockRun {
  runId: string;
  config: RunConfig;
  events: RunEvent[];
  status: RunStatus;
  outcomes: RecordOutcome[];
  streams: StreamRequest[];
}

const SEMANTICS = "VERIFIED only when every state-changing step was read back after a fresh navigation and matched.";

class MockEngine {
  server!: Server;
  url = "";
  requests: Recorded[] = [];
  runs = new Map<string, MockRun>();
  streamPlan: (connection: number) => StreamPlan = () => ({});
  outcomeStatuses: RecordOutcome["status"][] = ["VERIFIED", "VERIFIED"];
  hangHealth = false;
  /** Serve summaries without the cold-start fields, like an engine built before they existed. */
  legacySummary = false;
  private nextId = 1;
  private timers = new Set<ReturnType<typeof setInterval>>();

  async start(): Promise<void> {
    const { server, url } = await listen((req, res) => this.handle(req, res));
    this.server = server;
    this.url = url;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    await closeServer(this.server);
  }

  reset(): void {
    this.requests = [];
    this.runs.clear();
    this.streamPlan = () => ({});
    this.outcomeStatuses = ["VERIFIED", "VERIFIED"];
    this.hangHealth = false;
    this.legacySummary = false;
  }

  /** Creates a finished run directly (bypassing POST /api/runs). */
  seedRun(config: RunConfig = RunConfigSchema.parse({ goal: "Reconcile orders", applications: [{ name: "Orders", origin: "http://127.0.0.1:4102" }] })): MockRun {
    const runId = `run_${this.nextId++}`;
    const run: MockRun = { runId, config, events: runEvents(runId, config), status: "completed", outcomes: [], streams: [] };
    run.outcomes = this.outcomeStatuses.map((status, i) => ({ recordKey: `ORD-${i + 1}`, status, writes: 1, receipts: status === "VERIFIED" ? [`rc${i + 1}`] : [], notes: status === "VERIFIED" ? [] : ["save returned 500; read-back inconclusive"] }));
    this.runs.set(runId, run);
    return run;
  }

  created(): Recorded[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/api/runs");
  }

  private result(run: MockRun): RunResultResponse {
    const summary: Partial<RunSummary> = { ...SUMMARY_BASE, runId: run.runId };
    if (this.legacySummary) for (const k of ["firstActionMs", "firstVerifiedMs", "overlapMs", "recoveryMs", "stageMs"] as const) delete summary[k];
    return { runId: run.runId, status: run.status, summary: summary as RunSummary, outcomes: run.outcomes, verificationSemantics: SEMANTICS };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const body = await readBody(req);
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/api/health") {
      if (this.hangHealth) return; // never answers
      const health: EngineHealth = {
        ok: true,
        version: "0.1.0-test",
        capabilities: {
          anthropic: { available: true, plannerModel: "claude-opus-5-5", helperModel: "claude-haiku-5-5" },
          typesafe: { available: false, model: "jev-latest", visionModel: "jev-preview", reason: "TYPESAFE_API_KEY is not set" },
          browser: { available: true },
        },
      };
      return sendJson(res, 200, health);
    }
    if (method === "POST" && path === "/api/runs") {
      const parsed = RunConfigSchema.safeParse(body);
      if (!parsed.success) return sendJson(res, 400, { error: "Invalid run config" });
      const run = this.seedRun(parsed.data);
      return sendJson(res, 201, { runId: run.runId, status: "pending" });
    }
    if (method === "GET" && path === "/api/runs") {
      return sendJson(
        res,
        200,
        [...this.runs.values()].map((r) => ({ runId: r.runId, status: r.status, mode: r.config.mode, goal: r.config.goal, createdAt: 1_760_000_000_000, summary: { ...SUMMARY_BASE, runId: r.runId } })),
      );
    }
    if (path === "/api/runs/boom/result") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream exploded");
      return;
    }

    const m = /^\/api\/runs\/([^/]+)(?:\/(.+))?$/.exec(path);
    const run = m?.[1] ? this.runs.get(decodeURIComponent(m[1])) : undefined;
    if (!m || !run) return sendJson(res, 404, { error: "Run not found" });
    const sub = m[2];

    if (method === "GET" && sub === undefined) {
      const view = createRunView(run.runId);
      for (const e of run.events) applyEvent(view, e);
      return sendJson(res, 200, { runId: run.runId, status: run.status, view });
    }
    if (method === "GET" && sub === "events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const events = run.events.filter((e) => e.seq > after).slice(0, limit);
      return sendJson(res, 200, { runId: run.runId, events, nextSeq: events.at(-1)?.seq ?? after });
    }
    if (method === "GET" && sub === "stream") return this.stream(req, res, url, run);
    if (method === "POST" && (sub === "cancel" || sub === "pause" || sub === "resume")) {
      const status: RunStatus = sub === "cancel" ? "cancelled" : sub === "pause" ? "paused" : "running";
      return sendJson(res, 200, { ok: true, status });
    }
    if (method === "POST" && sub === "approvals") return sendJson(res, 200, { ok: true });
    if (method === "GET" && sub === "result") return sendJson(res, 200, this.result(run));
    if (method === "GET" && sub === "metrics") return sendJson(res, 200, { wallMs: 4200 });
    if (method === "GET" && sub === "trace") return sendJson(res, 200, { resourceSpans: [] });
    if (method === "GET" && sub === "program") return sendJson(res, 404, { error: "Program not compiled yet" });
    return sendJson(res, 404, { error: "Not found" });
  }

  private async stream(req: IncomingMessage, res: ServerResponse, url: URL, run: MockRun): Promise<void> {
    const connection = run.streams.length + 1;
    const lastEventId = typeof req.headers["last-event-id"] === "string" ? req.headers["last-event-id"] : undefined;
    run.streams.push({ connection, after: url.searchParams.get("after"), lastEventId });
    const after = Math.max(Number(url.searchParams.get("after") ?? 0), Number(lastEventId ?? 0));
    const plan = this.streamPlan(connection);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    await writeSse(res, ": ping\n\n");
    let sent = 0;
    for (const ev of run.events.filter((e) => e.seq > after)) {
      if (plan.limit !== undefined && sent >= plan.limit) break;
      if (plan.dropAfter !== undefined && sent >= plan.dropAfter) {
        res.socket?.destroy();
        return;
      }
      await writeSse(res, sseMessage(ev, plan.pretty ?? false), plan.chunkSize);
      sent++;
    }
    if (plan.dropAfter !== undefined && sent >= plan.dropAfter) {
      res.socket?.destroy();
      return;
    }
    if (plan.hold) {
      if (plan.heartbeat !== false) {
        const timer = setInterval(() => res.write(": ping\n\n"), 20);
        this.timers.add(timer);
        res.on("close", () => {
          clearInterval(timer);
          this.timers.delete(timer);
        });
      }
      return;
    }
    if (plan.closeWithoutEnd) {
      res.end();
      return;
    }
    await writeSse(res, "event: end\ndata: {}\n\n");
    if (!plan.endWithoutClose) res.end();
  }
}

const SCENARIO: PublicScenario = {
  scenarioId: "t1-order-reconcile-s4242-n2",
  seed: 4242,
  template: "t1-order-reconcile",
  title: "Order reconciliation",
  goal: "Reconcile every order against the CRM and fix mismatched statuses.",
  records: [{ orderId: "ORD-1" }, { orderId: "ORD-2" }],
  applications: [
    { name: "CRM", origin: "http://127.0.0.1:4101" },
    { name: "Orders", origin: "http://127.0.0.1:4102" },
  ],
  holdout: false,
};

const CHECK: CheckResult = {
  scenarioId: SCENARIO.scenarioId,
  totalRecords: 2,
  correctRecords: 1,
  accuracy: 0.5,
  mismatches: [{ recordKey: "ORD-2", entity: "order", field: "status", expected: "shipped", actual: "pending" }],
  duplicateWrites: 0,
  collateralWrites: 0,
  escalationExpected: 0,
  checkedAt: 1_760_000_000_000,
};

class MockArena {
  server!: Server;
  url = "";
  requests: Recorded[] = [];
  scenario: PublicScenario | null = SCENARIO;
  variations: VariationConfig = VariationConfig.parse({});

  async start(): Promise<void> {
    const { server, url } = await listen((req, res) => this.handle(req, res));
    this.server = server;
    this.url = url;
  }

  reset(): void {
    this.requests = [];
    this.scenario = SCENARIO;
    this.variations = VariationConfig.parse({});
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://mock");
    const body = await readBody(req);
    const method = req.method ?? "GET";
    this.requests.push({ method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
    const key = `${method} ${url.pathname}`;
    const noScenario = () => sendJson(res, 404, { error: "No scenario loaded" });
    switch (key) {
      case "GET /api/health":
        return sendJson(res, 200, { ok: true });
      case "GET /api/scenario":
        return this.scenario ? sendJson(res, 200, this.scenario) : noScenario();
      case "POST /api/scenario": {
        const b = body as { seed: number; template?: PublicScenario["template"]; records?: number };
        this.scenario = { ...SCENARIO, seed: b.seed, template: b.template ?? "t1-order-reconcile", scenarioId: `${b.template ?? "t1-order-reconcile"}-s${b.seed}-n${b.records ?? 100}` };
        return sendJson(res, 200, this.scenario);
      }
      case "POST /api/reset":
        return this.scenario ? sendJson(res, 200, this.scenario) : noScenario();
      case "GET /api/check":
        return sendJson(res, 200, CHECK);
      case "GET /api/variations":
        return sendJson(res, 200, this.variations);
      case "PUT /api/variations":
        this.variations = VariationConfig.parse(body ?? {});
        return sendJson(res, 200, this.variations);
      case "PATCH /api/variations":
        this.variations = VariationConfig.parse({ ...this.variations, ...(body as object) });
        return sendJson(res, 200, this.variations);
      case "POST /api/variations/reset":
        this.variations = VariationConfig.parse({});
        return sendJson(res, 200, this.variations);
      case "POST /api/judge/surprise": {
        const b = body as { kind: string; app?: string };
        if (b.kind !== "rename-save") return sendJson(res, 400, { error: "Unknown surprise kind" });
        this.variations = VariationConfig.parse({ ...this.variations, renameButtons: { [b.app ?? "CRM"]: { Save: "Commit" } } });
        return sendJson(res, 200, this.variations);
      }
      case "POST /api/judge/edit-unprocessed":
        return sendJson(res, 200, { recordKey: "ORD-2", entity: "order", id: "ORD-2", patch: { status: "on-hold" } });
      case "GET /api/stats":
        return sendJson(res, 200, { requests: 3 });
      default:
        return sendJson(res, 404, { error: "Not found" });
    }
  }
}

const engine = new MockEngine();
const arena = new MockArena();
let deadUrl = "";

beforeAll(async () => {
  await engine.start();
  await arena.start();
  const dead = await listen(async () => undefined);
  deadUrl = dead.url;
  await closeServer(dead.server);
});

afterAll(async () => {
  await engine.stop();
  await closeServer(arena.server);
});

beforeEach(() => {
  engine.reset();
  arena.reset();
});

const client = (opts: ConstructorParameters<typeof Overclock>[0] = {}) => new Overclock({ endpoint: engine.url, reconnectDelayMs: 5, ...opts });

const VALID_CONFIG = { goal: "Reconcile orders", applications: [{ name: "Orders", origin: "http://127.0.0.1:4102" }], records: [{ orderId: "ORD-1" }] };

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

// ---------------------------------------------------------------------------------------------
// SSE parsing

describe("SseParser", () => {
  const RAW =
    ": heartbeat\r\nid: 1\r\nevent: run-event\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\n" + // CRLF, multi-line data
    "retry: 50\ndata: x\n\n" + // LF, retry persists
    "\rdata: cr-only\r\r" + // bare CR line endings
    "data\n\n" + // field with no colon = empty value
    "event: no-data\n\n" + // no data: not dispatched
    ": c\nid: 2\ndata: tail"; // incomplete at EOF: never dispatched

  const EXPECTED: SseMessage[] = [
    { event: "run-event", data: '{"a":\n1}', id: "1", retry: undefined },
    { event: "message", data: "x", id: "1", retry: 50 },
    { event: "message", data: "cr-only", id: "1", retry: 50 },
    { event: "message", data: "", id: "1", retry: 50 },
  ];

  it("handles comments, multi-line data, id, retry, and every line ending", () => {
    expect(new SseParser().feed(RAW)).toEqual(EXPECTED);
  });

  it("gives the same messages wherever the chunks split, including inside CRLF", () => {
    for (let i = 0; i <= RAW.length; i++) {
      const p = new SseParser();
      expect([...p.feed(RAW.slice(0, i)), ...p.feed(RAW.slice(i))]).toEqual(EXPECTED);
    }
    const p = new SseParser();
    expect([...RAW].flatMap((c) => p.feed(c))).toEqual(EXPECTED);
  });

  it("decodes multi-byte UTF-8 split across byte chunks", async () => {
    const bytes = new TextEncoder().encode("event: run-event\ndata: naïve ✓ 🚀\n\nevent: end\ndata: {}\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const b of bytes) controller.enqueue(new Uint8Array([b]));
        controller.close();
      },
    });
    const msgs = await collect(readSseMessages(body));
    expect(msgs.map((m) => [m.event, m.data])).toEqual([
      ["run-event", "naïve ✓ 🚀"],
      ["end", "{}"],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Engine client

describe("Overclock request mapping", () => {
  it("maps every endpoint to the right method, path, and body", async () => {
    const oc = client();
    const health = await oc.health();
    expect(health.version).toBe("0.1.0-test");

    const created = await oc.start(VALID_CONFIG);
    expect(created.status).toBe("pending");
    const post = engine.created()[0];
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.body).toEqual(VALID_CONFIG);
    const { runId } = created;

    expect((await oc.list()).map((r) => r.runId)).toEqual([runId]);
    const status = await oc.status(runId);
    expect(status.view.receipts.VERIFIED).toBe(1);
    expect(status.view.summary?.recordsVerified).toBe(2);

    const page = await oc.events(runId, 3, 2);
    expect(page.events.map((e) => e.seq)).toEqual([4, 5]);
    expect(page.nextSeq).toBe(5);
    const evReq = engine.requests.at(-1);
    expect(evReq?.query.get("after")).toBe("3");
    expect(evReq?.query.get("limit")).toBe("2");
    await oc.events(runId);
    expect(engine.requests.at(-1)?.query.has("after")).toBe(false);

    expect(await oc.cancel(runId)).toEqual({ ok: true, status: "cancelled" });
    expect(await oc.pause(runId)).toEqual({ ok: true, status: "paused" });
    expect(await oc.resume(runId)).toEqual({ ok: true, status: "running" });
    expect(await oc.approve(runId, "ap1", false)).toEqual({ ok: true });
    expect(engine.requests.at(-1)?.body).toEqual({ approvalId: "ap1", approved: false });
    // Body-less POSTs still send `{}` so JSON servers accept them.
    expect(engine.requests.find((r) => r.path.endsWith("/cancel"))?.body).toEqual({});

    const result = await oc.result(runId);
    expect(result.outcomes).toHaveLength(2);
    expect(await oc.metrics(runId)).toEqual({ wallMs: 4200 });
    expect(await oc.trace(runId)).toEqual({ resourceSpans: [] });
  });

  it("uses OVERCLOCK_URL when no endpoint is given", () => {
    const prev = process.env.OVERCLOCK_URL;
    process.env.OVERCLOCK_URL = "http://example.test:9999/";
    try {
      expect(new Overclock().endpoint).toBe("http://example.test:9999");
    } finally {
      if (prev === undefined) delete process.env.OVERCLOCK_URL;
      else process.env.OVERCLOCK_URL = prev;
    }
  });
});

describe("Overclock errors", () => {
  it("maps a JSON error body to OverclockError with status and body", async () => {
    const err = await rejection(client().status("nope"));
    expect(err).toBeInstanceOf(OverclockError);
    const e = err as OverclockError;
    expect(e.status).toBe(404);
    expect(e.code).toBe("http");
    expect(e.body).toEqual({ error: "Run not found" });
    expect(e.message).toContain("Run not found");
  });

  it("keeps a non-JSON error body as text", async () => {
    const e = (await rejection(client().result("boom"))) as OverclockError;
    expect(e.status).toBe(500);
    expect(e.body).toBe("upstream exploded");
    expect(e.message).toContain("upstream exploded");
  });

  it("reports 404 from /program before compilation", async () => {
    const run = engine.seedRun();
    const e = (await rejection(client().program(run.runId))) as OverclockError;
    expect(e.status).toBe(404);
  });

  it("reports an unreachable engine as status 0 / network", async () => {
    const e = (await rejection(new Overclock({ endpoint: deadUrl }).health())) as OverclockError;
    expect(e).toBeInstanceOf(OverclockError);
    expect(e.status).toBe(0);
    expect(e.code).toBe("network");
    expect(e.message).toContain(deadUrl);
  });

  it("times out a request that never answers", async () => {
    engine.hangHealth = true;
    const e = (await rejection(client({ timeoutMs: 100 }).health())) as OverclockError;
    expect(e.code).toBe("timeout");
    expect(e.status).toBe(0);
  });
});

describe("client-side config validation", () => {
  it("rejects an invalid config with status 0 and zod issues, without sending it", async () => {
    const oc = client();
    const e = (await rejection(oc.start({ goal: "", applications: [{ name: "Orders", origin: "not a url" }], maxWorkers: 99 }))) as OverclockError;
    expect(e).toBeInstanceOf(OverclockError);
    expect(e.status).toBe(0);
    expect(e.code).toBe("validation");
    const paths = (e.body as { path: PropertyKey[] }[]).map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["goal", "applications.0.origin", "maxWorkers"]));
    const e2 = await rejection(oc.execute({ goal: "x", applications: [] }));
    expect((e2 as OverclockError).code).toBe("validation");
    expect(engine.created()).toHaveLength(0);
  });
});

describe("Overclock.stream", () => {
  it("parses heartbeats, multi-line data, and byte-split chunks, and ends on `end`", async () => {
    const run = engine.seedRun();
    engine.streamPlan = () => ({ pretty: true, chunkSize: 7 });
    const events = await collect(client().stream(run.runId));
    expect(events.map((e) => e.seq)).toEqual(run.events.map((e) => e.seq));
    expect(events).toEqual(run.events);
    expect(events.find((e) => e.type === "log")).toMatchObject({ message: "naïve ✓ — multi-byte text" });
    expect(run.streams).toHaveLength(1);
  });

  it("starts after the given seq", async () => {
    const run = engine.seedRun();
    const events = await collect(client().stream(run.runId, { after: 10 }));
    expect(events.map((e) => e.seq)).toEqual(run.events.slice(10).map((e) => e.seq));
    expect(events[0]?.seq).toBe(11);
    expect(run.streams[0]?.after).toBe("10");
  });

  it("stops on `end` even if the server keeps the connection open", async () => {
    const run = engine.seedRun();
    engine.streamPlan = () => ({ endWithoutClose: true });
    const events = await collect(client().stream(run.runId));
    expect(events).toHaveLength(run.events.length);
  });

  it("reconnects with Last-Event-ID after the server drops the connection", async () => {
    const run = engine.seedRun();
    engine.streamPlan = (n) => (n === 1 ? { dropAfter: 3 } : {});
    const events = await collect(client().stream(run.runId));
    expect(events.map((e) => e.seq)).toEqual(run.events.map((e) => e.seq)); // complete, no duplicates
    expect(run.streams).toHaveLength(2);
    expect(run.streams[0]?.lastEventId).toBeUndefined();
    expect(run.streams[1]).toMatchObject({ lastEventId: "3", after: "3" });
  });

  it("reconnects when the stream closes without `end`, and skips replayed events", async () => {
    const run = engine.seedRun();
    engine.streamPlan = (n) => (n <= 2 ? { limit: 4, closeWithoutEnd: true } : {});
    const events = await collect(client().stream(run.runId));
    expect(events.map((e) => e.seq)).toEqual(run.events.map((e) => e.seq));
    expect(run.streams.map((s) => s.lastEventId)).toEqual([undefined, "4", "8"]);
  });

  it("reconnects when the connection goes silent", async () => {
    const run = engine.seedRun();
    engine.streamPlan = (n) => (n === 1 ? { limit: 2, hold: true, heartbeat: false } : {});
    const events = await collect(client({ streamIdleTimeoutMs: 150 }).stream(run.runId));
    expect(events).toHaveLength(run.events.length);
    expect(run.streams[1]?.lastEventId).toBe("2");
  });

  it("gives up after maxReconnects consecutive failures", async () => {
    const run = engine.seedRun();
    engine.streamPlan = () => ({ limit: 0, closeWithoutEnd: true });
    const e = (await rejection(collect(client({ maxReconnects: 2 }).stream(run.runId)))) as OverclockError;
    expect(e).toBeInstanceOf(OverclockError);
    expect(e.code).toBe("network");
    expect(run.streams).toHaveLength(3);
  });

  it("does not retry a 404", async () => {
    const e = (await rejection(collect(client().stream("missing")))) as OverclockError;
    expect(e.status).toBe(404);
    expect(engine.requests.filter((r) => r.path.endsWith("/stream"))).toHaveLength(1);
  });

  it("closes the connection when the consumer stops early", async () => {
    const run = engine.seedRun();
    engine.streamPlan = () => ({ hold: true });
    const seen: number[] = [];
    for await (const ev of client().stream(run.runId)) {
      seen.push(ev.seq);
      if (ev.seq === 2) break;
    }
    expect(seen).toEqual([1, 2]);
  });
});

describe("Overclock.execute", () => {
  it("starts, follows the stream, and resolves with the result after run.completed", async () => {
    const seen: RunEvent[] = [];
    const result = await client().execute(VALID_CONFIG, { onEvent: (e) => seen.push(e) });
    expect(seen.map((e) => e.type)).toContain("run.completed");
    expect(seen.map((e) => e.seq)).toEqual(seen.map((_, i) => i + 1));
    expect(result.status).toBe("completed");
    expect(result.outcomes.map((o) => o.status)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(result.verificationSemantics).toBe(SEMANTICS);
    const paths = engine.requests.map((r) => `${r.method} ${r.path.replace(result.runId, ":id")}`);
    expect(paths).toEqual(["POST /api/runs", "GET /api/runs/:id/stream", "GET /api/runs/:id", "GET /api/runs/:id/result"]);
  });

  it("aborts via signal, cancels the run it started, and rejects with the abort reason", async () => {
    engine.streamPlan = () => ({ limit: 3, hold: true });
    const controller = new AbortController();
    const err = await rejection(
      client().execute(VALID_CONFIG, {
        signal: controller.signal,
        onEvent: (e) => {
          if (e.seq === 3) controller.abort();
        },
      }),
    );
    expect((err as Error).name).toBe("AbortError");
    const runId = [...engine.runs.keys()][0];
    expect(engine.requests.some((r) => r.method === "POST" && r.path === `/api/runs/${runId}/cancel`)).toBe(true);
    expect(engine.requests.some((r) => r.path.endsWith("/result"))).toBe(false);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const err = await rejection(client().execute(VALID_CONFIG, { signal: AbortSignal.abort() }));
    expect((err as Error).name).toBe("AbortError");
    expect(engine.created()).toHaveLength(0);
  });

  it("waitForCompletion returns the final status and leaves the run alone on abort", async () => {
    const run = engine.seedRun();
    const status = await client().waitForCompletion(run.runId);
    expect(status.status).toBe("completed");

    engine.streamPlan = () => ({ limit: 1, hold: true });
    const controller = new AbortController();
    const err = await rejection(client().waitForCompletion(run.runId, { signal: controller.signal, onEvent: () => controller.abort() }));
    expect((err as Error).name).toBe("AbortError");
    expect(engine.requests.some((r) => r.path.endsWith("/cancel"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Arena client

describe("Arena", () => {
  it("maps every admin endpoint", async () => {
    const a = new Arena({ endpoint: arena.url });
    expect(await a.health()).toEqual({ ok: true });
    expect((await a.scenario()).scenarioId).toBe(SCENARIO.scenarioId);
    const loaded = await a.loadScenario({ seed: 7, template: "t2-ticket-triage", records: 20 });
    expect(loaded.scenarioId).toBe("t2-ticket-triage-s7-n20");
    expect(arena.requests.at(-1)?.body).toEqual({ seed: 7, template: "t2-ticket-triage", records: 20 });
    expect((await a.reset()).seed).toBe(7);
    expect(arena.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/reset", body: {} });
    expect(await a.check()).toEqual(CHECK);
    expect((await a.variations()).theme).toBe("default");
    expect((await a.setVariations({ theme: "dense" })).theme).toBe("dense");
    expect(arena.requests.at(-1)?.method).toBe("PUT");
    expect((await a.patchVariations({ theme: "contrast" })).theme).toBe("contrast");
    expect(arena.requests.at(-1)?.method).toBe("PATCH");
    expect((await a.resetVariations()).theme).toBe("default");
    expect((await a.surprise("rename-save", "Orders")).renameButtons).toEqual({ Orders: { Save: "Commit" } });
    expect(arena.requests.at(-1)?.body).toEqual({ kind: "rename-save", app: "Orders" });
    await a.surprise("rename-save");
    expect(arena.requests.at(-1)?.body).toEqual({ kind: "rename-save" });
    expect(await a.editUnprocessed()).toMatchObject({ recordKey: "ORD-2" });
    expect(await a.stats()).toEqual({ requests: 3 });
  });

  it("surfaces arena errors as OverclockError", async () => {
    arena.scenario = null;
    const e = (await rejection(new Arena({ endpoint: arena.url }).scenario())) as OverclockError;
    expect(e.status).toBe(404);
    expect(e.message).toContain("No scenario loaded");
  });
});

describe("configFromScenario", () => {
  it("builds a valid run config, and overrides win", () => {
    const config = configFromScenario(SCENARIO);
    expect(config).toEqual({ goal: SCENARIO.goal, applications: SCENARIO.applications, records: SCENARIO.records, label: SCENARIO.title });
    expect(RunConfigSchema.safeParse(config).success).toBe(true);
    const tuned = configFromScenario(SCENARIO, { maxWorkers: 4, mode: "compiled-single", label: "bench" });
    expect(tuned).toMatchObject({ goal: SCENARIO.goal, maxWorkers: 4, mode: "compiled-single", label: "bench" });
  });
});

// ---------------------------------------------------------------------------------------------
// CLI

describe("CLI", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-sdk-cli-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function cli(argv: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      env: { OVERCLOCK_URL: engine.url, OVERCLOCK_ARENA_URL: arena.url, ...env },
      cwd: dir,
    });
    return { code, out: out.join(""), err: err.join("") };
  }

  const lastConfig = (): Record<string, unknown> => engine.created().at(-1)?.body as Record<string, unknown>;

  it("prints help and rejects bad usage with exit 2", async () => {
    const help = await cli(["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: pnpm cli <command>");
    expect((await cli(["help", "run"])).out).toContain("--intelligence");
    expect((await cli([])).code).toBe(2);
    expect((await cli(["bogus"])).code).toBe(2);
    expect((await cli(["status"])).err).toContain("Missing <runId>");
    expect((await cli(["status"])).code).toBe(2);
    expect((await cli(["run", "--scenario", "--workers", "abc"])).code).toBe(2);
    expect((await cli(["run", "--scenario", "--workers", "40"])).code).toBe(2);
    expect((await cli(["run", "--scenario", "--mode", "turbo"])).code).toBe(2);
    expect((await cli(["run", "--scenario", "--frobnicate"])).code).toBe(2);
    expect((await cli(["run", "--goal", "x"])).err).toContain("--app");
    expect(engine.created()).toHaveLength(0);
  });

  it("health shows engine capabilities and arena reachability", async () => {
    const r = await cli(["health"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("v0.1.0-test");
    expect(r.out).toContain("unavailable: TYPESAFE_API_KEY is not set");
    expect(r.out).toMatch(/Arena\s+http:\/\/127\.0\.0\.1:\d+\s+ok/);
  });

  it("explains an unreachable engine with exit 1", async () => {
    const r = await cli(["health"], { OVERCLOCK_URL: deadUrl });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot reach Overclock engine");
    expect(r.err).toContain("pnpm engine");
  });

  it("run --scenario streams progress, prints a summary, and exits 0 when everything verified", async () => {
    const r = await cli(["run", "--scenario", "--workers", "4", "--no-jev", "--intelligence", "single-planner", "--cache", "warm"]);
    expect(r.code).toBe(0);
    expect(lastConfig()).toMatchObject({ goal: SCENARIO.goal, applications: SCENARIO.applications, records: SCENARIO.records, maxWorkers: 4, useJev: false, intelligence: "single-planner", cache: "warm" });
    expect(r.err).toMatch(/Started run run_\d+/);
    expect(r.err).toMatch(/completed\s+\S+\s+verified 2\/2 tasks  first verified 1\.3s  overlap 700ms  workers 0\/1  model calls 1  \$0\.0120/);
    expect(r.out).toContain("Record outcomes (2)");
    expect(r.out).toMatch(/VERIFIED\s+2/);
    expect(r.out).toContain("1.2k in / 300 out tokens");
    expect(r.out).toMatch(/First verified\s+1\.3s \(first action 1\.1s\)/);
    expect(r.out).toMatch(/Overlap\s+700ms of planning alongside execution/);
    expect(r.out).toMatch(/Recoveries\s+1 \(250ms\)/);
    expect(r.out).toContain("Stages          discovery 100ms · planning 900ms · execution 1.1s");
  });

  it("run passes the staged mode and ablation switches", async () => {
    const r = await cli(["run", "--scenario", "--mode", "overclock-staged", "--no-streaming", "--no-access-paths", "--no-write-canary"]);
    expect(r.code).toBe(0);
    expect(lastConfig()).toMatchObject({ mode: "overclock-staged", ablation: { streaming: false, accessPaths: false, writeCanary: false } });
    expect((await cli(["run", "--scenario", "--no-write-canary"])).code).toBe(0);
    expect(lastConfig().ablation).toEqual({ writeCanary: false });
    expect((await cli(["run", "--scenario"])).code).toBe(0);
    expect(lastConfig().ablation).toBeUndefined();
  });

  it("help lists the staged mode and ablation switches", async () => {
    const r = await cli(["help", "run"]);
    expect(r.out).toContain("overclock-staged");
    expect(r.out).toContain("--no-write-canary");
  });

  it("shows '-' for cold-start metrics an older engine omits", async () => {
    engine.legacySummary = true;
    const run = engine.seedRun();
    const r = await cli(["result", run.runId]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/First verified\s+- \(first action -\)/);
    expect(r.out).toMatch(/Overlap\s+0ms/);
    expect(r.out).not.toContain("NaN");
    expect(r.out).not.toContain("Stages");
  });

  it("run --json prints only the result JSON on stdout", async () => {
    const r = await cli(["run", "--scenario", "--json", "--dry-run", "--mode", "sequential-agent"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as RunResultResponse;
    expect(parsed.outcomes).toHaveLength(2);
    expect(lastConfig()).toMatchObject({ dryRun: true, mode: "sequential-agent" });
  });

  it("run exits 1 when a record is UNCONFIRMED and lists it", async () => {
    engine.outcomeStatuses = ["VERIFIED", "UNCONFIRMED"];
    const r = await cli(["run", "--scenario"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Need attention (1)");
    expect(r.out).toMatch(/ORD-2\s+UNCONFIRMED\s+save returned 500/);
    expect(r.out).toContain("could not be read back");
  });

  it("run takes --goal, --app, and --records from CSV or JSON", async () => {
    writeFileSync(join(dir, "records.csv"), 'orderId,note\r\nORD-9,"late, then ""lost"""\r\nORD-10,\r\n');
    const r = await cli(["run", "--goal", "Fix orders", "--app", "Orders=http://127.0.0.1:4102", "--app", "CRM=http://127.0.0.1:4101", "--records", "records.csv", "--concurrency", "fixed"]);
    expect(r.code).toBe(0);
    expect(lastConfig()).toMatchObject({
      goal: "Fix orders",
      applications: [
        { name: "Orders", origin: "http://127.0.0.1:4102" },
        { name: "CRM", origin: "http://127.0.0.1:4101" },
      ],
      records: [
        { orderId: "ORD-9", note: 'late, then "lost"' },
        { orderId: "ORD-10", note: "" },
      ],
      concurrency: "fixed",
    });

    writeFileSync(join(dir, "records.json"), JSON.stringify({ records: [{ orderId: "ORD-3" }] }));
    expect((await cli(["run", "--scenario", "--records", "records.json"])).code).toBe(0);
    expect(lastConfig()).toMatchObject({ goal: SCENARIO.goal, records: [{ orderId: "ORD-3" }] });

    const missing = await cli(["run", "--scenario", "--records", "nope.csv"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("Cannot read records file");
  });

  it("run reports an invalid config from client-side validation with exit 2", async () => {
    const r = await cli(["run", "--goal", "x", "--app", "Orders=not-a-url"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid run config");
    expect(r.err).toContain("applications.0.origin");
    expect(engine.created()).toHaveLength(0);
  });

  it("run --scenario explains an empty arena", async () => {
    arena.scenario = null;
    const r = await cli(["run", "--scenario"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no scenario loaded");
  });

  it("status, result, cancel, and runs", async () => {
    const run = engine.seedRun();
    const status = await cli(["status", run.runId]);
    expect(status.code).toBe(0);
    expect(status.out).toContain(`Run ${run.runId} · completed · overclock`);
    expect(status.out).toMatch(/Tasks\s+2 verified \/ 2/);
    expect((await cli(["status", "nope"])).code).toBe(1);

    const result = await cli(["result", run.runId, "--json"]);
    expect((JSON.parse(result.out) as RunResultResponse).runId).toBe(run.runId);
    expect((await cli(["result", run.runId])).out).toContain("Wall time");

    const cancel = await cli(["cancel", run.runId]);
    expect(cancel.code).toBe(0);
    expect(cancel.out).toContain("status: cancelled");

    const runs = await cli(["runs"]);
    expect(runs.code).toBe(0);
    expect(runs.out).toMatch(/^RUN\s+STATUS\s+MODE/);
    expect(runs.out).toContain(run.runId);
    expect(runs.out).toContain("2/2");
  });

  it("reset loads a fresh scenario, or restores the current one with no flags", async () => {
    const r = await cli(["reset", "--seed", "4242", "--records", "100"]);
    expect(r.code).toBe(0);
    expect(arena.requests.at(-1)).toMatchObject({ method: "POST", path: "/api/scenario", body: { seed: 4242, records: 100 } });
    expect(r.out).toContain("Scenario t1-order-reconcile-s4242-n100");

    expect((await cli(["reset", "--template", "t3-crm-status-sync"])).code).toBe(0);
    expect(arena.requests.at(-1)?.body).toEqual({ seed: 4242, template: "t3-crm-status-sync" });

    expect((await cli(["reset"])).code).toBe(0);
    expect(arena.requests.at(-1)?.path).toBe("/api/reset");

    expect((await cli(["reset", "--template", "t4-holdout", "--seed", "9"])).code).toBe(0);
    expect(arena.requests.at(-1)?.body).toEqual({ seed: 9, template: "t4-holdout" });
    expect((await cli(["reset", "--template", "t9"])).code).toBe(2);
  });

  it("check prints ground truth as text or JSON", async () => {
    const text = await cli(["check"]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/Accuracy\s+50\.0% \(1\/2 records correct\)/);
    expect(text.out).toMatch(/ORD-2\s+order\.status\s+expected "shipped"\s+actual "pending"/);
    expect(JSON.parse((await cli(["check", "--json"])).out)).toEqual(CHECK);
  });

  it("surprise and edit-unprocessed", async () => {
    const s = await cli(["surprise", "rename-save", "--app", "CRM"]);
    expect(s.code).toBe(0);
    expect(arena.requests.at(-1)?.body).toEqual({ kind: "rename-save", app: "CRM" });
    expect(s.out).toContain("Active variations: renameButtons");
    const bad = await cli(["surprise", "meteor"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("Unknown surprise kind");

    const e = await cli(["edit-unprocessed"]);
    expect(e.code).toBe(0);
    expect(e.out).toContain('Edited order ORD-2 (record ORD-2): status="on-hold"');
  });
});

describe("CSV records", () => {
  it("parses quotes, embedded newlines, BOM, and blank lines", () => {
    expect(parseCsvRecords('﻿id,text\n1,"a\nb"\n\n2,plain\n', "t.csv")).toEqual([
      { id: "1", text: "a\nb" },
      { id: "2", text: "plain" },
    ]);
    expect(() => parseCsvRecords('id\n"open', "t.csv")).toThrow(/unterminated/);
    expect(() => parseCsvRecords("id\n1,2", "t.csv")).toThrow(/row 2 has 2 fields/);
  });
});

afterEach(() => {
  // Keep tests independent of process-level env tweaks.
  expect(process.env.OVERCLOCK_URL === "http://example.test:9999/").toBe(false);
});
