import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { ApprovalDecision, RunConfigSchema } from "@overclock/contracts";
import type { BenchmarkResultFile, CreateRunResponse, EventsPage, RunStatus, RunStatusResponse } from "@overclock/contracts";
import { EXTENSION_PREFIX, registerExtensionRoutes, type ExtensionRoutesOptions } from "./extension";
import { parseLastEventId, streamRun, type SseStream } from "./sse";
import type { RunHandle, RunManager } from "./types";

/**
 * Engine HTTP + SSE API. The server only talks to RunManager / RunHandle (types.ts); it holds
 * no run state of its own besides the set of open SSE streams.
 */

export interface EngineServerOptions {
  manager: RunManager;
  benchmarksDir: string;
  host?: string;
  /** 0 picks a free port. Defaults to OVERCLOCK_ENGINE_PORT or 4000. */
  port?: number;
  logger?: boolean;
  /** SSE heartbeat interval; defaults to 15 s. */
  heartbeatMs?: number;
  /** The Chrome extension's authenticated gateway (`/api/x/*`); absent: not served. */
  extension?: Omit<ExtensionRoutesOptions, "streams" | "heartbeatMs" | "manager"> | undefined;
}

export interface EngineServer {
  url: string;
  close(): Promise<void>;
  app: FastifyInstance;
}

export interface BenchmarkListItem {
  name: string;
  suite: string;
  createdAt: number;
  runs: number;
}

const BODY_LIMIT = 10 * 1024 * 1024;
const MAX_EVENTS_PAGE = 5000;
const ALLOWED_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const SAFE_HEADER_LIST = /^[A-Za-z0-9-]+(\s*,\s*[A-Za-z0-9-]+)*$/;
const TERMINAL_RUN: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const BENCHMARK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** An error whose message is safe to show to API clients. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const SeqParam = z.coerce.number().int().min(0);
const EventsQuery = z.object({ after: SeqParam.default(0), limit: z.coerce.number().int().min(1).default(1000) });
const StreamQuery = z.object({ after: SeqParam.default(0) });
const CancelBody = z.object({ reason: z.string().max(2000).optional() }).optional();

type IdParams = { Params: { id: string } };

function parseOr400<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, `invalid ${what}`, { issues: r.error.issues });
  return r.data;
}

function corsHeaders(req: FastifyRequest): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGIN.test(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

function sendJson(reply: FastifyReply, value: unknown): FastifyReply {
  return reply.type("application/json; charset=utf-8").send(JSON.stringify(value ?? null));
}

export async function listBenchmarks(dir: string): Promise<BenchmarkListItem[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const items = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (file): Promise<BenchmarkListItem | null> => {
        try {
          const data = JSON.parse(await readFile(join(dir, file), "utf8")) as Partial<BenchmarkResultFile>;
          if (typeof data.suite !== "string" || typeof data.createdAt !== "number" || !Array.isArray(data.runs)) return null;
          return { name: file.slice(0, -".json".length), suite: data.suite, createdAt: data.createdAt, runs: data.runs.length };
        } catch {
          return null; // unparsable or unreadable: skip
        }
      }),
  );
  return items.filter((x): x is BenchmarkListItem => x !== null).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}

/** Network demo reports in `dir`, newest first; files without the report shape are skipped. */
export async function listTransfers(dir: string): Promise<({ name: string; at: string } & Record<string, unknown>)[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const items = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (file): Promise<({ name: string; at: string } & Record<string, unknown>) | null> => {
        try {
          const data = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<string, unknown>;
          return typeof data.at === "string" && Array.isArray(data.checks) ? { ...data, name: file.slice(0, -".json".length), at: data.at } : null;
        } catch {
          return null;
        }
      }),
  );
  return items.filter((x) => x !== null).sort((a, b) => b.at.localeCompare(a.at));
}

/** Resolve a benchmark name to a file inside `dir`, rejecting anything that could escape it. */
export function benchmarkPath(dir: string, name: string): string {
  const base = name.endsWith(".json") ? name.slice(0, -".json".length) : name;
  if (!BENCHMARK_NAME.test(base) || base.includes("..")) throw new HttpError(400, "invalid benchmark name");
  const root = resolve(dir);
  const file = resolve(root, `${base}.json`);
  if (!file.startsWith(root + sep)) throw new HttpError(400, "invalid benchmark name");
  return file;
}

