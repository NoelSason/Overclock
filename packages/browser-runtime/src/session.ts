import type { BrowserContext } from "playwright";
import type { BrowserManager } from "./browser";

export interface Credentials {
  username: string;
  password: string;
}

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * Establishes one authenticated session per application and shares its storage state across
 * worker contexts (session ownership stays with this manager). Login is generic: if the app
 * redirects to a page with a password field, fill the username-like field and the password
 * field and submit. Credentials come from the engine's environment, never from run configs,
 * and are never logged.
 */
export class SessionManager {
  private readonly states = new Map<string, Promise<StorageState | undefined>>();

  constructor(
    private readonly browser: BrowserManager,
    private readonly credentialsFor: (app: string, origin: string) => Credentials | undefined,
  ) {}

  storageStateFor(apps: { name: string; origin: string }[]): Promise<StorageState | undefined> {
    const key = apps
      .map((a) => a.origin)
      .sort()
      .join("|");
    let p = this.states.get(key);
    if (!p) {
      p = this.login(apps);
      this.states.set(key, p);
      p.catch(() => this.states.delete(key));
    }
    return p;
  }

  invalidate(): void {
    this.states.clear();
  }

  private async login(apps: { name: string; origin: string }[]): Promise<StorageState | undefined> {
    const ctx = await this.browser.newContext({ allowedOrigins: apps.map((a) => a.origin) });
    const loginTo = async (app: { name: string; origin: string }) => {
      const page = await ctx.newPage();
      await page.goto(app.origin, { waitUntil: "domcontentloaded" });
      const password = page.locator("input[type=password]");
      if ((await password.count()) === 0) {
        await page.close();
        return;
      }
      const creds = this.credentialsFor(app.name, app.origin);
      if (!creds) throw new Error(`No credentials configured for ${app.name}; it requires login`);
      const user = page.locator("input[type=email], input[type=text], input[name*=user i], input[name*=email i]").first();
      await user.fill(creds.username);
      await password.first().fill(creds.password);
      await Promise.all([page.waitForLoadState("domcontentloaded"), password.first().press("Enter")]);
      await page.waitForLoadState("domcontentloaded");
      if ((await page.locator("input[type=password]").count()) > 0) throw new Error(`Login to ${app.name} failed`);
      await page.close();
    };
    try {
      // One page per app, concurrently: each origin sets its own session cookie in the shared
      // context. The first failure in app order is reported, so the error doesn't depend on timing.
      const results = await Promise.allSettled(apps.map(loginTo));
      for (const r of results) if (r.status === "rejected") throw r.reason;
      return await ctx.storageState();
    } finally {
      await ctx.close();
    }
  }
}
