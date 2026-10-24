/**
 * TEST-ONLY replay server. Serves the Overclock engine HTTP API (and a sliver of the arena admin
 * API) from a JSONL file of RunEvents so the dashboard can be developed and tested without the
 * real engine. It never runs anything: events are released on a clock (scaled by --speed) and
 * can be held at a seq number through the /__replay control endpoints.
 *
 *   pnpm exec tsx tests/e2e/fixtures/replay-server.ts [--port 4010] [--arena-port 4110]
 *        [--events tests/e2e/fixtures/synthetic-run.jsonl] [--speed 1] [--hold <seq>]
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { RunConfigSchema, applyEvent, createRunView, deriveMetrics } from "@overclock/contracts";
import type { BenchmarkResultFile, CheckResult, PublicScenario, RunEvent, RunListItem, RunStatus } from "@overclock/contracts";
import { generateBenchmarkFile, generateSyntheticRun } from "./synthetic-run";

const dir = import.meta.dirname;
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : (process.env[`REPLAY_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback);
};
const PORT = Number(arg("port", "4010"));
const ARENA_PORT = Number(arg("arena-port", "4110"));
const EVENTS_FILE = path.resolve(arg("events", path.join(dir, "synthetic-run.jsonl")));
const EXTRAS_FILE = EVENTS_FILE.replace(/\.jsonl$/, ".extras.json");
const BENCH_FILE = path.join(dir, "synthetic-benchmark.json");

interface Extras {
  artifacts: Record<string, unknown>;
  program: unknown;
  scenario: PublicScenario;
  check: CheckResult;
}

function loadFixture(): { events: RunEvent[]; extras: Extras } {
  if (!existsSync(EVENTS_FILE)) {
    const run = generateSyntheticRun();
    return { events: run.events, extras: run };
  }
  const events = readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunEvent);
  const extras = existsSync(EXTRAS_FILE) ? (JSON.parse(readFileSync(EXTRAS_FILE, "utf8")) as Extras) : (generateSyntheticRun() as Extras);
  return { events, extras };
}

const fixture = loadFixture();
const benchmark: BenchmarkResultFile = existsSync(BENCH_FILE) ? (JSON.parse(readFileSync(BENCH_FILE, "utf8")) as BenchmarkResultFile) : generateBenchmarkFile();

/** One replayed run: a fixed event list released on a clock. */
class Replay {
  readonly events: RunEvent[];
  private startedAt = Date.now();
  speed: number;
  holdAt: number | null;
  private released = 0;
  private readonly clients = new Set<ServerResponse>();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    readonly runId: string,
    events: RunEvent[],
    readonly createdAt: number,
    speed: number,
    holdAt: number | null,
  ) {
    this.events = events.map((e) => ({ ...e, runId }));
    this.speed = speed;
    this.holdAt = holdAt;
    this.timer = setInterval(() => this.tick(), 20);
  }

  reset(speed: number, holdAt: number | null): void {
    this.startedAt = Date.now();
    this.speed = speed;
    this.holdAt = holdAt;
    this.released = 0;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  /** Number of events released so far (all events with seq <= this are visible). */
  releasedSeq(): number {
    const elapsed = (Date.now() - this.startedAt) * this.speed;
    let n = this.released;
    while (n < this.events.length && this.events[n]!.t <= elapsed) n++;
    if (this.holdAt !== null) n = Math.min(n, this.holdAt);
    return Math.max(this.released, n);
  }

  done(): boolean {
    return this.released >= this.events.length;
  }

  private tick(): void {
    const next = this.releasedSeq();
    if (next === this.released) return;
    const batch = this.events.slice(this.released, next);
    this.released = next;
    for (const c of this.clients) for (const e of batch) writeEvent(c, e);
    if (this.done()) for (const c of this.clients) endStream(c);
  }

  page(after: number, limit: number): RunEvent[] {
    const upto = this.releasedSeq();
    return this.events.slice(Math.max(0, after), Math.min(upto, after + limit));
  }

  stream(res: ServerResponse, after: number): void {
    const upto = this.releasedSeq();
    for (const e of this.events.slice(Math.max(0, after), upto)) writeEvent(res, e);
    if (upto >= this.events.length) return endStream(res);
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  view() {
    const v = createRunView(this.runId);
    for (const e of this.events.slice(0, this.releasedSeq())) applyEvent(v, e);
    return v;
  }

  status(): RunStatus {
    return this.view().status;
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}

function writeEvent(res: ServerResponse, e: RunEvent): void {
  res.write(`event: run-event\nid: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
}
function endStream(res: ServerResponse): void {
  res.write("event: end\ndata: {}\n\n");
  res.end();
}

const runs = new Map<string, Replay>();
const main = new Replay(fixture.events[0]?.runId ?? "run-replay-0001", fixture.events, Date.now() - 60_000, Number(arg("speed", "1")), arg("hold", "") ? Number(arg("hold", "")) : null);
runs.set(main.runId, main);

function cors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (typeof origin === "string" && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type,last-event-id");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

function thumbSvg(workerId: string, version: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#0d1218"/><rect x="0" y="0" width="320" height="22" fill="#18202a"/><rect x="16" y="40" width="180" height="10" rx="2" fill="#2a3440"/><rect x="16" y="60" width="288" height="8" rx="2" fill="#1f2730"/><rect x="16" y="74" width="288" height="8" rx="2" fill="#1f2730"/><rect x="16" y="88" width="240" height="8" rx="2" fill="#1f2730"/><rect x="16" y="150" width="70" height="24" rx="4" fill="#3d8bff"/><text x="12" y="15" font-family="monospace" font-size="11" fill="#9aa6b4">replay frame · ${workerId} · v${version}</text></svg>`;
}

const engine = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  void handleEngine(req, res).catch((err: unknown) => json(res, 500, { error: err instanceof Error ? err.message : String(err) }));
});

async function handleEngine(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (url.pathname === "/__replay/state") return json(res, 200, { runId: main.runId, releasedSeq: main.releasedSeq(), total: main.events.length, holdAt: main.holdAt, speed: main.speed });
  if (url.pathname === "/__replay/events") return json(res, 200, main.events);
  if (url.pathname === "/__replay/control" && method === "POST") {
    const b = (await readBody(req)) as { action?: string; holdAt?: number | null; speed?: number };
    if (b.action === "reset") main.reset(b.speed ?? main.speed, b.holdAt ?? null);
    else if (b.action === "hold") main.holdAt = b.holdAt ?? main.releasedSeq();
    else if (b.action === "release") main.holdAt = null;
    else return json(res, 400, { error: "action must be reset, hold or release" });
    return json(res, 200, { releasedSeq: main.releasedSeq(), holdAt: main.holdAt, speed: main.speed });
  }

  if (url.pathname === "/api/health") return json(res, 200, { ok: true, version: "replay-fixture", capabilities: { anthropic: { available: true, plannerModel: "claude-opus-5-5", helperModel: "claude-haiku-5-5" }, typesafe: { available: true, model: "jev-latest", visionModel: "jev-preview" }, browser: { available: false, reason: "replay fixture: no browser" } } });
  if (url.pathname === "/api/benchmarks") return json(res, 200, [{ name: "fixture-benchmark", suite: benchmark.suite, createdAt: benchmark.createdAt, runs: benchmark.runs.length }]);
  if (parts[0] === "api" && parts[1] === "benchmarks" && parts[2]) return parts[2] === "fixture-benchmark" ? json(res, 200, benchmark) : json(res, 404, { error: "Not found" });

  if (url.pathname === "/api/runs" && method === "GET") {
    const list: RunListItem[] = [...runs.values()].map((r) => {
      const v = r.view();
      return { runId: r.runId, status: v.status, mode: v.mode ?? "overclock", goal: v.goal ?? "", createdAt: r.createdAt, label: "replay fixture", summary: v.summary };
    });
    return json(res, 200, list);
  }
  if (url.pathname === "/api/runs" && method === "POST") {
    const config = RunConfigSchema.safeParse(await readBody(req));
    if (!config.success) return json(res, 400, { error: "Invalid run config", issues: config.error.issues });
    const runId = `run-replay-${String(runs.size + 1).padStart(4, "0")}`;
    const events = fixture.events.map((e) => (e.type === "run.created" ? { ...e, config: config.data } : e));
    runs.set(runId, new Replay(runId, events, Date.now(), main.speed, null));
    return json(res, 201, { runId, status: "pending" });
  }

  if (parts[0] !== "api" || parts[1] !== "runs" || !parts[2]) return json(res, 404, { error: "Not found" });
  const run = runs.get(parts[2]);
  if (!run) return json(res, 404, { error: `Unknown run ${parts[2]}` });
  const rest = parts.slice(3);

  if (rest.length === 0) return json(res, 200, { runId: run.runId, status: run.status(), view: run.view() });
  switch (rest[0]) {
    case "events": {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Math.min(5000, Number(url.searchParams.get("limit") ?? 1000));
      const events = run.page(after, limit);
      return json(res, 200, { runId: run.runId, events, nextSeq: events.at(-1)?.seq ?? after });
    }
    case "stream": {
      const lastId = req.headers["last-event-id"];
      const after = typeof lastId === "string" && lastId ? Number(lastId) : Number(url.searchParams.get("after") ?? 0);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": replay\n\n");
      return run.stream(res, after);
    }
    case "pause":
      run.holdAt = run.releasedSeq();
      return json(res, 200, { ok: true });
    case "resume":
      run.holdAt = null;
      return json(res, 200, { ok: true });
    case "cancel":
    case "approvals":
      return json(res, 200, { ok: true, note: "replay fixture: no effect" });
    case "result": {
      const v = run.view();
      return json(res, 200, { runId: run.runId, status: v.status, summary: v.summary ?? null, outcomes: [], verificationSemantics: "replay fixture" });
    }
    case "metrics":
      return json(res, 200, deriveMetrics(run.view()));
    case "program":
      return run.view().program ? json(res, 200, fixture.extras.program) : json(res, 404, { error: "Not compiled yet" });
    case "artifacts": {
      const a = rest[1] ? fixture.extras.artifacts[rest[1]] : undefined;
      return a === undefined ? json(res, 404, { error: "Unknown artifact" }) : json(res, 200, a);
    }
    case "workers": {
      if (rest[2] !== "thumb.jpg" || !rest[1]) break;
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" });
      return void res.end(thumbSvg(rest[1], url.searchParams.get("v") ?? "0"));
    }
  }
  return json(res, 404, { error: "Not found" });
}

