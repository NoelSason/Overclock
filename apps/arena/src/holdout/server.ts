// HOLDOUT FIXTURE — engine/prompt developers must not read this file.
import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  authenticate,
  commitWrite,
  deniesWrite,
  installRouteRecorder,
  installTraffic,
  READ_ONLY_MESSAGE,
  READ_ONLY_TITLE,
  safeNext,
  SessionStore,
  wantsJson,
  type ServerContext,
  type Session,
} from "../server/app-server";
import { escapeHtml } from "../server/html";
import { renameFor } from "../server/variations";
import { CLIENT_CSS, CLIENT_JS, SIGNIN_JS } from "./client";
import { HOLDOUT_APP, HOLDOUT_DISPLAY_NAME } from "./meta";
import { LABELS, oneOf, SERVICE_STATUSES, SPECIMEN_STATES, type Specimen, type Unit } from "./model";

/**
 * The holdout application: a client-rendered single-page app. The HTML shell carries no data;
 * the browser script loads everything from same-origin JSON endpoints (implementation details
 * of this app, not an API for the agent) and saves changes with fetch.
 */

const APP = HOLDOUT_APP;
const COOKIE = "rw_sid";
const NEWS_COOKIE = "rw_news";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const CUSTODY_PAGE = 5;
const EXCURSION_PAGE = 5;
const WHATS_NEW = "Storage units now keep their full excursion history, and custody entries show who recorded them.";
const PUBLIC = new Set(["/signin", "/logout", "/favicon.ico"]);

type Dict = Record<string, unknown>;

function str(source: unknown, key: string): string {
  if (typeof source !== "object" || source === null) return "";
  const v = (source as Dict)[key];
  return typeof v === "string" ? v : "";
}

