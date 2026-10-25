import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent, createRunView, type DslPlan, type EngineHealth, type EventPayload, type RunConfig, type RunEvent, type RunListItem, type RunResultResponse, type RunStatus } from "@overclock/contracts";
import { cacheKey } from "@overclock/swarm";
import { OverclockApi, pair } from "../../apps/extension/src/api";
import { ExtensionAccess, type ExtensionStatus } from "../../services/engine/src/extension";
import { FileProgramCache } from "../../services/engine/src/runtime";
import { createEngineServer, type EngineServer } from "../../services/engine/src/server";
import type { RunHandle, RunManager } from "../../services/engine/src/types";
import { WorkflowService } from "../../services/engine/src/workflows";
import { ordersModel } from "../fixtures/appmodel";

/**
 * The Chrome extension's gateway, end to end over HTTP: pairing, token checks, refusal of web
 * pages and rebinding hosts, workflow previews compiled from the stored plan, approvals bound to
 * the previewed records, and the event stream read with the extension's own client. The run
 * manager is a fake that emits real event shapes; everything else is the engine's code.
 */

const APPS = [{ name: "Orders", origin: "http://127.0.0.1:4102" }];
const GOAL = "Fix the customer ID on these 2 orders.\n\nSet each order's Customer ID to C-1 unless it already is.";
const RECORDS = [{ orderId: "O-1" }, { orderId: "O-2" }];
const fixWhen = "$out.read.customerId != 'C-1'";
const PLAN: DslPlan = {
  strategy: { name: "per-order", summary: "fix customer ids", rationale: "one write per order" },
  phases: [
    {
      id: "orders",
      kind: "foreach",
      over: "$input.records",
      key: "$rec.orderId",
      dependsOn: [],
      steps: [
        { id: "open", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
        { id: "read", op: "extract", fields: [{ name: "customerId", control: "orders.detail.customer_id", parse: "string" }] },
        { id: "edit", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}/edit", when: fixWhen },
        { id: "set", op: "fill", control: "orders.edit.customer_id", value: "'C-1'", when: fixWhen },
        { id: "save", op: "submit", control: "orders.edit.submit", when: fixWhen, writes: ["app:orders:order:{$rec.orderId}"], guards: [], verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "customerId", control: "orders.detail.customer_id", equals: "'C-1'" }] }, irreversible: false },
      ],
    },
  ],
  outcomes: [{ id: "o", description: "every order has customer C-1" }],
  assumptions: [],
  risks: [],
};

class FakeRun implements RunHandle {
  readonly createdAt = Date.now();
  private readonly log: RunEvent[] = [];
  private readonly listeners = new Set<(e: RunEvent) => void>();
  private st: RunStatus = "pending";
  constructor(
    readonly runId: string,
    readonly config: RunConfig,
  ) {}
  emit(p: EventPayload): void {
    const e = { ...p, runId: this.runId, seq: this.log.length + 1, ts: Date.now(), t: this.log.length * 10 } as RunEvent;
    this.log.push(e);
    if (e.type === "run.status") this.st = e.status;
    if (e.type === "run.completed") this.st = e.summary.status;
    for (const l of this.listeners) l(e);
  }
  status = () => this.st;
  view = () => this.log.reduce(applyEvent, createRunView(this.runId));
  events = (after: number, limit = 1000) => this.log.filter((e) => e.seq > after).slice(0, limit);
  subscribe(l: (e: RunEvent) => void) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  finished = () => this.log.some((e) => e.type === "run.completed");
  result = (): RunResultResponse => ({ runId: this.runId, status: this.st, summary: null, outcomes: [{ recordKey: "O-1", scope: "input", status: "VERIFIED", writes: 1, receipts: ["save:VERIFIED"], notes: [] }, { recordKey: "O-2", scope: "input", status: "SKIPPED", writes: 0, receipts: [], notes: [] }], verificationSemantics: "" });
  metrics = () => ({});
  trace = () => ({});
  artifact = () => undefined;
  thumbnail = () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  program = () => undefined;
  cancel = () => this.emit({ type: "run.status", status: "cancelled" });
  pause = () => undefined;
  resume = () => undefined;
  approve = () => true;
}

