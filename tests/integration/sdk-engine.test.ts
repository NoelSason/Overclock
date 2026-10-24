import { tmpdir } from "node:os";
import { applyEvent, createRunView, type EngineHealth, type EventPayload, type RunConfig, type RunEvent, type RunListItem, type RunResultResponse, type RunStatus } from "@overclock/contracts";
import { Overclock, OverclockError } from "@overclock/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineServer, type EngineServer } from "../../services/engine/src/server";
import type { RunHandle, RunManager } from "../../services/engine/src/types";

/**
 * The SDK against the engine's real HTTP + SSE layer, with a stub orchestrator behind it that
 * emits events live on a timer. Checks replay -> live handoff, `end`, Last-Event-ID resume, and
 * error bodies as the real server produces them.
 */

const EVENT_COUNT = 12;

class StubRun implements RunHandle {
  readonly createdAt = Date.now();
  private readonly log: RunEvent[] = [];
  private readonly listeners = new Set<(e: RunEvent) => void>();
  private state: RunStatus = "pending";
  cancelled = false;

  constructor(
    readonly runId: string,
    readonly config: RunConfig,
  ) {}

  /** Emits `run.created`, a few status/log events, then `run.completed`, one every `stepMs`. */
  play(stepMs: number): void {
    const payloads: EventPayload[] = [{ type: "run.created", config: this.config }, { type: "run.status", status: "running" }];
    for (let i = 0; payloads.length < EVENT_COUNT - 1; i++) payloads.push({ type: "log", level: "info", message: `step ${i}` });
    const summary = { runId: this.runId, mode: this.config.mode, status: "completed" as const, wallMs: 100, discoveryMs: 0, compileMs: 0, executionMs: 100, records: 0, tasks: 0, verified: 0, failed: 0, unconfirmed: 0, skipped: 0, needsApproval: 0, recordsVerified: 0, recoveries: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, modelCostUsd: 0, workerUtilization: 0, maxConcurrency: 1, firstActionMs: null, firstVerifiedMs: null, overlapMs: 0, recoveryMs: 0, stageMs: {} };
    payloads.push({ type: "run.completed", summary });
    const next = () => {
      const p = payloads.shift();
      if (!p) return;
      this.emit(p);
      if (payloads.length > 0) setTimeout(next, stepMs);
    };
    next();
  }

  private emit(p: EventPayload): void {
    const e = { ...p, runId: this.runId, seq: this.log.length + 1, ts: Date.now(), t: Date.now() - this.createdAt } as RunEvent;
    if (e.type === "run.status") this.state = e.status;
    if (e.type === "run.completed") this.state = e.summary.status;
    this.log.push(e);
    for (const l of this.listeners) l(e);
  }

