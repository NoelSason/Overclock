import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const SERVER_SCRIPT = fileURLToPath(new URL("../browser-server.mjs", import.meta.url));

/** Extra Chromium command-line switches (OVERCLOCK_CHROMIUM_ARGS, space-separated). */
function chromiumArgs(): string[] {
  return (process.env.OVERCLOCK_CHROMIUM_ARGS ?? "").split(/\s+/).filter(Boolean);
}

/** Start a browser server process and return its endpoint (first stdout line). */
async function startBrowserServer(headless: boolean): Promise<{ child: ChildProcess; wsEndpoint: string }> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, OVERCLOCK_HEADLESS: headless ? "1" : "0" } });
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("browser server did not start within 30 s")), 30_000);
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(buf.slice(0, nl).trim());
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`browser server exited with code ${code}`));
    });
  });
  return { child, wsEndpoint };
}

export interface ContextOptions {
  /** Origins (scheme://host:port) the context may load. Everything else is aborted. */
  allowedOrigins: string[];
  /**
   * Exploration mode: abort every non-GET request, every GET that looks state-changing
   * (logout, delete, approve, unsubscribe, action=…), and all WebSocket connections, so scouts
   * and dry-run probes cannot change application state even through unusual endpoints.
   */
  blockMutations?: boolean;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
  viewport?: { width: number; height: number };
}

export interface GuardStats {
  blockedOrigins: number;
  blockedMutations: number;
  blockedRiskyGets: number;
  blockedWebSockets: number;
  requests: number;
}

/** GET URLs that commonly change state despite the method. Matched against path + query. */
export const RISKY_GET = /(\/|\b)(log-?out|sign-?out|logoff|delete|destroy|remove|unsubscribe|approve|reject|confirm|toggle|archive|cancel|purchase|checkout|pay|send|publish|reset)(\b|\/|$)|[?&](action|op|do|cmd|delete|remove|confirm)=/i;

/**
 * One warm Chromium process shared by all workers and scouts. Contexts are cheap (separate
 * cookie jars and caches), so isolation is per context rather than per process.
 *
 * Execution contexts additionally enforce a per-page mutation policy: the scheduler marks a page
 * read-only while it runs a read fragment, so an early-released read fragment cannot write even
 * if a click unexpectedly triggers a state-changing request (non-GET, or a GET matching RISKY_GET).
 */
export class BrowserManager {
  /**
   * Chromium processes. Every context's protocol traffic, and every request the route guard
   * pauses, passes through its browser's main process, which saturates one core at about 16
   * busy contexts. Contexts are therefore spread over several browsers (OVERCLOCK_BROWSERS,
   * default 4), each launched on first use.
   */
  private readonly browsers: (Browser | null)[];
  private readonly launching: (Promise<Browser> | null)[];
  private readonly contextsOn: number[];
  /** Server processes, when each browser runs behind its own (OVERCLOCK_BROWSER_SERVERS=1). */
  private readonly servers: (ChildProcess | null)[];
  private readonly useServers: boolean;
  readonly guardStats = new WeakMap<BrowserContext, GuardStats>();
  private readonly readOnlyPages = new WeakSet<Page>();

  constructor(private readonly opts: { headless?: boolean; browsers?: number; servers?: boolean } = {}) {
    const n = Math.max(1, Math.floor(opts.browsers ?? (Number(process.env.OVERCLOCK_BROWSERS) || 4)));
    this.browsers = Array.from({ length: n }, () => null);
    this.launching = Array.from({ length: n }, () => null);
    this.contextsOn = Array.from({ length: n }, () => 0);
    this.servers = Array.from({ length: n }, () => null);
    this.useServers = opts.servers ?? process.env.OVERCLOCK_BROWSER_SERVERS === "1";
  }

  /** The first browser (launching it if needed); contexts come from newContext. */
  async get(i = 0): Promise<Browser> {
    const b = this.browsers[i];
    if (b?.isConnected()) return b;
    const headless = this.opts.headless ?? process.env.OVERCLOCK_HEADLESS !== "0";
    this.launching[i] ??= (async () => {
      let launched: Browser;
      if (this.useServers) {
        this.servers[i]?.kill("SIGTERM");
        const { child, wsEndpoint } = await startBrowserServer(headless);
        this.servers[i] = child;
        launched = await chromium.connect(wsEndpoint);
      } else launched = await chromium.launch({ headless, args: chromiumArgs() });
      this.browsers[i] = launched;
      this.launching[i] = null;
      return launched;
    })().catch((err: unknown) => {
      this.launching[i] = null;
      throw err;
    });
    return this.launching[i]!;
  }

  /** Mark a page read-only (true) or allow it to write (false). */
  setReadOnly(page: Page, readOnly: boolean): void {
    if (readOnly) this.readOnlyPages.add(page);
    else this.readOnlyPages.delete(page);
  }