class FakeManager implements RunManager {
  readonly runs = new Map<string, FakeRun>();
  async create(config: RunConfig): Promise<RunHandle> {
    const run = new FakeRun(`run_${this.runs.size + 1}`, config);
    this.runs.set(run.runId, run);
    // A short, real-shaped run: reuse, one verified write, one record with no change needed.
    setTimeout(() => {
      run.emit({ type: "run.status", status: "discovering" });
      run.emit({ type: "policy.decision", intelligence: "warm-cache", candidates: 0, reason: "warm start", features: {} });
      run.emit({ type: "tasks.created", tasks: [{ taskId: "orders.s1@O-1", segmentId: "orders.s1", phaseId: "orders", recordKey: "O-1" }, { taskId: "orders.s1@O-2", segmentId: "orders.s1", phaseId: "orders", recordKey: "O-2" }] });
      run.emit({ type: "task.state", taskId: "orders.s1@O-1", state: "VERIFIED" });
      run.emit({ type: "receipt", taskId: "orders.s1@O-1", recordKey: "O-1", status: "VERIFIED", nodeId: "save", fields: [{ name: "customerId", expected: "C-1", actual: "C-1" }] });
      run.emit({ type: "task.state", taskId: "orders.s1@O-2", state: "SKIPPED" });
    }, 20);
    setTimeout(() => run.emit({ type: "run.completed", summary: { runId: run.runId, status: "completed", wallMs: 1234 } as never }), 60);
    return run;
  }
  get = (id: string) => this.runs.get(id);
  list = (): RunListItem[] => [];
  health = async (): Promise<EngineHealth> => ({ ok: true, version: "test", capabilities: { anthropic: { available: false, plannerModel: "", helperModel: "" }, typesafe: { available: false, model: "", visionModel: "" }, browser: { available: true } } });
}

let dir: string;
let server: EngineServer;
let manager: FakeManager;
let access: ExtensionAccess;
let workflowId: string;
const port = () => Number(new URL(server.url).port);

