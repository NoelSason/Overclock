import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startArena, type Arena } from "@overclock/arena";
import { loadEnv } from "@overclock/telemetry";
// Imported by path: the root package.json does not list @overclock/external-baselines yet.
import {
  arenaCredentialsFromEnv,
  BASELINE_PRICES,
  costUsd,
  createExternalRunner,
  ExternalBaselineUnavailableError,
  ExternalBudgetExceededError,
  loadFramework,
  openStagehandSession,
  resolveRunInput,
  runExternal,
  UsageMeter,
  type ExternalRunInput,
  type ModelMiddleware,
} from "../../packages/external-baselines/src/index";

loadEnv();
const LIVE = process.env.OVERCLOCK_LIVE === "1";

const APPS = [
  { name: "CRM", origin: "http://127.0.0.1:4101" },
  { name: "Orders", origin: "http://127.0.0.1:4102/" },
];
const base = (over: Partial<ExternalRunInput> = {}): ExternalRunInput => ({ goal: "Do the task.", records: [{ orderId: "O-1" }], applications: APPS, credentials: { username: "u", password: "p" }, ...over });

type GenerateArgs = Parameters<NonNullable<ModelMiddleware["wrapGenerate"]>>[0];
type GenerateResult = Awaited<ReturnType<GenerateArgs["doGenerate"]>>;
type StreamArgs = Parameters<NonNullable<ModelMiddleware["wrapStream"]>>[0];
type CallParams = GenerateArgs["params"];

const params = (text: string): CallParams => ({ prompt: [{ role: "user", content: [{ type: "text", text }] }] }) as CallParams;
const generated = (inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheCreation = 0): GenerateResult =>
  ({ content: [], finishReason: "stop", usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cachedInputTokens }, warnings: [], providerMetadata: { anthropic: { cacheCreationInputTokens: cacheCreation } } }) as unknown as GenerateResult;

async function generate(meter: UsageMeter, p: CallParams, res: GenerateResult | Error): Promise<GenerateResult> {
  const args = { params: p, model: {} as GenerateArgs["model"], doGenerate: async () => (res instanceof Error ? Promise.reject(res) : res), doStream: async () => Promise.reject(new Error("unused")) } as GenerateArgs;
  return meter.middleware.wrapGenerate!(args);
}

