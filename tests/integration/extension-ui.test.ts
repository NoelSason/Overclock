import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent, createRunView, type DslPlan, type EngineHealth, type EventPayload, type RunConfig, type RunEvent, type RunListItem, type RunResultResponse, type RunStatus } from "@overclock/contracts";
import { cacheKey } from "@overclock/swarm";
import { ExtensionAccess } from "../../services/engine/src/extension";
import { FileProgramCache } from "../../services/engine/src/runtime";
import { createEngineServer, type EngineServer } from "../../services/engine/src/server";
import type { RunHandle, RunManager } from "../../services/engine/src/types";
import { WorkflowService } from "../../services/engine/src/workflows";
import { ordersModel } from "../fixtures/appmodel";

/**
 * Browser-level smoke test: the built extension is loaded unpacked into Chromium, the side panel
 * page pairs with a real engine gateway, picks a learned workflow, loads records from a CSV,
 * previews, approves, follows the run, and shows its outcomes. The run manager is a fake that
 * emits real event shapes (the real execution path is covered by the demo smoke run).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const DIST = join(ROOT, "apps", "extension", "dist");
const APPS = [{ name: "Orders", origin: "http://127.0.0.1:4102" }];
const GOAL = "Fix the customer ID on these 2 orders.\n\nSet each order's Customer ID to C-1 unless it already is.";
const RECORDS = [{ orderId: "O-1" }, { orderId: "O-2" }];
const when = "$out.read.customerId != 'C-1'";
const PLAN: DslPlan = {
  strategy: { name: "per-order", summary: "fix customer ids", rationale: "" },
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
        { id: "set", op: "fill", control: "orders.edit.customer_id", value: "'C-1'", when },
        { id: "save", op: "submit", control: "orders.edit.submit", when, writes: ["app:orders:order:{$rec.orderId}"], guards: [], verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "customerId", control: "orders.detail.customer_id", equals: "'C-1'" }] }, irreversible: false },
      ],
    },
  ],
  outcomes: [{ id: "o", description: "o" }],
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
    const e = { ...p, runId: this.runId, seq: this.log.length + 1, ts: Date.now(), t: this.log.length * 100 } as RunEvent;
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
  result = (): RunResultResponse => ({ runId: this.runId, status: this.st, summary: { runId: this.runId, wallMs: 1500, modelCalls: 0, modelCostUsd: 0 } as never, outcomes: [{ recordKey: "O-1", scope: "input", status: "VERIFIED", writes: 1, receipts: ["save:VERIFIED"], notes: [] }, { recordKey: "O-2", scope: "input", status: "SKIPPED", writes: 0, receipts: [], notes: [] }], verificationSemantics: "" });
  metrics = () => ({});
  trace = () => ({});
  artifact = () => undefined;
  thumbnail = () => undefined;
  program = () => undefined;
  cancel = () => undefined;
  pause = () => undefined;
  resume = () => undefined;
  approve = () => true;
}

const created: RunConfig[] = [];
const manager: RunManager = {
  async create(config) {
    created.push(config);
    const run = new FakeRun("run_ui", config);
    runs.set(run.runId, run);
    setTimeout(() => {
      run.emit({ type: "run.status", status: "running" });
      run.emit({ type: "policy.decision", intelligence: "warm-cache", candidates: 0, reason: "warm", features: {} });
      run.emit({ type: "tasks.created", tasks: [{ taskId: "orders.s1@O-1", segmentId: "orders.s1", phaseId: "orders", recordKey: "O-1" }, { taskId: "orders.s1@O-2", segmentId: "orders.s1", phaseId: "orders", recordKey: "O-2" }] });
      run.emit({ type: "receipt", taskId: "orders.s1@O-1", recordKey: "O-1", status: "VERIFIED", nodeId: "save", fields: [{ name: "customerId", expected: "C-1", actual: "C-1" }] });
      run.emit({ type: "task.state", taskId: "orders.s1@O-1", state: "VERIFIED" });
      run.emit({ type: "task.state", taskId: "orders.s1@O-2", state: "SKIPPED" });
    }, 200);
    setTimeout(() => run.emit({ type: "run.completed", summary: { runId: run.runId, status: "completed", wallMs: 1500 } as never }), 500);
    return run;
  },
  get: (id) => runs.get(id),
  list: (): RunListItem[] => [],
  health: async (): Promise<EngineHealth> => ({ ok: true, version: "test", capabilities: { anthropic: { available: false, plannerModel: "", helperModel: "" }, typesafe: { available: false, model: "", visionModel: "" }, browser: { available: true } } }),
};
const runs = new Map<string, FakeRun>();

let dir: string;
let server: EngineServer;
let access: ExtensionAccess;
let context: BrowserContext;
let extensionId: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, "apps", "extension", "build.mjs")], { stdio: "ignore" });
  dir = mkdtempSync(join(tmpdir(), "oc-ext-ui-"));
  const cache = new FileProgramCache(join(dir, "program-cache"));
  const id = cacheKey({ goal: GOAL, applications: APPS, records: RECORDS } as never);
  cache.put(id, { plan: PLAN, models: [ordersModel], review: { status: "passed", rounds: 1 }, learned: { goal: GOAL, recordFields: ["orderId"], applications: APPS, records: 2, at: Date.now(), source: { kind: "local" } } });
  access = new ExtensionAccess();
  const workflows = new WorkflowService({ cache, network: async () => null, planningAvailable: false });
  server = await createEngineServer({
    manager,
    benchmarksDir: dir,
    port: 0,
    heartbeatMs: 1000,
    extension: { workflows, access, status: async () => ({ version: "test", browser: { kind: "overclock-chromium", visible: false, available: true }, planning: { available: false }, network: { enabled: false, connected: false }, environment: { label: "Demonstration apps on this computer", applications: workflows.applications() } }) },
  });
  context = await chromium.launchPersistentContext(join(dir, "profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`] });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;
}, 120_000);

afterAll(async () => {
  await context?.close();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Overclock for Chrome", () => {
  it("loads unpacked, pairs, previews a learned workflow, runs it, and shows outcomes", async () => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.getByText("Describe it. Approve it.").first().waitFor();

    await page.getByLabel("Engine address").fill(server.url);
    await page.getByLabel("Pairing code").fill(access.currentCode());
    await page.getByRole("button", { name: "Connect" }).click();

    await page.getByText("Runs in").waitFor();
    await expect(page.getByText("Overclock’s own browser on this computer, not your Chrome tabs").isVisible()).resolves.toBe(true);
    await page.getByRole("button", { name: /Fix the customer ID on these 2 orders/ }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "orders.csv", mimeType: "text/csv", buffer: Buffer.from("orderId\nO-1\nO-2\n") });
    await page.getByText("orders.csv").waitFor();
    await page.getByRole("button", { name: "Preview the workflow" }).click();

    await page.getByText("Reusing a workflow learned on this computer").waitFor();
    await expect(page.getByText("Save with “Update order”").isVisible()).resolves.toBe(true);
    await expect(page.getByText("verified by re-reading /orders/{orderId}").isVisible()).resolves.toBe(true);
    await page.getByRole("button", { name: "Approve and run on 2 records" }).click();

    await page.getByText("records done").waitFor({ timeout: 15_000 });
    await expect(page.locator(".result-hero .big").innerText()).resolves.toBe("2 of 2");
    await expect(page.getByText("Changed · verified").isVisible()).resolves.toBe(true);
    await expect(page.getByText("No change needed").first().isVisible()).resolves.toBe(true);
    await expect(page.getByText("O-1: change confirmed by re-reading the page.").isVisible()).resolves.toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ goal: GOAL, knowledge: "local-only", cache: "warm" });
  }, 60_000);

  it("refuses a CSV whose columns don't match the workflow", async () => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.getByRole("button", { name: /Fix the customer ID on these 2 orders/ }).click();
    await page.locator('input[type="file"]').setInputFiles({ name: "wrong.csv", mimeType: "text/csv", buffer: Buffer.from("customer\nC-9\n") });
    await page.getByText(/Missing column: orderId/).waitFor();
    await expect(page.getByRole("button", { name: "Preview the workflow" }).isDisabled()).resolves.toBe(true);
  }, 30_000);
});