/** A request with any headers (fetch won't let a test forge Origin or Host). */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: port(), method, path, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function session(): Promise<OverclockApi> {
  const s = await pair(server.url, access.currentCode());
  return new OverclockApi(server.url, s.token);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-ext-"));
  const cache = new FileProgramCache(join(dir, "program-cache"));
  workflowId = cacheKey({ goal: GOAL, applications: APPS, records: RECORDS } as never);
  cache.put(workflowId, { plan: PLAN, models: [ordersModel], review: { status: "passed", rounds: 1 }, learned: { goal: GOAL, recordFields: ["orderId"], applications: APPS, records: 2, at: 1, source: { kind: "local" } } });
  // An entry stored before the library kept instructions: listed, but not rerunnable.
  cache.put("op2:legacy|http://127.0.0.1:4102", { plan: PLAN, models: [ordersModel], review: { status: "passed", rounds: 1 } });
  manager = new FakeManager();
  access = new ExtensionAccess();
  const workflows = new WorkflowService({ cache, network: async () => null, planningAvailable: false });
  const status = async (): Promise<ExtensionStatus> => ({ version: "test", browser: { kind: "overclock-chromium", visible: false, available: true }, planning: { available: false }, network: { enabled: false, connected: false }, environment: { label: "test", applications: workflows.applications() } });
  server = await createEngineServer({ manager, benchmarksDir: dir, port: 0, heartbeatMs: 1000, extension: { workflows, access, status } });
});
afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("extension gateway: access", () => {
  it("requires pairing: no token, a wrong code, or a used code gets nothing", async () => {
    expect((await raw("GET", "/api/x/workflows")).status).toBe(401);
    expect((await raw("GET", "/api/x/workflows", { authorization: "Bearer nope" })).status).toBe(401);
    await expect(pair(server.url, "AAAA-AAAA-AAAA")).rejects.toThrow(/didn't match/);
    const code = access.currentCode();
    const s = await pair(server.url, code);
    expect((await raw("GET", "/api/x/workflows", { authorization: `Bearer ${s.token}` })).status).toBe(200);
    await expect(pair(server.url, code)).rejects.toThrow(/didn't match/);
  });

  it("refuses web pages and non-loopback hosts even with a valid token, and grants CORS only to the extension", async () => {
    const s = await pair(server.url, access.currentCode());
    const auth = { authorization: `Bearer ${s.token}` };
    const site = await raw("GET", "/api/x/workflows", { ...auth, origin: "https://evil.example" });
    expect(site.status).toBe(403);
    expect(site.headers["access-control-allow-origin"]).toBeUndefined();
    const dashboard = await raw("GET", "/api/x/workflows", { ...auth, origin: "http://localhost:3000" });
    expect(dashboard.status).toBe(403);
    const preflight = await raw("OPTIONS", "/api/x/pair", { origin: "https://evil.example", "access-control-request-method": "POST" });
    expect(preflight.status).toBe(403);
    const rebinding = await raw("GET", "/api/x/workflows", { ...auth, host: `attacker.example:${port()}` });
    expect(rebinding.status).toBe(403);
    const ext = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const ok = await raw("GET", "/api/x/workflows", { ...auth, origin: ext });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(ext);
    // The dashboard's own API is unchanged.
    expect((await raw("GET", "/api/health", { origin: "http://localhost:3000" })).headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });
});

describe("extension gateway: workflows", () => {
  it("lists learned workflows with their exact instructions; one without stored instructions isn't rerunnable", async () => {
    const api = await session();
    const { workflows, applications } = await api.workflows();
    const w = workflows.find((x) => x.id === workflowId)!;
    expect(w).toMatchObject({ title: "Fix the customer ID on these 2 orders.", instructions: GOAL, recordFields: ["orderId"], requiredRecords: 2, source: "learned-here", runnable: true, changingSteps: 1 });
    expect(workflows.find((x) => x.id.startsWith("op2:legacy"))).toMatchObject({ runnable: false });
    expect(applications).toEqual(APPS);
  });

  it("previews from the stored plan, compiled against the records", async () => {
    const api = await session();
    const p = await api.preview({ workflowId, records: RECORDS });
    expect(p).toMatchObject({ source: "local", records: 2, modelCalls: "none", blocking: [], approvals: 0, writes: { steps: 1, maxWrites: 2 } });
    const save = p.phases[0]!.steps.find((s) => s.id === "save")!;
    expect(save).toMatchObject({ action: "submit", changesData: true, conditional: true, verifiedBy: "/orders/{orderId}", text: "Save with “Update order”" });
    expect(p.notes.join(" ")).toMatch(/Compiled: \d+ browser segments, 2 record/);
  });

  it("blocks records that don't fit: wrong count for instructions that state one, or unexpected fields", async () => {
    const api = await session();
    expect((await api.preview({ workflowId, records: [{ orderId: "O-1" }] })).blocking.join(" ")).toMatch(/say 2 records/);
    expect((await api.preview({ workflowId, records: [{ orderId: "O-1", note: "x" }, { orderId: "O-2" }] as never })).blocking.join(" ")).toMatch(/unexpected field "note"/);
  });

  it("reuses the learned workflow when a new task has exactly its instructions, and needs planning otherwise", async () => {
    const api = await session();
    expect((await api.preview({ instructions: GOAL, applications: ["Orders"], records: RECORDS })).source).toBe("local");
    const changed = await api.preview({ instructions: GOAL.replace("C-1", "C-2"), applications: ["Orders"], records: RECORDS });
    expect(changed).toMatchObject({ source: "new", modelCalls: "planning", phases: [] });
    expect(changed.blocking.join(" ")).toMatch(/no model access/);
    await expect(api.preview({ instructions: GOAL, applications: ["Billing"], records: RECORDS })).rejects.toThrow(/Choose applications/);
  });
});

describe("extension gateway: runs", () => {
  it("runs only the approved preview: the engine re-derives the configuration and the records must match", async () => {
    const api = await session();
    const p = await api.preview({ workflowId, records: RECORDS });
    await expect(api.startRun({ previewId: p.previewId, workflowId, records: [{ orderId: "O-1" }, { orderId: "O-9" }] })).rejects.toThrow(/changed since you reviewed/);
    const { runId } = await api.startRun({ previewId: p.previewId, workflowId, records: RECORDS });
    const config = manager.runs.get(runId)!.config;
    expect(config).toMatchObject({ goal: GOAL, applications: APPS, records: RECORDS, knowledge: "local-only", cache: "warm", mode: "overclock" });
    expect(cacheKey(config)).toBe(workflowId);
  });

  it("streams real events to the extension's client, then returns outcomes and receipts", async () => {
    const api = await session();
    const p = await api.preview({ workflowId, records: RECORDS });
    const { runId } = await api.startRun({ previewId: p.previewId, workflowId, records: RECORDS });
    const seen: RunEvent[] = [];
    const ended = await api.stream(runId, 0, (e) => seen.push(e));
    expect(ended).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(["run.status", "policy.decision", "tasks.created", "task.state", "receipt", "task.state", "run.completed"]);
    const view = seen.reduce(applyEvent, createRunView(runId));
    expect(view.receipts.VERIFIED).toBe(1);
    const result = await api.result(runId);
    expect(result.outcomes.map((o) => o.status)).toEqual(["VERIFIED", "SKIPPED"]);
    expect(result.receipts).toEqual([{ taskId: "orders.s1@O-1", recordKey: "O-1", nodeId: "save", status: "VERIFIED", fields: [{ name: "customerId", expected: "C-1", actual: "C-1" }] }]);
    expect(await api.thumbnail(runId, "w1")).not.toBeNull();
  });

  it("only exposes runs the extension started, and a new task can't run without consent to model calls", async () => {
    const api = await session();
    const other = await manager.create({ goal: "x", applications: APPS, records: [] } as never);
    await expect(api.run(other.runId)).rejects.toThrow(/started from the extension/);
    const p = await api.preview({ instructions: GOAL.replace("C-1", "C-3"), applications: ["Orders"], records: RECORDS });
    await expect(api.startRun({ previewId: p.previewId, instructions: GOAL.replace("C-1", "C-3"), applications: ["Orders"], records: RECORDS })).rejects.toThrow(/no model access/);
  });
});

describe("extension gateway: a teammate's workflow from the network", () => {
  const op = "op2:" + "0".repeat(64);
  const capability = { intent: { canonicalOperation: "" }, procedure: { plan: PLAN }, controls: [{ key: "orders.edit.submit", app: "Orders", name: "Update order", label: "Update order" }] };
  const client = (operation: string) => ({
    async lookup(q: { canonicalOperation: string }) {
      return { candidates: q.canonicalOperation === operation ? [{ capabilityId: "cap_1", versionId: "cap_1@1", version: 1, canonicalOperation: operation, state: "ACTIVE", publisherId: "c2001cbc8beb86de0000", validations: 1, successfulReuses: 3 }] : [], source: "network", ms: 1 };
    },
    async fetchArtifact() {
      return { capability: { ...capability, intent: { canonicalOperation: operation } }, source: "network", ms: 1 };
    },
  });

  it("offers an exact-operation capability as the team's workflow and runs it as a network import", async () => {
    const { canonicalOperation } = await import("@overclock/swarm");
    const exact = canonicalOperation(GOAL.replace("C-1", "C-5"), ["orderId"]);
    const dir2 = mkdtempSync(join(tmpdir(), "oc-ext-net-"));
    const svc = new WorkflowService({ cache: new FileProgramCache(join(dir2, "c")), network: async () => client(exact) as never, planningAvailable: false, extraApplications: APPS });
    const req = { instructions: GOAL.replace("C-1", "C-5"), applications: ["Orders"], records: RECORDS };
    const p = await svc.preview(req);
    expect(p).toMatchObject({ source: "network", modelCalls: "none", blocking: [], network: { versionId: "cap_1@1", publisher: "c2001cbc8beb86de", state: "ACTIVE", successfulReuses: 3 } });
    expect(p.phases[0]!.steps.find((s) => s.id === "save")).toMatchObject({ text: "Save with “Update order”", changesData: true });
    expect(await svc.runConfig({ ...req, previewId: p.previewId })).toMatchObject({ knowledge: "network-read", goal: req.instructions });
    // Any other instructions get nothing from the network.
    expect((await svc.preview({ ...req, instructions: GOAL.replace("C-1", "C-6") })).source).toBe("new");
    rmSync(dir2, { recursive: true, force: true });
    expect(op).toMatch(/^op2:/);
  });
});