describe("external baseline: input and result plumbing", () => {
  it("normalizes input and applies the documented defaults", () => {
    const r = resolveRunInput(base());
    expect(r.model).toBe("claude-haiku-5-5");
    expect(r.maxStepsPerRecord).toBe(30);
    expect(r.effort).toBe("low");
    expect(r.budgetUsd).toBeUndefined();
    expect(r.applications).toEqual([
      { name: "CRM", origin: "http://127.0.0.1:4101" },
      { name: "Orders", origin: "http://127.0.0.1:4102" },
    ]);
    expect(resolveRunInput(base({ model: "claude-opus-5-5", maxStepsPerRecord: 5, budgetUsd: 0.5, effort: null }))).toMatchObject({ model: "claude-opus-5-5", maxStepsPerRecord: 5, budgetUsd: 0.5, effort: null });
  });

  it("rejects input it cannot run", () => {
    expect(() => resolveRunInput(base({ goal: " " }))).toThrow(TypeError);
    expect(() => resolveRunInput(base({ model: "gpt-5" }))).toThrow(/model must be one of claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5/);
    expect(() => resolveRunInput(base({ applications: [] }))).toThrow(/applications/);
    expect(() => resolveRunInput(base({ applications: [{ name: "X", origin: "file:///etc" }] }))).toThrow(/http/);
    expect(() => resolveRunInput(base({ applications: [APPS[0]!, { ...APPS[0]! }] }))).toThrow(/duplicated/);
    expect(() => resolveRunInput(base({ records: [null as unknown as Record<string, unknown>] }))).toThrow(/records\[0\]/);
    expect(() => resolveRunInput(base({ maxStepsPerRecord: 0 }))).toThrow(/maxStepsPerRecord/);
    expect(() => resolveRunInput(base({ budgetUsd: -1 }))).toThrow(/budgetUsd/);
  });

  it("prices tokens with the benchmark's fixed prices", () => {
    expect(BASELINE_PRICES).toEqual({ "claude-haiku-5-5": { input: 0.1, output: 0.5 }, "claude-sonnet-5-5": { input: 2, output: 10 }, "claude-opus-5-5": { input: 4, output: 20 } });
    expect(costUsd("claude-haiku-5-5", 1_000_000, 1_000_000)).toBeCloseTo(0.6, 10);
    expect(costUsd("claude-sonnet-5-5", 500_000, 100_000)).toBeCloseTo(2, 10);
    expect(costUsd("claude-opus-5-5", 250_000, 50_000)).toBeCloseTo(2, 10);
  });

  it("meters calls and tokens, counts cached input at the input price, and counts failed calls", async () => {
    const meter = new UsageMeter("claude-haiku-5-5", undefined, "low", undefined);
    await generate(meter, params("hello"), generated(1000, 200, 300, 50));
    await expect(generate(meter, params("again"), new Error("HTTP 529"))).rejects.toThrow("HTTP 529");
    expect(meter.calls).toBe(2);
    expect(meter.failures).toBe(1);
    expect(meter.inputTokens).toBe(1350);
    expect(meter.cachedInputTokens).toBe(300);
    expect(meter.outputTokens).toBe(200);
    expect(meter.spentUsd).toBeCloseTo(costUsd("claude-haiku-5-5", 1350, 200), 12);
  });

  it("meters streamed calls from the finish part", async () => {
    const meter = new UsageMeter("claude-sonnet-5-5", undefined, null, undefined);
    type Part = { type: string; usage?: unknown };
    const parts: Part[] = [{ type: "text-delta" }, { type: "finish", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } }];
    const stream = new ReadableStream<Part>({ start: (c) => (parts.forEach((p) => c.enqueue(p)), c.close()) });
    const args = { params: params("s"), model: {}, doGenerate: async () => Promise.reject(new Error("unused")), doStream: async () => ({ stream }) } as unknown as StreamArgs;
    const res = await meter.middleware.wrapStream!(args);
    const seen: string[] = [];
    for await (const p of res.stream as unknown as AsyncIterable<Part>) seen.push(p.type);
    expect(seen).toEqual(["text-delta", "finish"]);
    expect(meter.calls).toBe(1);
    expect(meter.inputTokens).toBe(100);
    expect(meter.outputTokens).toBe(10);
  });

  it("refuses calls once the budget would be exceeded and aborts the run's signal", async () => {
    // The guard projects the prompt plus 500 output tokens ($0.01 on Opus) before each call.
    const meter = new UsageMeter("claude-opus-5-5", 0.02, "low", undefined);
    await generate(meter, params("first"), generated(4000, 200)); // $0.02 spent
    expect(meter.signal.aborted).toBe(false);
    await expect(generate(meter, params("second"), generated(1, 1))).rejects.toBeInstanceOf(ExternalBudgetExceededError);
    expect(meter.calls).toBe(1);
    expect(meter.budgetExceeded?.message).toContain("Model budget exceeded");
    expect(meter.signal.aborted).toBe(true);
  });

  it("adds the effort and the run's abort signal to every call, keeping explicit settings", async () => {
    const ac = new AbortController();
    const meter = new UsageMeter("claude-haiku-5-5", undefined, "low", ac.signal);
    const t = meter.middleware.transformParams!;
    const model = {} as Parameters<typeof t>[0]["model"];
    const p1 = await t({ type: "generate", params: params("x"), model });
    expect(p1.providerOptions).toEqual({ anthropic: { effort: "low" } });
    const own = new AbortController();
    const p2 = await t({ type: "generate", params: { ...params("x"), abortSignal: own.signal, providerOptions: { anthropic: { effort: "high" }, other: { a: 1 } } }, model });
    expect(p2.providerOptions).toEqual({ anthropic: { effort: "high" }, other: { a: 1 } });
    expect(p2.abortSignal!.aborted).toBe(false);
    ac.abort();
    expect(p1.abortSignal!.aborted).toBe(true);
    expect(p2.abortSignal!.aborted).toBe(true);
    await expect(generate(meter, params("after cancel"), generated(1, 1))).rejects.toThrow("Cancelled");
    const none = await new UsageMeter("claude-haiku-5-5", undefined, null, undefined).middleware.transformParams!({ type: "generate", params: params("x"), model });
    expect(none.providerOptions).toBeUndefined();
  });

  it("throws ExternalBaselineUnavailableError without an API key, after validating input", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(runExternal(base({ model: "nope" }))).rejects.toBeInstanceOf(TypeError);
      const err = await runExternal(base()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExternalBaselineUnavailableError);
      expect((err as Error).message).toBe("ANTHROPIC_API_KEY is not set");
      // The harness adapter maps the run config onto the same call.
      const scenario = { scenarioId: "s", seed: 1, template: "t1-order-reconcile" as const, title: "t", goal: "g", records: [{ orderId: "O-1" }], applications: APPS, holdout: false };
      await expect(createExternalRunner()({ goal: "g", applications: APPS }, scenario)).rejects.toBeInstanceOf(ExternalBaselineUnavailableError);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("loads Stagehand and Playwright's Chromium in this environment", async () => {
    const fw = await loadFramework();
    expect(fw.version).toBe("3.7.3");
    expect(fw.executablePath).toContain("ms-playwright");
  });
});

