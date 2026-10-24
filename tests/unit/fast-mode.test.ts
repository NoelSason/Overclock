import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * Planner fast mode (`speed: "fast"`): requests carry the speed and its beta header, a refused fast
 * request falls back to standard speed, and nothing is re-sent once streamed text reached a live
 * consumer (the incremental compiler). A fake server speaks just enough of the Messages API.
 */

interface Seen {
  body: Record<string, unknown>;
  beta: string;
}
type Reply = (res: ServerResponse, body: Record<string, unknown>) => void;

let server: Server;
const seen: Seen[] = [];
let replies: Reply[] = [];
const saved = { ...process.env };
const plan = { a: 1 };

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function message(usage: Record<string, unknown>) {
  return { type: "message", id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage };
}

/** A complete reply: streamed when the request streams, a JSON body otherwise. */
function ok(opts: { speed?: "fast" | "standard"; text?: string } = {}): Reply {
  const text = opts.text ?? JSON.stringify(plan);
  const usage = { input_tokens: 1_000_000, output_tokens: 0, ...(opts.speed ? { speed: opts.speed } : {}) };
  return (res, body) => {
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, "message_start", { type: "message_start", message: message(usage) });
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1_000_000 } });
      sse(res, "message_stop", { type: "message_stop" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...message({ ...usage, output_tokens: 1_000_000 }), content: [{ type: "text", text }], stop_reason: "end_turn" }));
    }
  };
}

function refuse(status: number, type: string, message: string): Reply {
  return (res) => {
    res.writeHead(status, { "content-type": "application/json", "retry-after": "20" });
    res.end(JSON.stringify({ type: "error", error: { type, message } }));
  };
}

