import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioRequest, VariationConfig } from "@overclock/contracts";
import type { FastifyInstance } from "fastify";
import { CLASSIC_APPS, type AppName } from "./data/apps";
import { ScenarioManager, type AppOrigins } from "./data/scenario";
import { ArenaStore } from "./data/store";
import { HOLDOUT_APP, HOLDOUT_DEFAULT_PORT, HOLDOUT_PORT_ENV } from "./holdout/meta";
import { createHoldoutServer } from "./holdout/server";
import { createAdminServer } from "./server/admin";
import { createAppServer, RouteRegistry, type Account, type RouteInfo, type ServerContext } from "./server/app-server";
import { registerCrm } from "./server/crm";
import { registerOrders } from "./server/orders";
import { StatsRegistry, type ArenaStats } from "./server/stats";
import { registerSupport } from "./server/support";
import { APP_NAMES, VariationStore } from "./server/variations";

export { ArenaStore } from "./data/store";
export { ScenarioManager, type AppOrigins } from "./data/scenario";
export type { AppStats, ArenaStats } from "./server/stats";
export type { Account, Role, RouteInfo } from "./server/app-server";
export { APP_NAMES, CLASSIC_APPS, SAVE_BUTTON_RENAMES, SURPRISE_KINDS, type AppName, type ClassicApp, type SurpriseKind } from "./server/variations";
export { BRANDS } from "./server/ui";
export { HOLDOUT_APP } from "./holdout/meta";

export interface StartArenaOptions {
  host?: string;
  adminPort?: number;
  /**
   * Per-app ports. When every classic app is given port 0 and the holdout app is not listed,
   * the holdout app also gets an ephemeral port (so test harnesses never collide on 4104).
   */
  ports?: Partial<Record<AppName, number>>;
  dataDir?: string;
  /**
   * Scenario to load when the data dir has none. `undefined` loads the built-in default
   * (seed 4242, t1-order-reconcile, 100 records); `null` starts with no scenario.
   */
  defaultScenario?: ScenarioRequest | null;
}

export interface Arena {
  adminOrigin: string;
  origins: Record<AppName, string>;
  manager: ScenarioManager;
  store: ArenaStore;
  getVariations(): VariationConfig;
  /** Replace the whole variation config (validated; throws on invalid input). */
  setVariations(v: VariationConfig): void;
  stats(): ArenaStats;
  /** Routes each app registered (method + URL pattern), for audits such as "no state-changing GETs". */
  routes(): Record<AppName, RouteInfo[]>;
  close(): Promise<void>;
}

const DEFAULT_SCENARIO: ScenarioRequest = { seed: 4242, template: "t1-order-reconcile", records: 100 };
const DEFAULT_PORTS: Record<AppName, number> = { CRM: 4101, Orders: 4102, Support: 4103, [HOLDOUT_APP]: HOLDOUT_DEFAULT_PORT };
const PORT_ENV: Record<AppName, string> = { CRM: "OVERCLOCK_ARENA_CRM_PORT", Orders: "OVERCLOCK_ARENA_ORDERS_PORT", Support: "OVERCLOCK_ARENA_SUPPORT_PORT", [HOLDOUT_APP]: HOLDOUT_PORT_ENV };

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} must be a port number, got "${raw}"`);
  return n;
}

/** Repo root = nearest ancestor containing pnpm-workspace.yaml (falls back to cwd). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function originFor(host: string, server: FastifyInstance): string {
  const port = (server.server.address() as AddressInfo).port;
  const h = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${h.includes(":") ? `[${h}]` : h}:${port}`;
}

/** Operator and read-only viewer accounts, shared by every app (each app keeps its own sessions). */
export function arenaAccounts(env: NodeJS.ProcessEnv = process.env): Account[] {
  const accounts: Account[] = [
    { username: env.ARENA_USERNAME || "operator", password: env.ARENA_PASSWORD || "overclock-arena", role: "operator" },
    { username: env.ARENA_VIEWER_USERNAME || "viewer", password: env.ARENA_VIEWER_PASSWORD || "overclock-viewer", role: "viewer" },
  ];
  if (accounts[0]!.username === accounts[1]!.username) throw new Error("ARENA_VIEWER_USERNAME must differ from ARENA_USERNAME");
  return accounts;
}

export async function startArena(opts: StartArenaOptions = {}): Promise<Arena> {
  const host = opts.host ?? process.env.OVERCLOCK_ARENA_HOST ?? "127.0.0.1";
  const adminPort = opts.adminPort ?? envPort("OVERCLOCK_ARENA_ADMIN_PORT", 4100);
  const allEphemeral = CLASSIC_APPS.every((a) => opts.ports?.[a] === 0);
  const ports = Object.fromEntries(
    APP_NAMES.map((a) => [a, opts.ports?.[a] ?? (a === HOLDOUT_APP && allEphemeral ? 0 : envPort(PORT_ENV[a], DEFAULT_PORTS[a]))]),
  ) as Record<AppName, number>;
  const dataDir = opts.dataDir ?? process.env.OVERCLOCK_ARENA_DATA_DIR ?? join(findRepoRoot(), ".data", "arena");

  const accounts = arenaAccounts();
  const store = new ArenaStore(dataDir);
  // Filled in after listen (ports may be ephemeral); the manager keeps this object by reference.
  const origins: Record<AppName, string> = { CRM: "", Orders: "", Support: "", [HOLDOUT_APP]: "" };
  const manager = new ScenarioManager(store, origins satisfies AppOrigins, dataDir);
  const ctx: ServerContext = {
    store,
    manager,
    variations: new VariationStore(),
    stats: new StatsRegistry(),
    accounts,
    routes: new RouteRegistry(),
  };

  let adminOrigin = "";
  const servers: FastifyInstance[] = [];
  const closeAll = async () => {
    await Promise.allSettled(servers.map((s) => s.close()));
  };
  try {
    const apps: Record<AppName, FastifyInstance> = {
      CRM: await createAppServer(ctx, "CRM", registerCrm),
      Orders: await createAppServer(ctx, "Orders", registerOrders),
      Support: await createAppServer(ctx, "Support", registerSupport),
      [HOLDOUT_APP]: await createHoldoutServer(ctx),
    };
    const admin = await createAdminServer(ctx, { origins, adminOrigin: () => adminOrigin });
    for (const app of APP_NAMES) {
      const s = apps[app];
      servers.push(s);
      await s.listen({ host, port: ports[app] });
      origins[app] = originFor(host, s);
    }
    servers.push(admin);
    await admin.listen({ host, port: adminPort });
    adminOrigin = originFor(host, admin);
  } catch (err) {
    await closeAll();
    store.close();
    throw err;
  }

  if (!manager.current && opts.defaultScenario !== null) manager.load(opts.defaultScenario ?? DEFAULT_SCENARIO);

  let closed = false;
  return {
    adminOrigin,
    origins: { ...origins },
    manager,
    store,
    getVariations: () => structuredClone(ctx.variations.get()),
    setVariations: (v) => void ctx.variations.set(v),
    stats: () => ctx.stats.snapshot(),
    routes: () => ctx.routes.snapshot(),
    async close() {
      if (closed) return;
      closed = true;
      await closeAll();
      store.close();
    },
  };
}
