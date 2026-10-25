import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgentStepRequest, ApprovalDecision, RunConfigSchema, type RunEvent } from "@overclock/contracts";
import { AgentError, type BrowserAgentService } from "./agent";
import { GOOGLE_CALLBACK_PATH, GoogleError, type GoogleAccount, type GoogleStatus } from "./google";
import { parseLastEventId, streamRun, type SseStream } from "./sse";
import type { RunHandle, RunManager } from "./types";
import { WorkflowError, type WorkflowApp, type WorkflowService } from "./workflows";

/**
 * The Chrome extension's gateway: `/api/x/*`, separate from the dashboard's localhost API.
 *
 * - **Pairing:** the engine shows a one-time code (console and `<dataDir>/extension-pairing-code`).
 *   The extension exchanges it for a session token. A code works once, expires, and is replaced
 *   after a few wrong guesses. Pairing with a code also trusts that extension's id; a trusted
 *   extension (or the one built in this repo, whose unpacked id follows from its folder) gets a
 *   token without a code. Web pages can't send a `chrome-extension://` Origin, and other
 *   extensions have other ids.
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

/**
 * The id Chrome and Brave give an unpacked extension: the SHA-256 of its folder's absolute path,
 * first 32 hex digits, written with the letters a–p.
 */
export function unpackedExtensionId(folder: string): string {
  return [...createHash("sha256").update(folder).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class ExtensionAccess {
  private code = { value: "", expiresAt: 0, failures: 0 };
  /** Token hashes and their expiry: a copy of the file can't be replayed as a token. */
  private readonly tokens = new Map<string, number>();
  private readonly trusted: Set<string>;
  private readonly codeTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxFailures: number;

  constructor(
    private readonly o: {
      now?: () => number;
      codeTtlMs?: number;
      tokenTtlMs?: number;
      maxFailures?: number;
      onCode?: (code: string, expiresAt: number) => void;
      /** Keeps trusted extension ids and session tokens across engine restarts (mode 0600). */
      file?: string;
      /** Extension ids that get a token without a code. */
      trusted?: string[];
    } = {},
  ) {
    this.codeTtlMs = o.codeTtlMs ?? 30 * 60_000;
    this.tokenTtlMs = o.tokenTtlMs ?? 30 * 24 * 60 * 60_000;
    this.maxFailures = o.maxFailures ?? 5;
    this.trusted = new Set(o.trusted ?? []);
    if (o.file && existsSync(o.file)) {
      try {
        const saved = JSON.parse(readFileSync(o.file, "utf8")) as { trusted?: string[]; tokens?: Record<string, number> };
        for (const id of saved.trusted ?? []) this.trusted.add(id);
        for (const [h, exp] of Object.entries(saved.tokens ?? {})) if (exp > this.now()) this.tokens.set(h, exp);
      } catch {
        // unreadable: start fresh
      }
    }
    this.rotate();
  }

  private save(): void {
    if (!this.o.file) return;
    writeFileSync(this.o.file, JSON.stringify({ trusted: [...this.trusted], tokens: Object.fromEntries(this.tokens) }), { mode: 0o600 });
  }

  private issue(): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString("hex");
    const expiresAt = this.now() + this.tokenTtlMs;
    this.tokens.set(hashToken(token), expiresAt);
    this.save();
    return { token, expiresAt };
  }

  /** A token for an extension that paired before (or is trusted by configuration); null otherwise. */
  autoPair(extensionId: string | undefined): { token: string; expiresAt: number } | null {
    return extensionId && this.trusted.has(extensionId) ? this.issue() : null;
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

  /** Exchange a pairing code for a session token (and trust the extension); null when the code is wrong or expired. */
  pair(input: string, extensionId?: string): { token: string; expiresAt: number } | null {
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
    if (extensionId) this.trusted.add(extensionId);
    const session = this.issue();
    this.rotate(); // single use
    return session;
  }

  verify(token: string | undefined): boolean {
    if (!token) return false;
    const h = hashToken(token);
    const exp = this.tokens.get(h);
    if (exp === undefined) return false;
    if (this.now() >= exp) {
      this.tokens.delete(h);
      this.save();
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
  /** In-browser tasks ("Ask"): the extension acts in the user's own tabs; the engine picks each action. */
  agent: { available: boolean; model: string | null };
  /** The Google account in-browser tasks read Gmail and create Docs with. */
  google: GoogleStatus;
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
  /** In-browser tasks; absent: not served. */
  agent?: BrowserAgentService | undefined;
  /** Google sign-in for in-browser tasks; absent: not served. */
  google?: GoogleAccount | undefined;
}

const PairBody = z.object({ code: z.string().max(40).optional() });
const PreviewBody = z.object({
  workflowId: z.string().max(400).optional(),
  instructions: z.string().max(8000).optional(),
  applications: z.array(z.string().max(80)).max(10).optional(),
  records: z.array(z.record(z.string(), z.unknown())).max(1000),
});
const RunBody = PreviewBody.extend({ previewId: z.string().min(1).max(64), allowModelCalls: z.boolean().optional() });
const AgentTaskBody = z.object({ task: z.string().trim().min(1).max(4000) });
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
      if (err instanceof GatewayError || err instanceof WorkflowError || err instanceof AgentError || err instanceof GoogleError) return reply.code(err.statusCode).send({ error: err.message });
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
      const extensionId = EXTENSION_ORIGIN.exec(req.headers.origin ?? "")?.[1];
      if (!body.code?.trim()) {
        const session = o.access.autoPair(extensionId);
        if (!session) throw new GatewayError(401, "Pair once with the code from the engine's terminal.");
        return session;
      }
      const session = o.access.pair(body.code, extensionId);
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

  // In-browser tasks: the extension reports what its tab shows; the engine answers with the next action.
  const agent = (): BrowserAgentService => {
    if (!o.agent) throw new GatewayError(404, "This engine doesn't run in-browser tasks.");
    return o.agent;
  };

  app.post(
    `${EXTENSION_PREFIX}agent/tasks`,
    handle(async (req, reply) => reply.code(201).send(agent().start(parse(AgentTaskBody, req.body).task))),
  );

  app.post<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}agent/tasks/:id/step`,
    handle(async (req) => agent().step((req.params as { id: string }).id, parse(AgentStepRequest, req.body))),
  );

  app.post<{ Params: { id: string } }>(
    `${EXTENSION_PREFIX}agent/tasks/:id/stop`,
    handle(async (req) => ({ ok: agent().stop((req.params as { id: string }).id) })),
  );

  // Google sign-in: the extension opens Google's consent page in a tab; Google redirects back to
  // the engine (a loopback address, checked by state and PKCE), which keeps the tokens.
  const google = (): GoogleAccount => {
    if (!o.google) throw new GatewayError(404, "This engine doesn't connect Google accounts.");
    return o.google;
  };

  app.post(
    `${EXTENSION_PREFIX}google/connect`,
    handle(async () => ({ url: google().beginConnect() })),
  );

  app.post(
    `${EXTENSION_PREFIX}google/disconnect`,
    handle(async () => {
      await google().disconnect();
      return { ok: true };
    }),
  );

  app.get(GOOGLE_CALLBACK_PATH, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    let title: string;
    let body: string;
    try {
      const email = await google().finishConnect({ code: q.code, state: q.state, error: q.error });
      title = "Google is connected";
      body = `Overclock can now read Gmail and create Google Docs as ${email}. You can close this tab and go back to Overclock.`;
    } catch (err) {
      reply.code(err instanceof GoogleError || err instanceof GatewayError ? err.statusCode : 500);
      title = "Google isn't connected";
      body = err instanceof Error ? err.message : String(err);
    }
    const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return reply
      .type("text/html; charset=utf-8")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#1d2330"><h1 style="font-size:22px">${esc(title)}</h1><p>${esc(body)}</p></body>`);
  });
}
