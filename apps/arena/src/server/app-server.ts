import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { APP_NAMES, type AppName, type ClassicApp } from "../data/apps";
import type { ScenarioManager } from "../data/scenario";
import type { ArenaStore } from "../data/store";
import { html } from "./html";
import type { StatsRegistry } from "./stats";
import { BRANDS, errorBody, renderLogin, renderPage, type AppBrand, type PageOptions, type Ui } from "./ui";
import { latencyFor, renameFor, type VariationStore } from "./variations";

/**
 * Operators may change data. Viewers (discovery scouts exploring an unfamiliar app before
 * anything is authorized) see the same UI, but every state-changing request is refused.
 */
export type Role = "operator" | "viewer";

export interface Account {
  username: string;
  password: string;
  role: Role;
}

export interface RouteInfo {
  method: string;
  url: string;
}

/** Routes each app registered, recorded as they are added (used by the read-only audit). */
export class RouteRegistry {
  private readonly byApp = new Map<AppName, RouteInfo[]>();

  add(app: AppName, route: RouteInfo): void {
    (this.byApp.get(app) ?? this.byApp.set(app, []).get(app)!).push(route);
  }

  snapshot(): Record<AppName, RouteInfo[]> {
    return Object.fromEntries(APP_NAMES.map((a) => [a, [...(this.byApp.get(a) ?? [])]])) as Record<AppName, RouteInfo[]>;
  }
}

/** Everything the app servers share. */
export interface ServerContext {
  store: ArenaStore;
  manager: ScenarioManager;
  variations: VariationStore;
  stats: StatsRegistry;
  accounts: Account[];
  routes: RouteRegistry;
}

export interface Session {
  /** Non-secret id used for the per-session "What's new" dismissal cookie. */
  publicId: string;
  username: string;
  role: Role;
  createdAt: number;
}

/** In-memory sessions for one app (sessions are per app, like separate SaaS tools). */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(account: Account): string {
    const token = randomBytes(24).toString("base64url");
    this.sessions.set(token, { publicId: randomBytes(8).toString("hex"), username: account.username, role: account.role, createdAt: Date.now() });
    return token;
  }

  get(token: string | undefined): Session | undefined {
    return token ? this.sessions.get(token) : undefined;
  }

  delete(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

/** Constant-time check against every account (no early exit on the first match). */
export function authenticate(accounts: readonly Account[], username: string, password: string): Account | undefined {
  let found: Account | undefined;
  for (const a of accounts) {
    const ok = safeEqual(username, a.username) && safeEqual(password, a.password);
    if (ok && !found) found = a;
  }
  return found;
}

export const READ_ONLY_TITLE = "Read-only access";
export const READ_ONLY_MESSAGE = "Your account has view-only access, so this change was not saved. Sign in with an operator account to make changes.";

/** GET and HEAD are the only methods a viewer may use. */
export function isWriteMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** True when the client asked for JSON (fetch/XHR callers) rather than an HTML page. */
export function wantsJson(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? "");
  const type = String(req.headers["content-type"] ?? "");
  return type.includes("application/json") || (accept.includes("application/json") && !accept.includes("text/html"));
}

/**
 * Viewer write guard. Returns true (and counts the attempt) when the request must be refused;
 * the caller sends the 403 in its own format.
 */
export function deniesWrite(ctx: ServerContext, app: AppName, session: Session | undefined, method: string): boolean {
  if (!session || session.role !== "viewer" || !isWriteMethod(method)) return false;
  ctx.stats.of(app).deniedWrites++;
  return true;
}

export type WriteOutcome = "ok" | "failed-before-commit" | "failed-after-commit";

/** Run a state-changing write under the app's failure-injection variation and count it. */
export function commitWrite(ctx: ServerContext, app: AppName, write: () => void): WriteOutcome {
  const failures = ctx.variations.get().failures[app];
  if (failures && Math.random() < failures.beforeCommitRate) {
    ctx.stats.of(app).injectedBeforeCommit++;
    return "failed-before-commit";
  }
  write();
  ctx.stats.of(app).writes++;
  if (failures && Math.random() < failures.afterCommitRate) {
    ctx.stats.of(app).injectedAfterCommit++;
    return "failed-after-commit";
  }
  return "ok";
}