/** A stream that starts, optionally delivers partial text, then fails with an SSE error event. */
function overloadedMidStream(partialText: string | null): Reply {
  return (res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, "message_start", { type: "message_start", message: message({ input_tokens: 10, output_tokens: 0 }) });
    if (partialText !== null) {
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: partialText } });
    }
    sse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    res.end();
  };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ body, beta: String(req.headers["anthropic-beta"] ?? "") });
      const reply = replies.shift() ?? refuse(500, "api_error", "no scripted reply left");
      reply(res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
});
afterAll(async () => {
  process.env = { ...saved };
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(async () => {
  seen.length = 0;
  replies = [];
  (await import("@overclock/models")).resetFastModePause();
});

async function provider(plannerSpeed: "fast" | "standard" = "fast") {
  const m = await import("@overclock/models");
  const ledger = new m.ModelLedger(undefined);
  const claude = new m.ClaudeProvider({ ...m.claudeConfigFromEnv(), plannerModel: "claude-opus-5-5", plannerSpeed }, ledger);
  return { claude, ledger };
}

const schema = z.object({ a: z.number() });
const req = { role: "planner" as const, purpose: "planner", system: "s", user: "u", schema };

describe("planner fast mode", () => {
  it("is off by default: no speed field and no fast-mode beta", async () => {
    const { claude } = await provider("standard");
    replies = [ok()];
    await claude.json(req);
    expect(seen[0]!.body).not.toHaveProperty("speed");
    expect(seen[0]!.beta).not.toContain("fast-mode");
  });

  it("sends speed fast with its beta on every request path, and prices by the speed the response reports", async () => {
    const { claude, ledger } = await provider();
    replies = [ok({ speed: "fast" }), ok({ speed: "fast" }), ok({ speed: "fast" })];
    const viaJson = await claude.json(req);
    const viaStream = await claude.streamParse(req);
    const viaParse = await claude.parse(req);
    for (const s of seen) {
      expect(s.body.speed).toBe("fast");
      expect(s.beta).toContain("fast-mode-2026-02-01");
      expect(s.beta).toContain("server-side-fallback-2026-07-01");
      expect(s.body.fallbacks).toBe("default");
    }
    // 1M input + 1M output tokens at the fast rates ($8 / $40).
    for (const r of [viaJson, viaStream, viaParse]) {
      expect(r.speed).toBe("fast");
      expect(r.costUsd).toBeCloseTo(48, 6);
    }
    expect(ledger.calls.map((c) => c.speed)).toEqual(["fast", "fast", "fast"]);
    expect(viaStream.ttftMs).not.toBeNull();
  });

  it("prices at standard rates when the response reports standard speed", async () => {
    const { claude } = await provider();
    replies = [ok({ speed: "standard" })];
    const r = await claude.json(req);
    expect(r.speed).toBe("standard");
    expect(r.costUsd).toBeCloseTo(24, 6);
  });

  it("falls back to standard on a 429 without the SDK's own retries, then pauses fast mode", async () => {
    const { claude, ledger } = await provider();
    replies = [refuse(429, "rate_limit_error", "Fast mode rate limit exceeded"), ok()];
    const r = await claude.json(req);
    expect(r.data).toEqual(plan);
    expect(seen.map((s) => s.body.speed ?? "standard")).toEqual(["fast", "standard"]);
    expect(ledger.calls.map((c) => [c.speed, c.ok])).toEqual([
      ["fast", false],
      ["standard", true],
    ]);
    expect(ledger.calls[0]!.error).toMatch(/fast mode unavailable/);
    // The next call skips fast mode while the pause lasts, instead of paying another refusal.
    replies = [ok()];
    await claude.streamParse(req);
    expect(seen[2]!.body).not.toHaveProperty("speed");
  });

  it("falls back on 529 (structured parse path) and on a 400 that names the speed, which disables fast mode", async () => {
    const { claude } = await provider();
    replies = [refuse(529, "overloaded_error", "Overloaded"), ok()];
    expect((await claude.parse(req)).data).toEqual(plan);
    expect(seen.map((s) => s.body.speed ?? "standard")).toEqual(["fast", "standard"]);

    (await import("@overclock/models")).resetFastModePause();
    seen.length = 0;
    replies = [refuse(400, "invalid_request_error", "speed: fast mode is not available for this organization"), ok()];
    await claude.json(req);
    expect(seen.map((s) => s.body.speed ?? "standard")).toEqual(["fast", "standard"]);
    expect(claude.speedFor({ role: "planner" })).toBe("standard");
  });

  it("does not fall back on errors unrelated to fast mode", async () => {
    const { claude } = await provider();
    replies = [refuse(400, "invalid_request_error", "max_tokens: too large")];
    await expect(claude.json(req)).rejects.toThrow(/max_tokens/);
    expect(seen).toHaveLength(1);
  });

  it("re-sends at standard when a fast stream fails before any text reached the consumer", async () => {
    const { claude } = await provider();
    replies = [overloadedMidStream(null), ok()];
    const deltas: string[] = [];
    const r = await claude.streamParse({ ...req, onText: (d) => deltas.push(d) });
    expect(r.data).toEqual(plan);
    expect(deltas.join("")).toBe(JSON.stringify(plan));
    expect(seen.map((s) => s.body.speed ?? "standard")).toEqual(["fast", "standard"]);
  });

  it("never replays into a live consumer: a fast stream that fails after partial text is not retried", async () => {
    const { claude } = await provider();
    for (const call of ["json", "streamParse"] as const) {
      seen.length = 0;
      replies = [overloadedMidStream('{"a":'), ok()];
      const deltas: string[] = [];
      await expect(claude[call]({ ...req, onText: (d) => deltas.push(d) })).rejects.toThrow(/Overloaded/);
      expect(deltas.join("")).toBe('{"a":');
      expect(seen).toHaveLength(1);
      (await import("@overclock/models")).resetFastModePause();
    }
  });

  it("leaves helper-role calls at standard speed", async () => {
    const { claude } = await provider();
    replies = [ok()];
    await claude.json({ ...req, role: "helper" });
    expect(seen[0]!.body).not.toHaveProperty("speed");
  });
});
