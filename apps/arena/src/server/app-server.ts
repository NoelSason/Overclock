import { randomBytes, timingSafeEqual } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { ScenarioManager } from "../data/scenario";
import type { ArenaStore } from "../data/store";
import { html } from "./html";
import type { StatsRegistry } from "./stats";
import { BRANDS, errorBody, renderLogin, renderPage, type AppBrand, type PageOptions, type Ui } from "./ui";
import { latencyFor, renameFor, type AppName, type VariationStore } from "./variations";

/** Everything the four servers share. */
export interface ServerContext {
  store: ArenaStore;
  manager: ScenarioManager;
  variations: VariationStore;
  stats: StatsRegistry;
  credentials: { username: string; password: string };
}

interface Session {
  /** Non-secret id used for the per-session "What's new" dismissal cookie. */
  publicId: string;
  username: string;
  createdAt: number;
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

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function safeNext(next: string, home: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return home;
  if (next.startsWith("/login") || next.startsWith("/logout")) return home;
  return next;
}

const TOO_MANY = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Too many requests</title></head><body><main><h1>Too many requests</h1><p>Please wait a moment and try again.</p></main></body></html>";

export async function createAppServer(ctx: ServerContext, app: AppName, register: (f: FastifyInstance, kit: AppKit) => void): Promise<FastifyInstance> {
  const brand = BRANDS[app];
  const sessions = new Map<string, Session>();
  const newsCookie = `${brand.cookie}_news`;
  const f = Fastify({ logger: false });
  await f.register(formbody);
  await f.register(cookie);

  const sessionFor = (req: FastifyRequest): Session | undefined => {
    const token = req.cookies[brand.cookie];
    return token ? sessions.get(token) : undefined;
  };

  // Stats, concurrency limit, and latency, in that order, for every request.
  f.addHook("onRequest", async (_req, reply) => {
    ctx.stats.of(app).requests++;
    const v = ctx.variations.get();
    const limit = v.concurrencyLimit[app];
    if (limit !== undefined && ctx.stats.of(app).inFlight >= limit) {
      ctx.stats.of(app).throttled429++;
      return reply.code(429).header("retry-after", "1").type("text/html; charset=utf-8").send(TOO_MANY);
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

  // Every page except /login requires this app's session cookie.
  f.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (path === "/login" || path === "/logout" || path === "/favicon.ico") return undefined;
    if (sessionFor(req)) return undefined;
    const next = req.method === "GET" ? req.url : brand.home;
    return reply.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
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
      const failures = ui.v.failures[app];
      if (failures && Math.random() < failures.beforeCommitRate) {
        ctx.stats.of(app).injectedBeforeCommit++;
        reply.header("retry-after", "1");
        kit.error(reply, ui, 503, { title: "Service unavailable", message: "The service is temporarily unavailable. Please try again in a moment." });
        return false;
      }
      write();
      ctx.stats.of(app).writes++;
      if (failures && Math.random() < failures.afterCommitRate) {
        ctx.stats.of(app).injectedAfterCommit++;
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
    if (!safeEqual(username, ctx.credentials.username) || !safeEqual(password, ctx.credentials.password)) {
      return kit.sendHtml(reply, 401, renderLogin(kit.ui(req), { next, username, error: "Incorrect username or password." }));
    }
    const token = randomBytes(24).toString("base64url");
    sessions.set(token, { publicId: randomBytes(8).toString("hex"), username, createdAt: Date.now() });
    reply.setCookie(brand.cookie, token, { path: "/", httpOnly: true, sameSite: "lax" });
    return reply.redirect(next, 303);
  });

  f.get("/logout", async (req, reply) => {
    const token = req.cookies[brand.cookie];
    if (token) sessions.delete(token);
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