const TOO_MANY = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Too many requests</title></head><body><main><h1>Too many requests</h1><p>Please wait a moment and try again.</p></main></body></html>";

/** Records every route an app registers. Call before registering routes. */
export function installRouteRecorder(f: FastifyInstance, ctx: ServerContext, app: AppName): void {
  f.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) ctx.routes.add(app, { method: String(method), url: route.url ?? route.path ?? "" });
  });
}

/** Stats, concurrency limit, and latency, in that order, for every request. */
export function installTraffic(f: FastifyInstance, ctx: ServerContext, app: AppName): void {
  f.addHook("onRequest", async (req, reply) => {
    ctx.stats.of(app).requests++;
    const v = ctx.variations.get();
    const limit = v.concurrencyLimit[app];
    if (limit !== undefined && ctx.stats.of(app).inFlight >= limit) {
      ctx.stats.of(app).throttled429++;
      reply.code(429).header("retry-after", "1");
      if (wantsJson(req)) return reply.send({ error: "too_many_requests", message: "Too many requests. Wait a moment and try again." });
      return reply.type("text/html; charset=utf-8").send(TOO_MANY);
    }
    ctx.stats.enter(app);
    let left = false;
    reply.raw.once("close", () => {
      if (left) return;
      left = true;
      ctx.stats.leave(app);
    });
    const delay = latencyFor(v, app);
    if (delay > 0) await sleep(delay);
    return undefined;
  });
}

/** Helpers handed to each app's route module. */
export interface AppKit {
  app: AppName;
  brand: AppBrand;
  ctx: ServerContext;
  /** Rendering context for this request (variation snapshot taken now). */
  ui(req: FastifyRequest): Ui;
  sendHtml(reply: FastifyReply, status: number, body: string): FastifyReply;
  page(reply: FastifyReply, ui: Ui, status: number, opts: PageOptions): FastifyReply;
  error(reply: FastifyReply, ui: Ui, status: number, opts: { title: string; message: string; links?: { href: string; label: string }[] }): FastifyReply;
  /** 409 page for a stale `version`; counts the conflict. */
  conflict(reply: FastifyReply, ui: Ui, message: string, reloadHref: string): FastifyReply;
  /**
   * Runs a state-changing write under the failure-injection variation. Returns true when the
   * caller should send its normal success response; false when an injected 503/500 was sent.
   */
  guardedWrite(reply: FastifyReply, ui: Ui, write: () => void): boolean;
  pageSize(ui: Ui): number;
}

export const DEFAULT_PAGE_SIZE = 25;

type Dict = Record<string, unknown>;

