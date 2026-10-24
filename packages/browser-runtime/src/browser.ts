import { chromium, type Browser, type BrowserContext } from "playwright";

export interface ContextOptions {
  /** Origins (scheme://host:port) the context may load. Everything else is aborted. */
  allowedOrigins: string[];
  /** Abort every non-GET request (exploration and dry-run probes cannot mutate state). */
  blockMutations?: boolean;
  storageState?: Awaited<ReturnType<BrowserContext["storageState"]>>;
  viewport?: { width: number; height: number };
}

export interface GuardStats {
  blockedOrigins: number;
  blockedMutations: number;
  requests: number;
}

/**
 * One warm Chromium process shared by all workers and scouts. Contexts are cheap (separate
 * cookie jars and caches), so isolation is per context rather than per process.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  readonly guardStats = new WeakMap<BrowserContext, GuardStats>();

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

  async newContext(opts: ContextOptions): Promise<BrowserContext> {
    const browser = await this.get();
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 860 },
      storageState: opts.storageState,
      // Keep service workers out of the picture so routing sees every request.
      serviceWorkers: "block",
    });
    const stats: GuardStats = { blockedOrigins: 0, blockedMutations: 0, requests: 0 };
    this.guardStats.set(context, stats);
    const allowed = new Set(opts.allowedOrigins.map((o) => new URL(o).origin));
    await context.route("**/*", async (route) => {
      const req = route.request();
      stats.requests++;
      let origin: string;
      try {
        origin = new URL(req.url()).origin;
      } catch {
        stats.blockedOrigins++;
        return route.abort("blockedbyclient");
      }
      if (req.url().startsWith("data:") || req.url().startsWith("about:")) return route.continue();
      if (!allowed.has(origin)) {
        stats.blockedOrigins++;
        return route.abort("blockedbyclient");
      }
      if (opts.blockMutations && req.method() !== "GET" && req.method() !== "HEAD") {
        stats.blockedMutations++;
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    return context;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }
}