  status(): RunStatus {
    return this.state;
  }
  view() {
    const v = createRunView(this.runId);
    for (const e of this.log) applyEvent(v, e);
    return v;
  }
  events(after: number, limit = 1000): RunEvent[] {
    return this.log.filter((e) => e.seq > after).slice(0, limit);
  }
  subscribe(listener: (e: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  finished(): boolean {
    return this.log.some((e) => e.type === "run.completed");
  }
  result(): RunResultResponse {
    return { runId: this.runId, status: this.state, summary: null, outcomes: [], verificationSemantics: "stub" };
  }
  metrics(): unknown {
    return { events: this.log.length };
  }
  trace(): unknown {
    return { resourceSpans: [] };
  }
  artifact(): unknown {
    return undefined;
  }
  thumbnail(): Buffer | undefined {
    return undefined;
  }
  program(): unknown {
    return undefined;
  }
  cancel(): void {
    this.cancelled = true;
  }
  pause(): void {}
  resume(): void {}
  approve(): boolean {
    return true;
  }
}

class StubManager implements RunManager {
  runs = new Map<string, StubRun>();
  stepMs = 15;
  private n = 0;

  async create(config: RunConfig): Promise<RunHandle> {
    const run = new StubRun(`run_${++this.n}`, config);
    this.runs.set(run.runId, run);
    setTimeout(() => run.play(this.stepMs), 20);
    return run;
  }
  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }
  list(): RunListItem[] {
    return [...this.runs.values()].map((r) => ({ runId: r.runId, status: r.status(), mode: r.config.mode, goal: r.config.goal, createdAt: r.createdAt }));
  }
  async health(): Promise<EngineHealth> {
    return {
      ok: true,
      version: "stub",
      capabilities: { anthropic: { available: false, plannerModel: "-", helperModel: "-" }, typesafe: { available: false, model: "-", visionModel: "-" }, browser: { available: false } },
    };
  }
}

const CONFIG = { goal: "Stub goal", applications: [{ name: "Orders", origin: "http://127.0.0.1:4102" }] };

let server: EngineServer;
const manager = new StubManager();

beforeAll(async () => {
  server = await createEngineServer({ manager, benchmarksDir: tmpdir(), port: 0, heartbeatMs: 50 });
});

afterAll(async () => {
  await server?.close();
});

describe("SDK against the real engine HTTP layer", () => {
  it("execute follows live events to `end` and returns the result", async () => {
    const oc = new Overclock({ endpoint: server.url });
    const seen: number[] = [];
    const result = await oc.execute(CONFIG, { onEvent: (e) => seen.push(e.seq) });
    expect(seen).toEqual(Array.from({ length: EVENT_COUNT }, (_, i) => i + 1));
    expect(result.status).toBe("completed");
    expect((await oc.health()).version).toBe("stub");
    expect((await oc.list()).length).toBeGreaterThan(0);
    expect((await oc.events(result.runId, 10)).events.map((e) => e.seq)).toEqual([11, 12]);
    // A finished run replays everything and ends immediately.
    const replay: number[] = [];
    for await (const e of oc.stream(result.runId, { after: 5 })) replay.push(e.seq);
    expect(replay[0]).toBe(6);
    expect(replay.at(-1)).toBe(EVENT_COUNT);
  });

  it("resumes with Last-Event-ID when the connection drops mid-run", async () => {
    const sentHeaders: (string | null)[] = [];
    let streamCalls = 0;
    // Wrap fetch so the first stream connection dies after a few events arrive.
    const droppingFetch: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("/stream")) sentHeaders.push(new Headers(init?.headers).get("last-event-id"));
      const res = await fetch(input, init);
      if (!url.includes("/stream") || ++streamCalls > 1 || !res.body) return res;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let events = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          controller.enqueue(value);
          events += decoder.decode(value, { stream: true }).split("event: run-event").length - 1;
          if (events >= 3) {
            controller.error(new TypeError("terminated"));
            await reader.cancel();
          }
        },
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const oc = new Overclock({ endpoint: server.url, fetch: droppingFetch, reconnectDelayMs: 10 });
    const seen: number[] = [];
    const result = await oc.execute(CONFIG, { onEvent: (e) => seen.push(e.seq) });
    expect(seen).toEqual(Array.from({ length: EVENT_COUNT }, (_, i) => i + 1));
    expect(result.status).toBe("completed");
    expect(sentHeaders.length).toBeGreaterThanOrEqual(2);
    expect(sentHeaders[0]).toBeNull();
    expect(Number(sentHeaders[1])).toBeGreaterThanOrEqual(3);
  });

  it("maps control calls and real error bodies", async () => {
    manager.stepMs = 200;
    const oc = new Overclock({ endpoint: server.url });
    const { runId } = await oc.start(CONFIG);
    expect(await oc.cancel(runId)).toMatchObject({ ok: true });
    expect(manager.runs.get(runId)?.cancelled).toBe(true);
    expect(await oc.approve(runId, "a1", true)).toEqual({ ok: true });
    expect(await oc.metrics(runId)).toMatchObject({ events: expect.any(Number) });

    const missing = await oc.status("nope").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(OverclockError);
    expect((missing as OverclockError).status).toBe(404);
    const program = await oc.program(runId).catch((e: unknown) => e);
    expect((program as OverclockError).status).toBe(404);
    expect((program as OverclockError).message).toContain("program not compiled yet");
    manager.stepMs = 15;
  });
});
