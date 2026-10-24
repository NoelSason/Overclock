import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

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
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  readonly guardStats = new WeakMap<BrowserContext, GuardStats>();
  private readonly readOnlyPages = new WeakSet<Page>();

  constructor(private readonly opts: { headless?: boolean } = {}) {}

  async get(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= chromium.launch({ headless: this.opts.headless ?? process.env.OVERCLOCK_HEADLESS !== "0" }).then((b) => {
      this.browser = b;
      this.launching = null;
      return b;
    });
    return this.launching;
  }

  /** Mark a page read-only (true) or allow it to write (false). */
  setReadOnly(page: Page, readOnly: boolean): void {
    if (readOnly) this.readOnlyPages.add(page);
    else this.readOnlyPages.delete(page);
  }

  async newContext(opts: ContextOptions): Promise<BrowserContext> {
    const browser = await this.get();
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 860 },
      storageState: opts.storageState,
      // Keep service workers out of the picture so routing sees every request.
      serviceWorkers: "block",
    });
    // esbuild (via tsx) may wrap nested functions in __name(...) when serializing page.evaluate
    // callbacks; define it in every document so evaluated code runs unchanged.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
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
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
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
  let inflight = 0;
  const onReq = () => inflight++;
  const onDone = () => (inflight = Math.max(0, inflight - 1));
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
      if (m !== lastMut || inflight > 0) {
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
