import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppModel, DslPlan } from "@overclock/contracts";
import { BrowserManager, SessionManager, type Credentials, type StorageState } from "@overclock/browser-runtime";
import { claudeConfigFromEnv, jevConfigFromEnv, ModelLedger } from "@overclock/models";
import type { CachedProgram, ProgramCache } from "@overclock/swarm";
import { repoRoot } from "@overclock/telemetry";
import { NetworkService } from "./network";

export interface EngineConfig {
  port: number;
  host: string;
  dataDir: string;
  runtimeLabel: string;
  headless: boolean;
  budgetUsd: number | undefined;
}

export function engineConfigFromEnv(): EngineConfig {
  const root = repoRoot();
  return {
    port: Number(process.env.OVERCLOCK_ENGINE_PORT ?? 4000),
    host: process.env.OVERCLOCK_ENGINE_HOST ?? "127.0.0.1",
    dataDir: process.env.OVERCLOCK_DATA_DIR || join(root, ".data", "engine"),
    runtimeLabel: process.env.OVERCLOCK_RUNTIME_LABEL || "runtime-a",
    headless: process.env.OVERCLOCK_HEADLESS !== "0",
    budgetUsd: process.env.OVERCLOCK_ENGINE_BUDGET_USD ? Number(process.env.OVERCLOCK_ENGINE_BUDGET_USD) : undefined,
  };
}

/**
 * Credentials come only from the engine's environment, never from run configs:
 *  - execution: ARENA_USERNAME / ARENA_PASSWORD (or OVERCLOCK_APP_CREDENTIALS JSON by origin);
 *  - exploration: ARENA_VIEWER_USERNAME / ARENA_VIEWER_PASSWORD (a read-only role, when the app has one).
 */
function credentialTable(): Record<string, { username: string; password: string; viewer?: { username: string; password: string } }> {
  try {
    return process.env.OVERCLOCK_APP_CREDENTIALS ? JSON.parse(process.env.OVERCLOCK_APP_CREDENTIALS) : {};
  } catch {
    return {};
  }
}

export function executionCredentials(_app: string, origin: string): Credentials | undefined {
  const t = credentialTable()[new URL(origin).origin];
  if (t) return { username: t.username, password: t.password };
  return { username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" };
}

export function explorationCredentials(_app: string, origin: string): Credentials | undefined {
  const t = credentialTable()[new URL(origin).origin];
  if (t?.viewer) return t.viewer;
  if (t) return undefined;
  return { username: process.env.ARENA_VIEWER_USERNAME || "viewer", password: process.env.ARENA_VIEWER_PASSWORD || "overclock-viewer" };
}

/** Local program cache for warm starts (knowledge policy local-only). Per runtime data dir. */
export class FileProgramCache implements ProgramCache {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^a-z0-9|.,:-]/gi, "_").replace(/[|:,]/g, "_").slice(0, 180)}.json`);
  }
  /**
   * The entry stored under exactly this key. File names are truncated, and entries written before
   * operation identities were exact have no key, so an entry whose stored key differs is ignored:
   * a plan is never served for an operation it wasn't written for.
   */
  get(key: string): CachedProgram | undefined {
    const p = this.path(key);
    if (!existsSync(p)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(p, "utf8")) as CachedProgram;
      return entry.key === key ? entry : undefined;
    } catch {
      return undefined;
    }
  }
  put(key: string, value: CachedProgram): void {
    writeFileSync(this.path(key), JSON.stringify({ ...value, key }));
  }
}

/** Process-wide resources shared by all runs of one engine (one warm browser, one ledger). */
export class EngineRuntime {
  readonly browser: BrowserManager;
  readonly executeSessions: SessionManager;
  readonly exploreSessions: SessionManager;
  readonly ledger: ModelLedger;
  readonly cache: FileProgramCache;
  readonly network: NetworkService;
  readonly claudeConfig = claudeConfigFromEnv();
  readonly jevConfig = jevConfigFromEnv();

  constructor(readonly config: EngineConfig) {
    mkdirSync(config.dataDir, { recursive: true });
    this.browser = new BrowserManager({ headless: config.headless });
    this.executeSessions = new SessionManager(this.browser, executionCredentials);
    this.exploreSessions = new SessionManager(this.browser, explorationCredentials);
    this.ledger = new ModelLedger(config.budgetUsd);
    this.cache = new FileProgramCache(join(config.dataDir, "program-cache"));
    this.network = new NetworkService(config.dataDir, config.runtimeLabel);
  }

  /** Explorer session (read-only role) when available; otherwise the operator session (exploration contexts still block all mutations). */
  async exploreState(apps: { name: string; origin: string }[]): Promise<{ state: StorageState | undefined; role: "viewer" | "operator" }> {
    try {
      return { state: await this.exploreSessions.storageStateFor(apps), role: "viewer" };
    } catch {
      return { state: await this.executeSessions.storageStateFor(apps), role: "operator" };
    }
  }

  async close(): Promise<void> {
    await this.network.close().catch(() => undefined);
    await this.browser.close();
  }
}
