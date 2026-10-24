import { ScenarioRequest, VariationConfig, type PublicScenario, type TaskTemplateId } from "@overclock/contracts";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { AppOrigins, JudgeEntity } from "../data/scenario";
import { HOLDOUT_EDITABLE, HOLDOUT_ENTITY_KINDS, holdoutEntityExists, isHoldoutEntityKind, planHoldoutJudgeEdits } from "../holdout/task";
import type { ServerContext } from "./app-server";
import { JUDGE_CONSOLE_HTML } from "./console";
import { CUSTOMER_STATUS, ORDER_STATUS, TICKET_CATEGORY, TICKET_OWNER, TICKET_STATUS } from "./labels";
import { APP_NAMES, applySurprise, deepMerge, isAppName, isSurpriseKind } from "./variations";

/**
 * Admin / judge server: JSON API for the benchmark harness and the judge console, plus the
 * console page itself. Never exposed to the agent under test.
 */

type Entity = JudgeEntity;
type FieldRule = "text" | "flag" | { values: readonly string[] };

const EDITABLE: Record<Entity, Record<string, FieldRule>> = {
  customer: { name: "text", email: "text", phone: "text", city: "text", status: CUSTOMER_STATUS },
  order: { customer_id: "text", status: ORDER_STATUS, tracking: "text", review_flag: "flag", review_reason: "text" },
  ticket: { category: TICKET_CATEGORY, status: TICKET_STATUS, owner: TICKET_OWNER },
  ...HOLDOUT_EDITABLE,
};
const ENTITIES = ["order", "ticket", "customer", ...HOLDOUT_ENTITY_KINDS] as const;

function isEntity(v: unknown): v is Entity {
  return typeof v === "string" && (ENTITIES as readonly string[]).includes(v);
}

function entityExists(ctx: ServerContext, entity: Entity, id: string): boolean {
  const { store } = ctx;
  if (isHoldoutEntityKind(entity)) return holdoutEntityExists(store.holdout, entity, id);
  return !!(entity === "order" ? store.orders.get(id) : entity === "ticket" ? store.support.get(id) : store.crm.get(id));
}

function validatePatch(entity: Entity, patch: unknown): { ok: true; patch: Record<string, string | number> } | { ok: false; error: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { ok: false, error: "patch must be an object" };
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(patch)) {
    const rule = EDITABLE[entity][k];
    if (!rule) return { ok: false, error: `${entity} field "${k}" is not editable (allowed: ${Object.keys(EDITABLE[entity]).join(", ")})` };
    if (rule === "text") {
      if (typeof v !== "string") return { ok: false, error: `${k} must be a string` };
      out[k] = v;
    } else if (rule === "flag") {
      if (v !== 0 && v !== 1) return { ok: false, error: `${k} must be 0 or 1` };
      out[k] = v;
    } else {
      if (typeof v !== "string" || !rule.values.includes(v)) return { ok: false, error: `${k} must be one of ${rule.values.join(", ")}` };
      out[k] = v;
    }
  }
  if (!Object.keys(out).length) return { ok: false, error: "patch is empty" };
  return { ok: true, patch: out };
}

function pickRandom<T>(xs: readonly T[]): T | undefined {
  return xs[Math.floor(Math.random() * xs.length)];
}

function shuffled<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

interface JudgeEdit {
  entity: Entity;
  id: string;
  patch: Record<string, string | number>;
}

/** A source-data change for one unprocessed record that changes what the rules require. */
function planJudgeEdit(ctx: ServerContext, template: TaskTemplateId, recordKey: string, untouched: ReadonlySet<string>): JudgeEdit | undefined {
  const { store, manager } = ctx;
  const options: JudgeEdit[] = [];
  if (template === "t4-holdout") {
    options.push(...planHoldoutJudgeEdits(store.holdout, recordKey, untouched, manager.current?.recordKeys ?? []));
  } else if (template === "t1-order-reconcile") {
    const o = store.orders.get(recordKey);
    if (!o) return undefined;
    options.push({ entity: "order", id: o.id, patch: { status: o.status === "refunded" ? "delivered" : "refunded" } });
    const t = store.support.byOrder(o.id)[0];
    if (t) options.push({ entity: "ticket", id: t.id, patch: { category: t.category === "damage" ? "shipping" : "damage" } });
  } else if (template === "t2-ticket-triage") {
    const t = store.support.get(recordKey);
    if (!t) return undefined;
    options.push({ entity: "ticket", id: t.id, patch: { category: t.category === "billing" ? "shipping" : "billing" } });
    const matches = store.crm.byEmail(t.customer_email);
    const c = matches[0];
    if (matches.length === 1 && c) options.push({ entity: "customer", id: c.id, patch: { status: c.status === "vip" ? "active" : "vip" } });
  } else {
    const c = store.crm.get(recordKey);
    if (!c) return undefined;
    options.push({ entity: "customer", id: c.id, patch: { status: c.status === "active" ? "vip" : "active" } });
  }
  return pickRandom(options);
}

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export interface AdminInfo {
  origins: AppOrigins;
  adminOrigin: () => string;
}

