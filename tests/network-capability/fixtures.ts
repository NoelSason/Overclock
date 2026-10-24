import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena, type Arena } from "@overclock/arena";
import { BrowserManager, SessionManager, type StorageState } from "@overclock/browser-runtime";
import type { AppBinding, AppControl, AppModel, DslPlan } from "@overclock/contracts";
import { crawlApp } from "@overclock/discovery";
import { exportCapability, type ExportResult } from "../../packages/network-capability/src/index";

/**
 * Test-only fixtures. No planner runs here: the plan below is hand-written against the crawled
 * app models, and the labels it looks up are test knowledge of the arena UI.
 */

export const OPERATOR = { username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" };
export const VIEWER = { username: process.env.ARENA_VIEWER_USERNAME || "viewer", password: process.env.ARENA_VIEWER_PASSWORD || "overclock-viewer" };

export const GOAL = [
  "Review these 5 orders. For each order, look up its support ticket and mark the order as reviewed",
  'with the reason "Checked by Overclock for <order ID>". Do not change anything else.',
].join("\n");

export interface Env {
  arena: Arena;
  dir: string;
  browser: BrowserManager;
  apps: AppBinding[];
  operator: StorageState | undefined;
  models: AppModel[];
  records: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function loginState(browser: BrowserManager, apps: AppBinding[], creds: { username: string; password: string }): Promise<StorageState | undefined> {
  return new SessionManager(browser, () => creds).storageStateFor(apps);
}

export async function setupEnv(): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), "oc-netcap-"));
  // Seed 7 / template t1: development scenario (never holdout seeds >= 9000 or t3/t4).
  const arena = await startArena({ ports: { CRM: 0, Orders: 0, Support: 0 }, adminPort: 0, dataDir: dir, defaultScenario: { seed: 7, template: "t1-order-reconcile", records: 5 } });
  const browser = new BrowserManager({ headless: true });
  const apps: AppBinding[] = [
    { name: "Orders", origin: arena.origins.Orders },
    { name: "Support", origin: arena.origins.Support },
  ];
  const operator = await loginState(browser, apps, OPERATOR);
  const models: AppModel[] = [];
  for (const app of apps) models.push((await crawlApp({ browser, app, storageState: operator })).model);
  const records = arena.manager.publicScenario()!.records;
  return {
    arena,
    dir,
    browser,
    apps,
    operator,
    models,
    records,
    async close() {
      await browser.close();
      await arena.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function modelOf(models: AppModel[], app: string): AppModel {
  const m = models.find((x) => x.app === app);
  if (!m) throw new Error(`no model for ${app}`);
  return m;
}

/** Local control id by page, kind, and visible label (tables: the only table on the page). */
export function idOf(model: AppModel, page: string, kind: AppControl["kind"], label?: string): string {
  const hits = Object.values(model.controls).filter((c) => c.page === page && c.kind === kind && (label === undefined || (c.label ?? c.name) === label));
  if (hits.length !== 1) throw new Error(`expected one ${kind} "${label ?? "*"}" on ${model.app} ${page}, found ${hits.length}`);
  return hits[0]!.id;
}

/** Hand-written plan: scan the order list, read each order and its ticket, then flag the order with a guarded, verified write. */
export function buildPlan(models: AppModel[]): DslPlan {
  const o = modelOf(models, "Orders");
  const s = modelOf(models, "Support");
  const reason = "concat('Checked by Overclock for ', $rec.orderId)";
  return {
    strategy: { name: "per-order review", summary: "Read each order and its ticket, then set the review reason.", rationale: "Hand-written test plan; ORD-50012 was used while drafting." },
    phases: [
      {
        id: "scan",
        kind: "once",
        dependsOn: [],
        steps: [
          { id: "list_orders", op: "goto", app: "Orders", url: "/orders" },
          { id: "read_list", op: "extractTable", table: idOf(o, "/orders", "table"), columns: [{ name: "orderId", header: "Order ID" }, { name: "status", header: "Status" }], key: "orderId" },
        ],
      },
      {
        id: "review",
        kind: "foreach",
        over: "$input.records",
        key: "$rec.orderId",
        dependsOn: ["scan"],
        steps: [
          { id: "open_order", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}" },
          {
            id: "read_order",
            op: "extract",
            fields: [
              { name: "status", control: idOf(o, "/orders/:id", "fact", "Order › Status"), parse: "string" },
              { name: "email", control: idOf(o, "/orders/:id", "fact", "Customer › Customer email"), parse: "string" },
              { name: "reason", control: idOf(o, "/orders/:id", "fact", "Review › Review reason"), parse: "string", optional: true },
            ],
            note: "Customer jane.doe@example.com called about this one",
          },
          { id: "find_ticket", op: "goto", app: "Support", url: "/tickets?q={$rec.orderId}" },
          { id: "read_tickets", op: "extractTable", table: idOf(s, "/tickets", "table"), columns: [{ name: "ticketId", header: "Ticket" }, { name: "status", header: "Status" }, { name: "category", header: "Category" }], key: "ticketId" },
          {
            id: "decide",
            op: "compute",
            assign: [
              { name: "hasTicket", expr: "len($out.read_tickets.rows) > 0" },
              { name: "needs", expr: `$out.read_order.reason != ${reason}` },
            ],
          },
          { id: "open_edit", op: "goto", app: "Orders", url: "/orders/{$rec.orderId}/edit", when: "$out.decide.needs" },
          {
            id: "read_form",
            op: "extract",
            when: "$out.decide.needs",
            fields: [
              { name: "reason", control: idOf(o, "/orders/:id/edit", "input", "Review reason"), parse: "string" },
              { name: "status", control: idOf(o, "/orders/:id/edit", "select", "Status"), parse: "string" },
            ],
          },
          { id: "keep_status", op: "select", control: idOf(o, "/orders/:id/edit", "select", "Status"), value: "$out.read_form.status", when: "$out.decide.needs" },
          { id: "set_reason", op: "fill", control: idOf(o, "/orders/:id/edit", "input", "Review reason"), value: reason, when: "$out.decide.needs" },
          {
            id: "save",
            op: "submit",
            control: idOf(o, "/orders/:id/edit", "button", "Update order"),
            when: "$out.decide.needs",
            writes: ["app:orders:order:{$rec.orderId}"],
            guards: [
              { control: idOf(o, "/orders/:id/edit", "input", "Review reason"), equals: "$out.read_form.reason" },
              { control: idOf(o, "/orders/:id/edit", "select", "Status"), equals: "$out.read_form.status" },
            ],
            verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "reason", control: idOf(o, "/orders/:id", "fact", "Review › Review reason"), equals: reason }] },
            irreversible: false,
          },
        ],
      },
    ],
    outcomes: [{ id: "reviewed", description: "Every listed order carries the review reason (e.g. ORD-50012)" }],
    assumptions: ["Order ORD-50012 belongs to Avery Quinn"],
    risks: ["None"],
  };
}

export function exportFixture(env: Env, overrides: Partial<Parameters<typeof exportCapability>[0]> = {}): ExportResult {
  return exportCapability({
    plan: buildPlan(env.models),
    models: env.models,
    apps: env.apps,
    goal: GOAL,
    recordFields: ["orderId"],
    verifiedReceipts: 5,
    compilerVersion: "overclock-compiler/1.0",
    records: env.records,
    createdAt: 1_760_000_000_000,
    ...overrides,
  });
}

export async function patchVariations(env: Env, patch: unknown): Promise<void> {
  const res = await fetch(`${env.arena.adminOrigin}/api/variations`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`PATCH /api/variations -> ${res.status}`);
}

export async function resetVariations(env: Env): Promise<void> {
  const res = await fetch(`${env.arena.adminOrigin}/api/variations/reset`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /api/variations/reset -> ${res.status}`);
}

/** What another runtime receives: the artifact as JSON bytes. */
export function overTheWire<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}
