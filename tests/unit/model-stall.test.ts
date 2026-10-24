import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * A model stream that stops sending data must fail instead of hanging the run (seen live: a
 * repair request stalled for 38 minutes during a network outage). The fake server below speaks
 * just enough of the Messages streaming protocol to start a stream, then goes silent.
 */

let server: Server;
let requests = 0;
let sendText = false;
const saved = { ...process.env };

beforeAll(async () => {
  server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const msg = { type: "message", id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } };
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: msg })}\n\n`);
    if (sendText) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"a":' } })}\n\n`);
    }
    // ...and then nothing: the connection stays open without data.
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.OVERCLOCK_MODEL_STREAM_IDLE_MS = "400";
});
afterAll(async () => {
  process.env = { ...saved };
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function provider() {
  // Imported after the environment is set: the idle limit is read at module load.
  const { ClaudeProvider, ModelLedger, ModelStallError, claudeConfigFromEnv } = await import("@overclock/models");
  return { claude: new ClaudeProvider(claudeConfigFromEnv(), new ModelLedger(undefined)), ModelStallError };
}

describe("model stream stall watchdog", () => {
  it("fails a silent stream after the idle limit, retrying once first", async () => {
    const { claude, ModelStallError } = await provider();
    requests = 0;
    sendText = false;
    const t0 = performance.now();
    await expect(claude.json({ role: "planner", purpose: "test", system: "s", user: "u", schema: z.object({ a: z.number() }) })).rejects.toBeInstanceOf(ModelStallError);
    expect(requests).toBe(2);
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("does not retry once text reached a live consumer", async () => {
    const { claude, ModelStallError } = await provider();
    requests = 0;
    sendText = true;
    const seen: string[] = [];
    await expect(claude.json({ role: "planner", purpose: "test", system: "s", user: "u", schema: z.object({ a: z.number() }), onText: (d) => seen.push(d) })).rejects.toBeInstanceOf(ModelStallError);
    expect(seen.join("")).toBe('{"a":');
    expect(requests).toBe(1);
  });
});