/** Minimal arena admin stand-in so the scenario loader, checker and judge buttons have something to call. */
const arena = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${ARENA_PORT}`);
  const method = req.method ?? "GET";
  if (url.pathname === "/api/scenario" && method === "GET") return json(res, 200, fixture.extras.scenario);
  if (url.pathname === "/api/scenario" && method === "POST") return json(res, 200, fixture.extras.scenario);
  if (url.pathname === "/api/check") return json(res, 200, { ...fixture.extras.check, checkedAt: Date.now() });
  if (url.pathname === "/api/judge/surprise" && method === "POST") return void readBody(req).then((b) => json(res, 200, { replay: true, applied: b }));
  if (url.pathname === "/api/judge/edit-unprocessed" && method === "POST") return json(res, 200, { replay: true, recordKey: "ORD-1059", entity: "order", id: "ORD-1059", patch: { status: "refunded" } });
  return json(res, 404, { error: "Not found" });
});

engine.listen(PORT, "127.0.0.1", () => console.log(`[replay] engine API on http://127.0.0.1:${PORT} · ${main.events.length} events · run ${main.runId} · speed ${main.speed}`));
arena.listen(ARENA_PORT, "127.0.0.1", () => console.log(`[replay] arena admin on http://127.0.0.1:${ARENA_PORT}`));
