import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApprovalDecision, RunConfigSchema, type RunEvent } from "@overclock/contracts";
import { parseLastEventId, streamRun, type SseStream } from "./sse";
import type { RunHandle, RunManager } from "./types";
import { WorkflowError, type WorkflowApp, type WorkflowService } from "./workflows";

/**
 * The Chrome extension's gateway: `/api/x/*`, separate from the dashboard's localhost API.
 *
 * - **Pairing:** the engine shows a one-time code (console and `<dataDir>/extension-pairing-code`).
 *   The extension exchanges it for a session token. A code works once, expires, and is replaced
 *   after a few wrong guesses.
 * - **Every other route needs that token** (`Authorization: Bearer`), and only sees runs it
 *   started.
 * - **Requests from web pages are refused:** an Origin header, when present, must be a Chrome
 *   extension's (optionally one pinned id), and the Host must be loopback, which defeats DNS
 *   rebinding. CORS is granted only to the extension origin.
 * - **Runs are re-derived on the engine** from an approved preview (see workflows.ts): the
 *   extension can't send its own run configuration, applications, or knowledge policy, and it
 *   never publishes to the Overclock Network.
 */

export const EXTENSION_PREFIX = "/api/x/";
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class ExtensionAccess {
  private code = { value: "", expiresAt: 0, failures: 0 };
  private readonly tokens = new Map<string, number>();
  private readonly codeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxFailures: number;

  constructor(private readonly o: { now?: () => number; codeTtlMs?: number; tokenTtlMs?: number; maxFailures?: number; onCode?: (code: string, expiresAt: number) => void } = {}) {
    this.codeTtlMs = o.codeTtlMs ?? 30 * 60_000;
    this.tokenTtlMs = o.tokenTtlMs ?? 12 * 60 * 60_000;
    this.maxFailures = o.maxFailures ?? 5;
    this.rotate();
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** A fresh code (12 characters, about 60 bits), replacing the previous one. */
  rotate(): string {
    const chars = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!).join("");
    this.code = { value: chars, expiresAt: this.now() + this.codeTtlMs, failures: 0 };
    this.o.onCode?.(this.display(), this.code.expiresAt);
    return this.display();
  }

  private display(): string {
    return `${this.code.value.slice(0, 4)}-${this.code.value.slice(4, 8)}-${this.code.value.slice(8)}`;
  }

  currentCode(): string {
    if (this.now() >= this.code.expiresAt) this.rotate();
    return this.display();
  }

  /** Exchange a pairing code for a session token; null when the code is wrong or expired. */
  pair(input: string): { token: string; expiresAt: number } | null {
    if (this.now() >= this.code.expiresAt) {
      this.rotate();
      return null;
    }
    const given = Buffer.from(input.toUpperCase().replace(/[^A-Z0-9]/g, "").padEnd(12, " ").slice(0, 12));
    const ok = timingSafeEqual(given, Buffer.from(this.code.value));
    if (!ok) {
      if (++this.code.failures >= this.maxFailures) this.rotate();
      return null;
    }
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.now() + this.tokenTtlMs;
    this.tokens.set(token, expiresAt);
    this.rotate(); // single use
    return { token, expiresAt };
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const exp = this.tokens.get(token);
    if (exp === undefined) return false;
    if (this.now() >= exp) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
}

export interface ExtensionStatus {
  version: string;
  /** Which browser executes tasks: always this engine's own, never the user's Chrome tabs. */
  browser: { kind: "overclock-chromium"; visible: boolean; available: boolean };
  planning: { available: boolean };
  network: { enabled: boolean; connected: boolean };
  environment: { label: string; applications: WorkflowApp[] };
}

export interface ExtensionRoutesOptions {
  manager: RunManager;
  workflows: WorkflowService;
  access: ExtensionAccess;
  status(): Promise<ExtensionStatus>;
  streams: Set<SseStream>;
  heartbeatMs?: number | undefined;
  /** Accept only this extension id (otherwise any `chrome-extension://` origin with a token). */
  extensionId?: string | undefined;
}

const PairBody = z.object({ code: z.string().min(1).max(40) });
const PreviewBody = z.object({
  workflowId: z.string().max(400).optional(),
  instructions: z.string().max(8000).optional(),
  applications: z.array(z.string().max(80)).max(10).optional(),
  records: z.array(z.record(z.string(), z.unknown())).max(1000),
});
const RunBody = PreviewBody.extend({ previewId: z.string().min(1).max(64), allowModelCalls: z.boolean().optional() });
const StreamQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

class GatewayError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new GatewayError(400, r.error.issues[0] ? `${r.error.issues[0].path.join(".") || "body"}: ${r.error.issues[0].message}` : "invalid request");
  return r.data;
}