export async function createAdminServer(ctx: ServerContext, info: AdminInfo): Promise<FastifyInstance> {
  const { manager, store, variations, stats } = ctx;
  const f = Fastify({ logger: false });

  f.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && LOCAL_ORIGIN.test(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
      reply.header("access-control-max-age", "600");
    }
    if (req.method === "OPTIONS") return reply.code(204).send();
    return undefined;
  });
  f.options("/*", async (_req, reply) => reply.code(204).send());

  const fail = (reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) => reply.code(status).send({ error, ...extra });
  const noScenario = (reply: FastifyReply) => fail(reply, 404, "No scenario loaded");

  const reset = (): PublicScenario | null => {
    const p = manager.reset();
    if (!p) return null;
    variations.reset();
    stats.clear();
    return p;
  };

  const setVariations = (reply: FastifyReply, input: unknown) => {
    const parsed = VariationConfig.safeParse(input);
    if (!parsed.success) return fail(reply, 400, "Invalid variation config", { issues: parsed.error.issues });
    return reply.send(variations.set(parsed.data));
  };

  f.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "no-store").send(JUDGE_CONSOLE_HTML));

  f.get("/api/health", async () => ({ ok: true, origins: info.origins, adminOrigin: info.adminOrigin() }));

  f.get("/api/scenario", async (_req, reply) => manager.publicScenario() ?? noScenario(reply));

  f.post("/api/scenario", async (req, reply) => {
    const parsed = ScenarioRequest.safeParse(req.body ?? {});
    if (!parsed.success) return fail(reply, 400, "Invalid scenario request", { issues: parsed.error.issues });
    const p = manager.load(parsed.data);
    variations.reset();
    stats.clear();
    return p;
  });

  f.post("/api/reset", async (_req, reply) => reset() ?? noScenario(reply));

  f.get("/api/check", async (_req, reply) => manager.check() ?? noScenario(reply));

  f.get("/api/expectation-summary", async (_req, reply) => manager.expectationSummary() ?? noScenario(reply));

  f.get("/api/variations", async () => variations.get());
  f.put("/api/variations", async (req, reply) => setVariations(reply, req.body ?? {}));
  f.patch("/api/variations", async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body !== "object" || Array.isArray(body)) return fail(reply, 400, "PATCH body must be an object");
    return setVariations(reply, deepMerge(structuredClone(variations.get()), body));
  });
  f.post("/api/variations/reset", async () => variations.reset());

  f.post("/api/edit-record", async (req, reply) => {
    if (!manager.current) return noScenario(reply);
    const b = (req.body ?? {}) as { entity?: unknown; id?: unknown; patch?: unknown };
    if (!isEntity(b.entity)) return fail(reply, 400, `entity must be one of ${ENTITIES.map((e) => `"${e}"`).join(", ")}`);
    if (typeof b.id !== "string" || !b.id) return fail(reply, 400, "id must be a non-empty string");
    if (!entityExists(ctx, b.entity, b.id)) return fail(reply, 404, `No ${b.entity} with id ${b.id}`);
    const v = validatePatch(b.entity, b.patch);
    if (!v.ok) return fail(reply, 400, v.error);
    const ok = manager.editRecord(b.entity, b.id, v.patch);
    return { ok, entity: b.entity, id: b.id, patch: v.patch };
  });

  f.post("/api/judge/edit-unprocessed", async (_req, reply) => {
    const s = manager.current;
    if (!s) return noScenario(reply);
    const keys = manager.untouchedRecords();
    if (!keys.length) return fail(reply, 409, "Every record has already been processed");
    const untouched = new Set(keys);
    for (const recordKey of shuffled(keys)) {
      const edit = planJudgeEdit(ctx, s.template, recordKey, untouched);
      if (!edit) continue;
      manager.editRecord(edit.entity, edit.id, edit.patch);
      return { recordKey, entity: edit.entity, id: edit.id, patch: edit.patch };
    }
    return fail(reply, 409, "No unprocessed record could be edited");
  });

  f.post("/api/judge/surprise", async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: unknown; app?: unknown };
    if (!isSurpriseKind(b.kind)) return fail(reply, 400, "Unknown surprise kind");
    const target = b.app === undefined || b.app === "all" ? "all" : b.app;
    if (target !== "all" && !isAppName(target)) return fail(reply, 400, `app must be one of ${[...APP_NAMES, "all"].map((a) => `"${a}"`).join(", ")}`);
    return variations.set(applySurprise(variations.get(), b.kind, target));
  });

  f.get("/api/stats", async () => stats.snapshot());

  f.setNotFoundHandler(async (_req, reply) => fail(reply, 404, "Not found"));
  f.setErrorHandler(async (err: unknown, _req, reply) => {
    const status = typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number" ? (err as { statusCode: number }).statusCode : 500;
    if (status >= 500) console.error("[arena:admin]", err);
    return fail(reply, status, err instanceof Error ? err.message : "Internal error");
  });

  return f;
}