function num(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const v = (source as Dict)[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

function nonNegInt(v: unknown, fallback: number): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function summary(s: Specimen) {
  return { accession: s.accession, label_code: s.label_code, material: s.material, unit_id: s.unit_id, state: s.state, hold: s.hold, version: s.version };
}

function page(title: string, body: string, theme: string, scripts: string[] = []): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/rw.css"></head><body class="theme-${escapeHtml(theme)}">${body}${scripts.map((s) => `<script src="${s}" defer></script>`).join("")}</body></html>`;
}

function messagePage(title: string, message: string, theme: string): string {
  return page(
    `${title} · Rimewell`,
    `<main class="rw-message-page"><p class="rw-wordmark"><span class="rw-glyph" aria-hidden="true"></span>Rimewell</p><h1>${escapeHtml(title)}</h1><p role="alert">${escapeHtml(message)}</p><p><a href="/">Back to the registry</a></p></main>`,
    theme,
  );
}

export async function createHoldoutServer(ctx: ServerContext): Promise<FastifyInstance> {
  const { store } = ctx;
  const db = store.holdout;
  const sessions = new SessionStore();
  const f = Fastify({ logger: false });
  installRouteRecorder(f, ctx, APP);
  await f.register(cookie);

  const sessionFor = (req: FastifyRequest): Session | undefined => sessions.get(req.cookies[COOKIE]);
  const variations = () => ctx.variations.get();
  const isApi = (req: FastifyRequest) => (req.url.split("?")[0] ?? "").startsWith("/svc/") || wantsJson(req);
  const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).type("text/html; charset=utf-8").header("cache-control", "no-store").send(body);
  const json = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).header("cache-control", "no-store").send(body);
  const fail = (reply: FastifyReply, status: number, error: string, message: string) => json(reply, status, { error, message });

  installTraffic(f, ctx, APP);

  f.addHook("preHandler", async (req, reply) => {
    const path = req.url.split("?")[0] ?? "/";
    if (PUBLIC.has(path) || path.startsWith("/assets/")) return undefined;
    const session = sessionFor(req);
    if (!session) {
      if (isApi(req)) return fail(reply, 401, "signed_out", "Your session has ended. Sign in again.");
      return reply.redirect(`/signin?next=${encodeURIComponent(req.method === "GET" ? req.url : "/")}`, 302);
    }
    if (deniesWrite(ctx, APP, session, req.method)) {
      if (isApi(req)) return fail(reply, 403, "read_only", READ_ONLY_MESSAGE);
      return html(reply, 403, messagePage(READ_ONLY_TITLE, READ_ONLY_MESSAGE, variations().theme));
    }
    return undefined;
  });

  /** Runs a write under failure injection; sends the error response itself when injected. */
  const write = (reply: FastifyReply, run: () => void): boolean => {
    const outcome = commitWrite(ctx, APP, run);
    if (outcome === "failed-before-commit") {
      reply.header("retry-after", "1");
      fail(reply, 503, "unavailable", "The registry is temporarily unavailable. Try again in a moment.");
      return false;
    }
    if (outcome === "failed-after-commit") {
      fail(reply, 500, "server_error", "Something went wrong while saving. Check the record before trying again.");
      return false;
    }
    return true;
  };

  const conflict = (reply: FastifyReply, what: string) => {
    ctx.stats.of(APP).conflicts409++;
    return fail(reply, 409, "conflict", `This ${what} changed since you opened it. Reload it and try again.`);
  };

  // Static assets and sign-in ---------------------------------------------------------------

  f.get("/favicon.ico", async (_req, reply) => reply.code(204).send());
  f.get("/assets/rw.css", async (_req, reply) => reply.type("text/css; charset=utf-8").header("cache-control", "no-cache").send(CLIENT_CSS));
  f.get("/assets/rw.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(CLIENT_JS));
  f.get("/assets/signin.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").header("cache-control", "no-cache").send(SIGNIN_JS));

  const nextFrom = (raw: string) => {
    const next = safeNext(raw, "/");
    return next.startsWith("/signin") ? "/" : next;
  };

  f.get("/signin", async (req, reply) => {
    const next = nextFrom(str(req.query, "next"));
    if (sessionFor(req)) return reply.redirect(next, 302);
    const t = renameFor(variations(), APP);
    const body = `<main class="rw-signin"><div class="rw-signin-card">
<p class="rw-wordmark"><span class="rw-glyph" aria-hidden="true"></span>Rimewell</p>
<h1>Sign in to the registry</h1>
<p class="rw-muted">Cold storage records for every specimen, from intake to discard.</p>
<form id="rw-signin" data-next="${escapeHtml(next)}" novalidate>
<div id="rw-step-account"><div class="rw-field"><label for="rw-account">Account name</label><input id="rw-account" name="account" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
<button type="submit" class="rw-primary rw-wide">${escapeHtml(t("Continue"))}</button></div>
<div id="rw-step-secret" hidden><p class="rw-who">Account <strong id="rw-who"></strong> <button type="button" class="rw-linkish" id="rw-change">${escapeHtml(t("Use a different account"))}</button></p>
<div class="rw-field"><label for="rw-secret">Passphrase</label><input id="rw-secret" name="passphrase" type="password" autocomplete="current-password" required></div>
<button type="submit" class="rw-primary rw-wide" id="rw-signin-btn">${escapeHtml(t("Sign in"))}</button></div>
<p id="rw-signin-error" class="rw-error" role="alert" hidden></p>
</form></div></main>`;
    return html(reply, 200, page("Sign in · Rimewell", body, variations().theme, ["/assets/signin.js"]));
  });

  f.post("/signin", async (req, reply) => {
    const account = authenticate(ctx.accounts, str(req.body, "account").trim(), str(req.body, "passphrase"));
    if (!account) return fail(reply, 401, "invalid_credentials", "That account name and passphrase don't match.");
    reply.setCookie(COOKIE, sessions.create(account), { path: "/", httpOnly: true, sameSite: "lax" });
    return json(reply, 200, { ok: true, next: nextFrom(str(req.body, "next")) });
  });

  // Ends the session only; no business data changes.
  f.get("/logout", async (req, reply) => {
    sessions.delete(req.cookies[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    reply.clearCookie(NEWS_COOKIE, { path: "/" });
    return reply.redirect("/signin", 303);
  });

  // App shell -------------------------------------------------------------------------------

  f.get("/", async (_req, reply) =>
    html(reply, 200, page("Rimewell", `<div id="rw-root" aria-busy="true"><p class="rw-boot">Loading the registry…</p></div>`, variations().theme, ["/assets/rw.js"])),
  );

  f.get("/svc/boot", async (req, reply) => {
    const v = variations();
    const session = sessionFor(req)!;
    const key = `${session.publicId}.${ctx.variations.announcementEpoch(APP)}`;
    return json(reply, 200, {
      user: session.username,
      product: HOLDOUT_DISPLAY_NAME,
      t: v.renameButtons[APP] ?? {},
      confirm: v.confirmModal[APP] === true,
      tabs: v.editInTab[APP] === true,
      shuffle: v.shuffleFields[APP] ?? 0,
      pageSize: v.pageSize[APP] ?? DEFAULT_LIMIT,
      theme: v.theme,
      announce: v.announcementModal[APP] && req.cookies[NEWS_COOKIE] !== key ? { cookie: NEWS_COOKIE, key, text: WHATS_NEW } : null,
      labels: LABELS,
    });
  });

  const limitOf = (req: FastifyRequest) => Math.min(MAX_LIMIT, Math.max(1, nonNegInt((req.query as Dict)?.limit, variations().pageSize[APP] ?? DEFAULT_LIMIT)));

  // Specimens -------------------------------------------------------------------------------

  f.get("/svc/specimens", async (req, reply) => {
    const q = str(req.query, "q").trim();
    const state = str(req.query, "state");
    const offset = nonNegInt((req.query as Dict)?.offset, 0);
    const limit = limitOf(req);
    const res = db.listSpecimens({ q: q || undefined, state: oneOf(SPECIMEN_STATES, state) ? state : undefined, offset, limit });
    const next = offset + res.rows.length;
    return json(reply, 200, { items: res.rows.map(summary), total: res.total, offset, nextOffset: next < res.total ? next : null });
  });

  f.get<{ Params: { acc: string } }>("/svc/specimens/:acc", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    return json(reply, 200, { specimen: s, custody: db.custody(s.accession, { limit: CUSTODY_PAGE }) });
  });

  f.get<{ Params: { acc: string } }>("/svc/specimens/:acc/custody", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    const before = num(req.query, "before");
    return json(reply, 200, db.custody(s.accession, { beforeId: before, limit: CUSTODY_PAGE }));
  });

  f.post<{ Params: { acc: string } }>("/svc/specimens/:acc/state", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    const to = str(req.body, "to");
    if (!oneOf(SPECIMEN_STATES, to)) return fail(reply, 400, "invalid_state", `“${to}” is not a specimen state.`);
    if (to === s.state) return fail(reply, 400, "unchanged", `${s.accession} is already ${LABELS.state[to]}.`);
    if (num(req.body, "version") !== s.version) return conflict(reply, "specimen");
    let updated: Specimen | undefined;
    if (!write(reply, () => void (updated = db.updateSpecimen(s.accession, { state: to })))) return reply;
    return json(reply, 200, { specimen: updated });
  });

  f.post<{ Params: { acc: string } }>("/svc/specimens/:acc/hold", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    const action = str(req.body, "action");
    const reason = str(req.body, "reason").trim().replace(/\s+/g, " ");
    if (action !== "place" && action !== "release") return fail(reply, 400, "invalid_action", "Choose whether to place or release the hold.");
    if (action === "place" && s.hold === 1) return fail(reply, 400, "already_held", `${s.accession} is already on review hold.`);
    if (action === "release" && s.hold === 0) return fail(reply, 400, "not_held", `${s.accession} is not on review hold.`);
    if (action === "place" && !reason) return fail(reply, 400, "missing_reason", "Enter a reason for the hold.");
    if (reason.length > 120) return fail(reply, 400, "reason_too_long", "Keep the reason under 120 characters.");
    if (num(req.body, "version") !== s.version) return conflict(reply, "specimen");
    const patch = action === "place" ? { hold: 1 as const, hold_reason: reason } : { hold: 0 as const, hold_reason: "" };
    let updated: Specimen | undefined;
    if (!write(reply, () => void (updated = db.updateSpecimen(s.accession, patch)))) return reply;
    return json(reply, 200, { specimen: updated });
  });

  // Append-only: no version check, so a retried request records a second copy.
  f.post<{ Params: { acc: string } }>("/svc/specimens/:acc/custody", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    const text = str(req.body, "text").trim();
    if (!text) return fail(reply, 400, "empty_entry", "Write the entry before recording it.");
    if (text.length > 500) return fail(reply, 400, "entry_too_long", "Keep custody entries under 500 characters.");
    const actor = sessionFor(req)?.username ?? "unknown";
    let entry: ReturnType<typeof db.addCustody> | undefined;
    if (!write(reply, () => void (entry = db.addCustody(s.accession, text, actor)))) return reply;
    return json(reply, 201, { entry });
  });

  f.patch<{ Params: { acc: string } }>("/svc/specimens/:acc", async (req, reply) => {
    const s = db.getSpecimen(req.params.acc);
    if (!s) return fail(reply, 404, "not_found", `No specimen has the accession ${req.params.acc}.`);
    const fieldName = str(req.body, "field");
    if (fieldName !== "position" && fieldName !== "handling_note") return fail(reply, 400, "not_editable", "That detail can't be edited here.");
    const value = str(req.body, "value").trim();
    if (fieldName === "position" && !/^R\d{1,2}-B\d{1,2}-\d{2}$/.test(value)) return fail(reply, 400, "invalid_position", "Use a position like R2-B7-14 (rack, box, slot).");
    if (value.length > 200) return fail(reply, 400, "too_long", "Keep it under 200 characters.");
    if (num(req.body, "version") !== s.version) return conflict(reply, "specimen");
    let updated: Specimen | undefined;
    const patch = fieldName === "position" ? { position: value } : { handling_note: value };
    if (!write(reply, () => void (updated = db.updateSpecimen(s.accession, patch)))) return reply;
    return json(reply, 200, { specimen: updated });
  });

  // Participants ----------------------------------------------------------------------------

  f.get("/svc/participants", async (req, reply) => {
    const q = str(req.query, "q").trim();
    const offset = nonNegInt((req.query as Dict)?.offset, 0);
    const res = db.listParticipants({ q: q || undefined, offset, limit: limitOf(req) });
    const counts = db.specimenCounts("participant_code");
    const next = offset + res.rows.length;
    return json(reply, 200, {
      items: res.rows.map((p) => ({ code: p.code, consent: p.consent, site: p.site, specimens: counts.get(p.code) ?? 0 })),
      total: res.total,
      offset,
      nextOffset: next < res.total ? next : null,
    });
  });

  f.get<{ Params: { code: string } }>("/svc/participants/:code", async (req, reply) => {
    const p = db.getParticipant(req.params.code);
    if (!p) return fail(reply, 404, "not_found", `No participant is registered with the code ${req.params.code}.`);
    return json(reply, 200, { participant: p, specimens: db.specimensOfParticipant(p.code).map(summary) });
  });

  // Storage units ---------------------------------------------------------------------------

  f.get("/svc/units", async (_req, reply) => {
    const counts = db.specimenCounts("unit_id");
    return json(reply, 200, { items: db.listUnits().map((u) => ({ ...u, specimens: counts.get(u.id) ?? 0 })) });
  });

  const excursionPage = (unitId: string, offset: number) => {
    const res = db.excursions(unitId, offset, EXCURSION_PAGE);
    const next = offset + res.rows.length;
    return { items: res.rows, total: res.total, offset, nextOffset: next < res.total ? next : null };
  };

  f.get<{ Params: { id: string } }>("/svc/units/:id", async (req, reply) => {
    const u = db.getUnit(req.params.id);
    if (!u) return fail(reply, 404, "not_found", `No storage unit has the ID ${req.params.id}.`);
    return json(reply, 200, { unit: u, specimens: db.countInUnit(u.id), excursions: excursionPage(u.id, 0) });
  });

  f.get<{ Params: { id: string } }>("/svc/units/:id/excursions", async (req, reply) => {
    const u = db.getUnit(req.params.id);
    if (!u) return fail(reply, 404, "not_found", `No storage unit has the ID ${req.params.id}.`);
    return json(reply, 200, excursionPage(u.id, nonNegInt((req.query as Dict)?.offset, 0)));
  });

  f.patch<{ Params: { id: string } }>("/svc/units/:id", async (req, reply) => {
    const u = db.getUnit(req.params.id);
    if (!u) return fail(reply, 404, "not_found", `No storage unit has the ID ${req.params.id}.`);
    if (str(req.body, "field") !== "service") return fail(reply, 400, "not_editable", "That detail can't be edited here.");
    const value = str(req.body, "value");
    if (!oneOf(SERVICE_STATUSES, value)) return fail(reply, 400, "invalid_service", `“${value}” is not a service status.`);
    if (num(req.body, "version") !== u.version) return conflict(reply, "storage unit");
    let updated: Unit | undefined;
    if (!write(reply, () => void (updated = db.updateUnit(u.id, { service: value })))) return reply;
    return json(reply, 200, { unit: updated });
  });

  // Fallbacks -------------------------------------------------------------------------------

  f.setNotFoundHandler(async (req, reply) => {
    if (isApi(req)) return fail(reply, 404, "not_found", "Not found.");
    return html(reply, 404, messagePage("Page not found", "There is nothing at this address.", variations().theme));
  });

  f.setErrorHandler(async (err: unknown, req, reply) => {
    const status = typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) console.error(`[arena:${APP}]`, err);
    const code = status >= 400 ? status : 500;
    const message = code < 500 ? "The request was not valid." : "Something went wrong.";
    if (isApi(req)) return fail(reply, code, code < 500 ? "bad_request" : "server_error", message);
    return html(reply, code, messagePage(code < 500 ? "Request could not be processed" : "Something went wrong", message, variations().theme));
  });

  return f;
}
