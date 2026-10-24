import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { LogLine, Stagehand, V3Options } from "@browserbasehq/stagehand";
import type { Browser, BrowserContext, Page } from "playwright";
import { ExternalBaselineUnavailableError, type BaselineModel } from "./contract";
import type { ModelMiddleware } from "./meter";

/**
 * Browser side of the Stagehand baseline: launch Stagehand's own local Chromium (the Playwright
 * build Overclock uses), enforce the origin allowlist, and log in with code before the agent
 * starts. Credentials never reach the model.
 */

export const FRAMEWORK = "stagehand";
const PACKAGE = "@browserbasehq/stagehand";

type StagehandCtor = new (opts: V3Options) => Stagehand;

export interface Framework {
  Stagehand: StagehandCtor;
  chromium: typeof import("playwright").chromium;
  version: string;
  executablePath: string;
}

/** Load Stagehand and Playwright's Chromium, or explain why this environment cannot run them. */
export async function loadFramework(): Promise<Framework> {
  let mod: typeof import("@browserbasehq/stagehand");
  let version: string;
  try {
    mod = await import("@browserbasehq/stagehand");
    version = (createRequire(import.meta.url)(`${PACKAGE}/package.json`) as { version: string }).version;
  } catch (err) {
    throw new ExternalBaselineUnavailableError(`${PACKAGE} could not be loaded: ${(err as Error).message}`);
  }
  let chromium: typeof import("playwright").chromium;
  try {
    chromium = (await import("playwright")).chromium;
  } catch (err) {
    throw new ExternalBaselineUnavailableError(`playwright could not be loaded: ${(err as Error).message}`);
  }
  const executablePath = process.env.OVERCLOCK_STAGEHAND_CHROME || chromium.executablePath();
  if (!executablePath || !existsSync(executablePath)) {
    throw new ExternalBaselineUnavailableError(`Chromium not found at ${executablePath || "(none)"}; run "pnpm exec playwright install chromium"`);
  }
  return { Stagehand: mod.Stagehand as unknown as StagehandCtor, chromium, version, executablePath };
}

export interface GuardStats {
  requests: number;
  blocked: number;
  /** Distinct origins that were refused. */
  blockedOrigins: Set<string>;
}

/** Abort every request whose origin is not one of the applications' origins (same rule as Overclock's BrowserManager). */
export async function installOriginGuard(context: BrowserContext, origins: string[]): Promise<GuardStats> {
  const allowed = new Set(origins.map((o) => new URL(o).origin));
  const stats: GuardStats = { requests: 0, blocked: 0, blockedOrigins: new Set() };
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    stats.requests++;
    if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) return route.continue().catch(() => undefined);
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      // unparseable: refuse
    }
    if (!allowed.has(origin)) {
      stats.blocked++;
      stats.blockedOrigins.add(origin || url.slice(0, 80));
      return route.abort("blockedbyclient").catch(() => undefined);
    }
    return route.continue().catch(() => undefined);
  });
  return stats;
}

/**
 * Generic login, same rule as Overclock's SessionManager: open each app; if it shows a password
 * field, fill the username-like field and the password and submit.
 */
export async function login(page: Page, apps: { name: string; origin: string }[], creds: { username: string; password: string }): Promise<void> {
  for (const app of apps) {
    await page.goto(app.origin, { waitUntil: "domcontentloaded" });
    const password = page.locator("input[type=password]");
    if ((await password.count()) === 0) continue;
    await page.locator("input[type=email], input[type=text], input[name*=user i], input[name*=email i]").first().fill(creds.username);
    await password.first().fill(creds.password);
    await Promise.all([page.waitForEvent("domcontentloaded"), password.first().press("Enter")]);
    if ((await page.locator("input[type=password]").count()) > 0) throw new Error(`Login to ${app.name} failed`);
  }
}

export interface StagehandSession {
  stagehand: Stagehand;
  /** Playwright's view of Stagehand's browser context (same pages, same cookies). */
  context: BrowserContext;
  guard: GuardStats;
  /** Stagehand log lines at error level, most recent last (for diagnostics; never includes the API key). */
  errors: string[];
  close(): Promise<void>;
}

export interface SessionOptions {
  framework: Framework;
  applications: { name: string; origin: string }[];
  credentials: { username: string; password: string };
  model: BaselineModel;
  apiKey: string;
  middleware?: ModelMiddleware;
  headless?: boolean;
}

/** Launch Stagehand locally, guard the origins, log in, and leave the page on the first app's start page. */
export async function openStagehandSession(o: SessionOptions): Promise<StagehandSession> {
  const errors: string[] = [];
  const stagehand = new o.framework.Stagehand({
    env: "LOCAL",
    model: { modelName: `anthropic/${o.model}`, apiKey: o.apiKey, ...(o.middleware ? { middleware: o.middleware } : {}) },
    localBrowserLaunchOptions: { executablePath: o.framework.executablePath, headless: o.headless ?? process.env.OVERCLOCK_HEADLESS !== "0", viewport: { width: 1280, height: 860 } },
    verbose: 0,
    disablePino: true,
    logger: (line: LogLine) => {
      if (line.level !== 0) return;
      errors.push(`${line.category ?? "stagehand"}: ${line.message}`.slice(0, 300));
      if (errors.length > 20) errors.shift();
    },
  });
  let pw: Browser | null = null;
  const close = async () => {
    await pw?.close().catch(() => undefined);
    await stagehand.close().catch(() => undefined);
  };
  try {
    await stagehand.init();
    pw = await o.framework.chromium.connectOverCDP(stagehand.connectURL());
    const context = pw.contexts()[0];
    if (!context) throw new Error("Stagehand's browser exposed no default context");
    const guard = await installOriginGuard(
      context,
      o.applications.map((a) => a.origin),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await login(page, o.applications, o.credentials);
    const first = o.applications[0];
    if (first) await page.goto(first.origin, { waitUntil: "domcontentloaded" });
    return { stagehand, context, guard, errors, close };
  } catch (err) {
    await close();
    throw err;
  }
}