  async newContext(opts: ContextOptions): Promise<BrowserContext> {
    // The browser with the fewest open contexts (ties: the lowest index).
    let i = 0;
    for (let k = 1; k < this.contextsOn.length; k++) if (this.contextsOn[k]! < this.contextsOn[i]!) i = k;
    this.contextsOn[i]!++;
    let browser: Browser;
    try {
      browser = await this.get(i);
    } catch (err) {
      this.contextsOn[i]!--;
      throw err;
    }
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 860 },
      storageState: opts.storageState,
      // Keep service workers out of the picture so routing sees every request.
      serviceWorkers: "block",
    });
    // esbuild (via tsx) may wrap nested functions in __name(...) when serializing page.evaluate
    // callbacks; define it in every document so evaluated code runs unchanged.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
    context.once("close", () => this.contextsOn[i]!--);
    const stats: GuardStats = { blockedOrigins: 0, blockedMutations: 0, blockedRiskyGets: 0, blockedWebSockets: 0, requests: 0 };
    this.guardStats.set(context, stats);
    const allowed = new Set(opts.allowedOrigins.map((o) => new URL(o).origin));
    await context.route("**/*", async (route) => {
      const req = route.request();
      stats.requests++;
      const url = req.url();
      if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) return route.continue();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        stats.blockedOrigins++;
        return route.abort("blockedbyclient");
      }
      if (!allowed.has(parsed.origin)) {
        stats.blockedOrigins++;
        return route.abort("blockedbyclient");
      }
      const mutating = req.method() !== "GET" && req.method() !== "HEAD" && req.method() !== "OPTIONS";
      let page: Page | null = null;
      try {
        page = req.frame().page();
      } catch {
        page = null; // service-worker or detached frame
      }
      const readOnly = opts.blockMutations || (page !== null && this.readOnlyPages.has(page));
      if (readOnly && mutating) {
        stats.blockedMutations++;
        return route.abort("blockedbyclient");
      }
      // A read-only execution page (a released read fragment) gets the same GET screen as an
      // exploration context: following a logout or delete link would change state as surely as a POST.
      if (readOnly && RISKY_GET.test(parsed.pathname + parsed.search)) {
        stats.blockedRiskyGets++;
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    if (opts.blockMutations) {
      await context.routeWebSocket(/.*/, (ws) => {
        stats.blockedWebSockets++;
        void ws.close({ code: 1008, reason: "exploration context" });
      });
    }
    return context;
  }

  async close(): Promise<void> {
    const open = this.browsers.filter((b): b is Browser => b !== null);
    this.browsers.fill(null);
    await Promise.all(open.map((b) => b.close().catch(() => undefined)));
    for (const c of this.servers) c?.kill("SIGTERM");
    this.servers.fill(null);
  }
}

/** Requests in flight per tracked page, counted for the page's whole life (see trackActivity). */
const activity = new WeakMap<Page, { inflight: number }>();

/**
 * Count a page's requests for its whole life, so settle() also sees requests that started before
 * it was called (a client-rendered page's data fetch issued during load). Idempotent.
 */
export function trackActivity(page: Page): void {
  if (activity.has(page)) return;
  const a = { inflight: 0 };
  activity.set(page, a);
  page.on("request", () => a.inflight++);
  page.on("requestfinished", () => (a.inflight = Math.max(0, a.inflight - 1)));
  page.on("requestfailed", () => (a.inflight = Math.max(0, a.inflight - 1)));
}

/**
 * Wait until a page has settled: no in-flight requests and no DOM mutations for `quietMs`
 * (bounded by `maxMs`). Needed for client-rendered applications whose content appears after
 * DOMContentLoaded; static server-rendered pages settle in about `quietMs`.
 */
export async function settle(page: Page, opts: { maxMs?: number; quietMs?: number } = {}): Promise<number> {
  const start = performance.now();
  const maxMs = opts.maxMs ?? 2000;
  const quietMs = opts.quietMs ?? 100;
  const tracked = activity.get(page);
  let local = 0;
  const inflightNow = () => (tracked ? tracked.inflight : local);
  const onReq = () => local++;
  const onDone = () => (local = Math.max(0, local - 1));
  page.on("request", onReq);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  try {
    await page
      .evaluate(() => {
        const w = window as unknown as { __ocMut?: number };
        if (w.__ocMut === undefined) {
          w.__ocMut = 0;
          new MutationObserver(() => (w.__ocMut = (w.__ocMut ?? 0) + 1)).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        }
      })
      .catch(() => undefined);
    let lastMut = -1;
    let quietSince = performance.now();
    while (performance.now() - start < maxMs) {
      const m = await page.evaluate(() => (window as unknown as { __ocMut?: number }).__ocMut ?? 0).catch(() => -2);
      if (m !== lastMut || inflightNow() > 0) {
        lastMut = m;
        quietSince = performance.now();
      } else if (performance.now() - quietSince >= quietMs) break;
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally {
    page.off("request", onReq);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
  }
  return performance.now() - start;
}