export async function createEngineServer(opts: EngineServerOptions): Promise<EngineServer> {
  const { manager } = opts;
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: BODY_LIMIT });
  const streams = new Set<SseStream>();

  const runOr404 = (id: string): RunHandle => {
    const h = manager.get(id);
    if (!h) throw new HttpError(404, `run ${id} not found`);
    return h;
  };

  // JSON bodies: same parser as Fastify's default, but an empty body (e.g. POST .../cancel sent
  // with a JSON content-type and no payload) is accepted as "no body".
  const defaultJson = app.getDefaultJsonParser("error", "ignore");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: BODY_LIMIT }, (req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    // getDefaultJsonParser always returns the callback form.
    (defaultJson as (r: typeof req, b: string, d: typeof done) => void)(req, text, done);
  });

  // CORS for local dev origins (any port), including preflight for every route. The extension
  // gateway has its own origin, host, and token checks (extension.ts).
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith(EXTENSION_PREFIX)) return;
    const headers = corsHeaders(req);
    for (const [k, v] of Object.entries(headers)) reply.header(k, v);
    if (req.method !== "OPTIONS") return;
    if (headers["access-control-allow-origin"]) {
      const requested = req.headers["access-control-request-headers"];
      reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
      reply.header("access-control-allow-headers", typeof requested === "string" && SAFE_HEADER_LIST.test(requested) ? requested : "content-type, last-event-id");
      reply.header("access-control-max-age", "600");
    }
    await reply.code(204).send();
    return reply;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, ...err.extra });
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.code(status).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: typeof e.message === "string" ? e.message : "bad request" });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not found" }));

  // ------------------------------------------------------------------ runs

  app.get("/api/health", async () => manager.health());

  app.post("/api/runs", async (req, reply) => {
    const config = parseOr400(RunConfigSchema, req.body, "run config");
    const handle = await manager.create(config);
    const body: CreateRunResponse = { runId: handle.runId, status: handle.status() };
    return reply.code(201).send(body);
  });

  app.get("/api/runs", async () => manager.list());

  app.get<IdParams>("/api/runs/:id", async (req) => {
    const h = runOr404(req.params.id);
    const body: RunStatusResponse = { runId: h.runId, status: h.status(), view: h.view() };
    return body;
  });

  app.get<IdParams>("/api/runs/:id/events", async (req) => {
    const h = runOr404(req.params.id);
    const q = parseOr400(EventsQuery, req.query, "query");
    const events = h.events(q.after, Math.min(q.limit, MAX_EVENTS_PAGE));
    const body: EventsPage = { runId: h.runId, events, nextSeq: events.at(-1)?.seq ?? q.after };
    return body;
  });

  app.get<IdParams>("/api/runs/:id/stream", async (req, reply) => {
    const h = runOr404(req.params.id);
    const q = parseOr400(StreamQuery, req.query, "query");
    const after = Math.max(q.after, parseLastEventId(req.headers["last-event-id"]));
    reply.hijack();
    const stream = streamRun(reply.raw, h, { after, headers: corsHeaders(req), heartbeatMs: opts.heartbeatMs });
    streams.add(stream);
    void stream.done.then(() => streams.delete(stream));
  });

  app.post<IdParams>("/api/runs/:id/cancel", async (req) => {
    const h = runOr404(req.params.id);
    const body = parseOr400(CancelBody, req.body, "body");
    if (TERMINAL_RUN.has(h.status())) return { ok: false, status: h.status() };
    h.cancel(body?.reason);
    return { ok: true, status: h.status() };
  });

  app.post<IdParams>("/api/runs/:id/pause", async (req) => {
    const h = runOr404(req.params.id);
    if (TERMINAL_RUN.has(h.status())) return { ok: false, status: h.status() };
    h.pause();
    return { ok: true, status: h.status() };
  });

  app.post<IdParams>("/api/runs/:id/resume", async (req) => {
    const h = runOr404(req.params.id);
    if (TERMINAL_RUN.has(h.status())) return { ok: false, status: h.status() };
    h.resume();
    return { ok: true, status: h.status() };
  });

  app.post<IdParams>("/api/runs/:id/approvals", async (req) => {
    const h = runOr404(req.params.id);
    const d = parseOr400(ApprovalDecision, req.body, "approval decision");
    return { ok: h.approve(d.approvalId, d.approved) };
  });

  app.get<IdParams>("/api/runs/:id/result", async (req) => runOr404(req.params.id).result());

  app.get<IdParams>("/api/runs/:id/metrics", async (req, reply) => sendJson(reply, runOr404(req.params.id).metrics()));

  app.get<IdParams>("/api/runs/:id/trace", async (req, reply) => sendJson(reply, runOr404(req.params.id).trace()));

  app.get<IdParams>("/api/runs/:id/program", async (req, reply) => {
    const program = runOr404(req.params.id).program();
    if (program === undefined) throw new HttpError(404, "program not compiled yet");
    return sendJson(reply, program);
  });

  app.get<{ Params: { id: string; artifactId: string } }>("/api/runs/:id/artifacts/:artifactId", async (req, reply) => {
    const artifact = runOr404(req.params.id).artifact(req.params.artifactId);
    if (artifact === undefined) throw new HttpError(404, `artifact ${req.params.artifactId} not found`);
    return sendJson(reply, artifact);
  });

  app.get<{ Params: { id: string; workerId: string } }>("/api/runs/:id/workers/:workerId/thumb.jpg", async (req, reply) => {
    const jpeg = runOr404(req.params.id).thumbnail(req.params.workerId);
    if (!jpeg) throw new HttpError(404, "no thumbnail");
    return reply.type("image/jpeg").header("cache-control", "no-store").send(jpeg);
  });

  // ------------------------------------------------------------ benchmarks

  app.get("/api/benchmarks", async () => listBenchmarks(opts.benchmarksDir));

  app.get<{ Params: { name: string } }>("/api/benchmarks/:name", async (req, reply) => {
    const file = benchmarkPath(opts.benchmarksDir, req.params.name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      throw new HttpError(404, "benchmark not found");
    }
    try {
      JSON.parse(text);
    } catch {
      throw new HttpError(500, "benchmark file is not valid JSON");
    }
    return reply.type("application/json; charset=utf-8").send(text);
  });

  // Recorded network transfer demos (A learns, B imports): one report per `pnpm network:demo` run.
  app.get("/api/transfers", async () => listTransfers(join(opts.benchmarksDir, "network")));

  if (opts.extension) registerExtensionRoutes(app, { ...opts.extension, manager, streams, heartbeatMs: opts.heartbeatMs });

  // ------------------------------------------------------------- lifecycle

  // Open SSE streams would keep server.close() waiting forever; end them first. Clients see the
  // stream drop without `end` and resume with Last-Event-ID.
  app.addHook("preClose", (done) => {
    for (const s of streams) s.close();
    done();
  });

  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? (Number(process.env.OVERCLOCK_ENGINE_PORT) || 4000);
  await app.listen({ host, port });
  const addr = app.server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;

  return {
    url: `http://${urlHost}:${actualPort}`,
    app,
    close: () => app.close(),
  };
}