describe("external baseline: browser session (no model calls)", () => {
  let arena: Arena;
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "oc-external-it-"));
    arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 7, template: "t1-order-reconcile", records: 3 } });
  });
  afterAll(async () => {
    await arena?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("logs in with code, keeps the agent on the allowlisted origins, and spends nothing", async () => {
    const scenario = arena.manager.publicScenario()!;
    const meter = new UsageMeter("claude-haiku-5-5", 0.01, "low", undefined);
    const session = await openStagehandSession({ framework: await loadFramework(), applications: scenario.applications, credentials: arenaCredentialsFromEnv(), model: "claude-haiku-5-5", apiKey: "unused-in-this-test", middleware: meter.middleware });
    try {
      const sPage = await session.stagehand.context.awaitActivePage();
      expect(new URL(sPage.url()).origin).toBe(new URL(scenario.applications[0]!.origin).origin);
      // Logged in on every app: no login form anywhere.
      const page = session.context.pages()[0]!;
      for (const app of scenario.applications) {
        await page.goto(app.origin, { waitUntil: "domcontentloaded" });
        expect(new URL(page.url()).pathname).not.toBe("/login");
        expect(await page.locator("input[type=password]").count()).toBe(0);
      }
      // The arena's admin server shares the host but not the origin: blocked, through Playwright and through Stagehand's own page API.
      await expect(page.goto(`${arena.adminOrigin}/api/health`)).rejects.toThrow(/ERR_BLOCKED_BY_CLIENT/);
      await sPage.goto(`${arena.adminOrigin}/api/health`).catch(() => undefined);
      expect(sPage.url()).not.toBe(`${arena.adminOrigin}/api/health`);
      expect(await page.evaluate(() => document.body.innerText)).not.toContain("adminOrigin");
      expect(session.guard.blocked).toBeGreaterThanOrEqual(2);
      expect([...session.guard.blockedOrigins]).toEqual([arena.adminOrigin]);
      expect(meter.calls).toBe(0);
    } finally {
      await session.close();
    }
    // Nothing was written.
    expect(arena.manager.check()!.collateralWrites).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Live: Stagehand's agent with Claude Haiku on the arena. Gated; spends real money (capped at $1.50).

describe.skipIf(!LIVE)("external baseline (live Stagehand + Claude)", () => {
  it("runs t1-order-reconcile on 3 records and reports checker accuracy", { timeout: 30 * 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-external-live-"));
    const arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 101, template: "t1-order-reconcile", records: 3 } });
    try {
      const s = arena.manager.publicScenario()!;
      const result = await runExternal({ goal: s.goal, records: s.records, applications: s.applications, credentials: arenaCredentialsFromEnv(), budgetUsd: 1.5 });
      const check = arena.manager.check()!;
      const report = {
        ...result,
        accuracy: check.accuracy,
        correct: `${check.correctRecords}/${check.totalRecords}`,
        duplicateWrites: check.duplicateWrites,
        collateralWrites: check.collateralWrites,
        mismatches: check.mismatches,
      };
      console.log(`[external live] ${JSON.stringify(report, null, 2)}`);
      expect(result.recordsAttempted).toBe(3);
      expect(result.costUsd).toBeLessThan(1.6);
      expect(result.modelCalls).toBeGreaterThan(0);
    } finally {
      await arena.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