/** First string value of a query/body field ("" when absent). */
export function field(source: unknown, key: string): string {
  if (typeof source !== "object" || source === null) return "";
  const v = (source as Dict)[key];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

export function hasField(source: unknown, key: string): boolean {
  return typeof source === "object" && source !== null && (source as Dict)[key] !== undefined;
}

export function parsePage(v: string): number {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function safeNext(next: string, home: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return home;
  if (next.startsWith("/login") || next.startsWith("/logout")) return home;
  return next;
}

export async function createAppServer(ctx: ServerContext, app: ClassicApp, register: (f: FastifyInstance, kit: AppKit) => void): Promise<FastifyInstance> {
  const brand = BRANDS[app];
  const sessions = new SessionStore();
  const newsCookie = `${brand.cookie}_news`;
  const f = Fastify({ logger: false });
  installRouteRecorder(f, ctx, app);
  await f.register(formbody);
  await f.register(cookie);

  const sessionFor = (req: FastifyRequest): Session | undefined => sessions.get(req.cookies[brand.cookie]);

  installTraffic(f, ctx, app);

  // Every page except /login requires this app's session cookie; viewers may only read.
  f.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (path === "/login" || path === "/logout" || path === "/favicon.ico") return undefined;
    const session = sessionFor(req);
    if (!session) {
      const next = req.method === "GET" ? req.url : brand.home;
      return reply.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    }
    if (deniesWrite(ctx, app, session, req.method)) {
      if (wantsJson(req)) return reply.code(403).header("cache-control", "no-store").send({ error: "read_only", message: READ_ONLY_MESSAGE });
      return kit.error(reply, kit.ui(req), 403, { title: READ_ONLY_TITLE, message: READ_ONLY_MESSAGE });
    }
    return undefined;
  });

  const kit: AppKit = {
    app,
    brand,
    ctx,
    ui(req) {
      const v = ctx.variations.get();
      const session = sessionFor(req);
      let announce: Ui["announce"] = null;
      if (session && v.announcementModal[app]) {
        const key = `${session.publicId}.${ctx.variations.announcementEpoch(app)}`;
        if (req.cookies[newsCookie] !== key) announce = { cookie: newsCookie, key };
      }
      return { app, brand, v, t: renameFor(v, app), announce, username: session?.username ?? "" };
    },
    sendHtml(reply, status, body) {
      return reply.code(status).type("text/html; charset=utf-8").header("cache-control", "no-store").send(body);
    },
    page(reply, ui, status, opts) {
      return kit.sendHtml(reply, status, renderPage(ui, opts));
    },
    error(reply, ui, status, opts) {
      return kit.page(reply, ui, status, { title: opts.title, body: errorBody(ui, opts) });
    },
    conflict(reply, ui, message, reloadHref) {
      ctx.stats.of(app).conflicts409++;
      return kit.error(reply, ui, 409, { title: "Edit conflict", message, links: [{ href: reloadHref, label: "Reload" }] });
    },
    guardedWrite(reply, ui, write) {
      const outcome = commitWrite(ctx, app, write);
      if (outcome === "failed-before-commit") {
        reply.header("retry-after", "1");
        kit.error(reply, ui, 503, { title: "Service unavailable", message: "The service is temporarily unavailable. Please try again in a moment." });
        return false;
      }
      if (outcome === "failed-after-commit") {
        kit.error(reply, ui, 500, { title: "Something went wrong", message: "An unexpected error occurred while processing your request." });
        return false;
      }
      return true;
    },
    pageSize(ui) {
      return ui.v.pageSize[app] ?? DEFAULT_PAGE_SIZE;
    },
  };

  f.get("/favicon.ico", async (_req, reply) => reply.code(204).send());

  f.get("/login", async (req, reply) => {
    const next = safeNext(field(req.query, "next"), brand.home);
    if (sessionFor(req)) return reply.redirect(next, 302);
    return kit.sendHtml(reply, 200, renderLogin(kit.ui(req), { next, username: "", error: null }));
  });

  f.post("/login", async (req, reply) => {
    const next = safeNext(field(req.body, "next") || field(req.query, "next"), brand.home);
    const username = field(req.body, "username");
    const password = field(req.body, "password");
    const account = authenticate(ctx.accounts, username, password);
    if (!account) {
      return kit.sendHtml(reply, 401, renderLogin(kit.ui(req), { next, username, error: "Incorrect username or password." }));
    }
    reply.setCookie(brand.cookie, sessions.create(account), { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect(next, 303);
  });

  // The only state-changing GET in the arena: it ends the session and touches no business data.
  f.get("/logout", async (req, reply) => {
    sessions.delete(req.cookies[brand.cookie]);
    reply.clearCookie(brand.cookie, { path: "/" });
    reply.clearCookie(newsCookie, { path: "/" });
    return reply.redirect("/login", 303);
  });

  f.setNotFoundHandler(async (req, reply) => {
    const ui = kit.ui(req);
    if (!sessionFor(req)) return kit.sendHtml(reply, 404, html`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head><body><main><h1>Page not found</h1><p><a href="/login">${ui.t("Sign in")}</a></p></main></body></html>`.value);
    return kit.error(reply, ui, 404, { title: "Page not found", message: "We couldn't find that page." });
  });

  f.setErrorHandler(async (err: unknown, req, reply) => {
    const status = typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) console.error(`[arena:${app}]`, err);
    const ui = kit.ui(req);
    return kit.error(reply, ui, status >= 400 ? status : 500, {
      title: status < 500 ? "Request could not be processed" : "Something went wrong",
      message: status < 500 ? "The request was not valid." : "An unexpected error occurred while processing your request.",
    });
  });

  register(f, kit);
  return f;
}