function corsFor(origin: string): Record<string, string> {
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

/** Receipts with their read-back fields, from a run's events. */
function receiptsOf(events: RunEvent[]): { taskId: string; recordKey: string; nodeId: string; status: string; fields: { name: string; expected: unknown; actual: unknown }[] }[] {
  return events.flatMap((e) => (e.type === "receipt" ? [{ taskId: e.taskId, recordKey: e.recordKey, nodeId: e.nodeId, status: e.status, fields: (e.fields ?? []).map((f) => ({ name: f.name, expected: f.expected, actual: f.actual })) }] : []));
}

export function registerExtensionRoutes(app: FastifyInstance, o: ExtensionRoutesOptions): void {
  const owned = new Set<string>();

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith(EXTENSION_PREFIX)) return;
    const host = req.headers.host ?? "";
    if (!LOOPBACK_HOST.test(host)) return reply.code(403).send({ error: "This API answers only on 127.0.0.1 or localhost." });
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const m = EXTENSION_ORIGIN.exec(origin);
      if (!m || (o.extensionId && m[1] !== o.extensionId)) return reply.code(403).send({ error: "This API is for the Overclock Chrome extension." });
      for (const [k, v] of Object.entries(corsFor(origin))) reply.header(k, v);
    }
    if (req.method === "OPTIONS") {
      if (origin !== undefined) {
        reply.header("access-control-allow-methods", "GET, POST, OPTIONS");
        reply.header("access-control-allow-headers", "authorization, content-type, last-event-id");
        reply.header("access-control-max-age", "600");
      }
      return reply.code(204).send();
    }
    if (req.url === `${EXTENSION_PREFIX}pair`) return;
    const auth = req.headers.authorization;
    const token = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
    if (!o.access.verify(token)) return reply.code(401).send({ error: "Pair the extension with this engine first." });
  });

  const handle = (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) => async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof GatewayError || err instanceof WorkflowError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  };

  const ownedRun = (id: string): RunHandle => {
    const h = owned.has(id) ? o.manager.get(id) : undefined;
    if (!h) throw new GatewayError(404, "No run with that id was started from the extension.");
    return h;
  };

  app.post(
    `${EXTENSION_PREFIX}pair`,
    handle(async (req) => {
      const body = parse(PairBody, req.body);
      const session = o.access.pair(body.code);
      if (!session) throw new GatewayError(401, "That code didn't match. Use the current code from the engine's terminal.");
      return session;
    }),
  );

  app.get(`${EXTENSION_PREFIX}status`, handle(async () => o.status()));

  app.get(
    `${EXTENSION_PREFIX}workflows`,
    handle(async () => ({ workflows: o.workflows.list(), applications: o.workflows.applications() })),
  );

  app.post(
    `${EXTENSION_PREFIX}preview`,
    handle(async (req) => o.workflows.preview(parse(PreviewBody, req.body))),
  );

  app.post(
    `${EXTENSION_PREFIX}runs`,
    handle(async (req, reply) => {
      const body = parse(RunBody, req.body);
      const config = RunConfigSchema.parse(await o.workflows.runConfig(body));
      const h = await o.manager.create(config);
      owned.add(h.runId);
      return reply.code(201).send({ runId: h.runId, status: h.status() });
    }),
  );

  app.get<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}runs/:id`,
    handle(async (req) => {
      const h = ownedRun((req.params as { id: string }).id);
      return { runId: h.runId, status: h.status(), view: h.view() };
    }),
  );

  app.get<{ Params: { id: string } }>(`${EXTENSION_PREFIX}runs/:id/stream`, async (req, reply) => {
    let h: RunHandle;
    try {
      h = ownedRun(req.params.id);
    } catch (err) {
      return reply.code((err as GatewayError).statusCode).send({ error: (err as Error).message });
    }
    const q = StreamQuery.safeParse(req.query);
    const after = Math.max(q.success ? q.data.after : 0, parseLastEventId(req.headers["last-event-id"]));
    const origin = req.headers.origin;
    reply.hijack();
    const stream = streamRun(reply.raw, h, { after, headers: origin ? corsFor(origin) : {}, heartbeatMs: o.heartbeatMs });
    o.streams.add(stream);
    void stream.done.then(() => o.streams.delete(stream));
  });

  app.get<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}runs/:id/result`,
    handle(async (req) => {
      const h = ownedRun((req.params as { id: string }).id);
      return { ...h.result(), receipts: receiptsOf(h.events(0, 100_000)) };
    }),
  );

  app.post<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}runs/:id/approvals`,
    handle(async (req) => {
      const h = ownedRun((req.params as { id: string }).id);
      const d = parse(ApprovalDecision, req.body);
      return { ok: h.approve(d.approvalId, d.approved) };
    }),
  );

  app.post<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}runs/:id/cancel`,
    handle(async (req) => {
      const h = ownedRun((req.params as { id: string }).id);
      if (["completed", "failed", "cancelled"].includes(h.status())) return { ok: false, status: h.status() };
      h.cancel("cancelled from the extension");
      return { ok: true, status: h.status() };
    }),
  );

  app.get<{ Params: { id: string; workerId: string } }>(
    `${EXTENSION_PREFIX}runs/:id/workers/:workerId/thumb.jpg`,
    handle(async (req, reply) => {
      const p = req.params as { id: string; workerId: string };
      const jpeg = ownedRun(p.id).thumbnail(p.workerId);
      if (!jpeg) throw new GatewayError(404, "no thumbnail yet");
      return reply.type("image/jpeg").header("cache-control", "no-store").send(jpeg);
    }),
  );
}
