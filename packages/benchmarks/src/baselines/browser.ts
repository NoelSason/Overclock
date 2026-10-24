import type { Locator, Page } from "playwright";
import type { ObservedControl } from "@overclock/contracts";
import type { BrowserWorker } from "@overclock/browser-runtime";
import { observe, type Observation } from "@overclock/perception";
import { controlName, describeControl, isCheckable, isSelect, isTextEntry, type SequentialStep } from "./prompt";

/**
 * Browser side of the sequential baseline: executes one model-chosen action against the current
 * page, waits for the page to settle, and reports what happened in plain words for the model.
 */

type AriaRole = Parameters<Page["getByRole"]>[0];

const ACTION_TIMEOUT_MS = 5_000;
const NAV_TIMEOUT_MS = 15_000;
const SETTLE_MS = 5_000;

export interface AppTarget {
  name: string;
  origin: string;
}

/** Per-context request bookkeeping: in-flight requests (for settling), writes, and navigation status. */
export class PageTracker {
  /** State-changing requests (non-GET/HEAD) that got a response below 400. */
  writes = 0;
  /** Statuses of state-changing responses since the last `beginAction`. */
  actionWrites: number[] = [];
  /** Main-frame document status since the last `beginAction`. */
  navStatus: number | null = null;
  private readonly inflight = new Map<Page, number>();
  private readonly attached = new WeakSet<Page>();

  attach(page: Page): void {
    if (this.attached.has(page)) return;
    this.attached.add(page);
    const tracked = (t: string) => t === "document" || t === "xhr" || t === "fetch";
    const dec = (r: { resourceType(): string }) => {
      if (tracked(r.resourceType())) this.inflight.set(page, Math.max(0, (this.inflight.get(page) ?? 0) - 1));
    };
    page.on("request", (r) => {
      if (tracked(r.resourceType())) this.inflight.set(page, (this.inflight.get(page) ?? 0) + 1);
    });
    page.on("requestfinished", dec);
    page.on("requestfailed", dec);
    page.on("response", (res) => {
      const req = res.request();
      const method = req.method();
      if (method !== "GET" && method !== "HEAD") {
        this.actionWrites.push(res.status());
        if (res.status() < 400) this.writes++;
      }
      if (req.isNavigationRequest() && res.frame() === page.mainFrame()) this.navStatus = res.status();
    });
  }

  pending(page: Page): number {
    return this.inflight.get(page) ?? 0;
  }

  beginAction(): void {
    this.actionWrites = [];
    this.navStatus = null;
  }
}

export interface BrowserEnv {
  worker: BrowserWorker;
  apps: AppTarget[];
  allowedOrigins: Set<string>;
  tracker: PageTracker;
}

export interface ActionResult {
  ok: boolean;
  /** Plain-language result fed back to the model in the next step's history. */
  message: string;
}

export async function pageFor(env: BrowserEnv, app: string): Promise<Page> {
  const page = await env.worker.pageFor(app);
  env.tracker.attach(page);
  return page;
}

function firstLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return (msg.split("\n")[0] ?? msg).replace(/\s+/g, " ").trim().slice(0, 300);
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Wait for the document, then for in-flight document/XHR requests (bounded), then the document again. */
export async function settle(env: BrowserEnv, page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  const deadline = performance.now() + SETTLE_MS;
  while (env.tracker.pending(page) > 0 && performance.now() < deadline && !page.isClosed()) await page.waitForTimeout(25);
  await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
}

/** Observe the page, retrying briefly if a navigation tears down the execution context mid-read. */
export async function observeSafe(page: Page | undefined): Promise<Observation | null> {
  if (!page || page.isClosed()) return null;
  for (let i = 0; i < 3; i++) {
    try {
      return await observe(page, { maxText: 3000, maxControls: 400 });
    } catch {
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(100).catch(() => undefined);
    }
  }
  return null;
}

function resultSuffix(env: BrowserEnv, page: Page, before: string): string {
  const parts: string[] = [];
  const writes = env.tracker.actionWrites;
  if (writes.length) parts.push(`form submitted (HTTP ${writes.join(", ")})`);
  const now = page.url();
  if (now !== before || env.tracker.navStatus !== null) {
    const status = env.tracker.navStatus;
    parts.push(`page is now ${pathOf(now)}${status !== null && status >= 400 ? ` (HTTP ${status})` : ""}`);
  }
  return parts.length ? `; ${parts.join("; ")}` : "";
}

async function resolve(page: Page, c: ObservedControl): Promise<Locator> {
  const byCss = page.locator(c.cssPath);
  if ((await byCss.count()) === 1) return byCss;
  const name = controlName(c);
  if (name) {
    let l = page.getByRole(c.role as AriaRole, { name, exact: true });
    let n = await l.count();
    if (n > 1) {
      const visible = l.filter({ visible: true });
      const vn = await visible.count();
      if (vn >= 1) {
        l = visible;
        n = vn;
      }
    }
    if (n === 1) return l;
    if (n > 1) throw new Error(`Control ${c.id} is ambiguous: ${n} elements match ${describeControl(c)}`);
  }
  throw new Error(`Control ${c.id} (${describeControl(c)}) is no longer on the page`);
}

/** A visible modal dialog that the target is not part of would swallow the input. */
async function blockingModal(locator: Locator): Promise<string | null> {
  return locator
    .evaluate((el) => {
      const modals = Array.from(document.querySelectorAll<HTMLElement>("[aria-modal=true],dialog[open]"));
      for (const m of modals) {
        const st = getComputedStyle(m);
        if (st.display === "none" || st.visibility === "hidden" || m.closest("[hidden]")) continue;
        const r = m.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (m.contains(el)) return null;
        return (m.innerText || m.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      }
      return null;
    })
    .catch(() => null);
}

const TRUE = /^(true|yes|on|1|checked)$/i;
const FALSE = /^(false|no|off|0|unchecked)$/i;

/** Signature used to detect the same failing action repeated in a row. */
export function actionSignature(s: SequentialStep): string {
  return JSON.stringify([s.action, s.app ?? "", s.path ?? "", s.control ?? "", s.value ?? ""]);
}

export async function executeBrowserAction(env: BrowserEnv, step: SequentialStep, obs: Observation | null): Promise<ActionResult> {
  env.tracker.beginAction();
  if (step.action === "goto") return goto(env, step);
  const page = env.worker.currentPage();
  if (!page || page.isClosed() || !obs) return { ok: false, message: "error: no page is open; use goto first" };
  const id = (step.control ?? "").trim();
  if (!id) return { ok: false, message: `error: ${step.action} needs a control id from the current page` };
  const c = obs.controls.find((x) => x.id === id);
  if (!c) return { ok: false, message: `error: there is no control "${id}" on the current page; use an id from the controls list` };
  const before = page.url();
  let locator: Locator;
  try {
    locator = await resolve(page, c);
  } catch (err) {
    return { ok: false, message: `error: ${firstLine(err)}` };
  }
  if (!(await locator.isVisible().catch(() => false))) {
    if (c.tabPanel) return { ok: false, message: `error: ${describeControl(c)} is inside the tab ${JSON.stringify(c.tabPanel)}, which is not open; click that tab first` };
    return { ok: false, message: `error: ${describeControl(c)} is not visible` };
  }
  const modal = await blockingModal(locator);
  if (modal) return { ok: false, message: `error: a dialog is open and blocks the page (${JSON.stringify(modal)}); respond to the dialog first` };
  if (c.disabled || !(await locator.isEnabled().catch(() => true))) return { ok: false, message: `error: ${describeControl(c)} is disabled` };
  try {
    switch (step.action) {
      case "click": {
        await locator.click({ timeout: ACTION_TIMEOUT_MS });
        await settle(env, page);
        return { ok: true, message: `ok: clicked ${describeControl(c)}${resultSuffix(env, page, before)}` };
      }
      case "fill": {
        const value = step.value ?? "";
        if (isCheckable(c)) {
          await locator.setChecked(TRUE.test(value.trim()), { timeout: ACTION_TIMEOUT_MS });
          return { ok: true, message: `ok: ${describeControl(c)} is now ${TRUE.test(value.trim()) ? "checked" : "unchecked"}` };
        }
        if (isSelect(c)) return { ok: false, message: `error: ${describeControl(c)} is a dropdown; use select` };
        if (!isTextEntry(c)) return { ok: false, message: `error: ${describeControl(c)} is not a text field` };
        await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, message: `ok: ${describeControl(c)} now contains ${JSON.stringify(value)} (not saved until the form is submitted)` };
      }
      case "select": {
        if (!isSelect(c)) return { ok: false, message: `error: ${describeControl(c)} is not a dropdown` };
        const want = (step.value ?? "").trim();
        const options = c.options ?? [];
        const match = options.find((o) => o.value === want) ?? options.find((o) => o.value.toLowerCase() === want.toLowerCase() || o.label.trim().toLowerCase() === want.toLowerCase());
        if (!match) return { ok: false, message: `error: ${describeControl(c)} has no option ${JSON.stringify(want)}; options are ${options.map((o) => JSON.stringify(o.value)).join(", ")}` };
        await locator.selectOption(match.value, { timeout: ACTION_TIMEOUT_MS });
        await settle(env, page);
        return { ok: true, message: `ok: ${describeControl(c)} set to ${JSON.stringify(match.value)} (not saved until the form is submitted)${resultSuffix(env, page, before)}` };
      }
      case "check": {
        if (!isCheckable(c)) return { ok: false, message: `error: ${describeControl(c)} is not a checkbox` };
        const raw = (step.value ?? "true").trim();
        if (!TRUE.test(raw) && !FALSE.test(raw)) return { ok: false, message: `error: check needs value "true" or "false", got ${JSON.stringify(raw)}` };
        const on = TRUE.test(raw);
        await locator.setChecked(on, { timeout: ACTION_TIMEOUT_MS });
        return { ok: true, message: `ok: ${describeControl(c)} is now ${on ? "checked" : "unchecked"} (not saved until the form is submitted)` };
      }
      default:
        return { ok: false, message: `error: ${step.action} is not a browser action` };
    }
  } catch (err) {
    await settle(env, page);
    return { ok: false, message: `error: ${firstLine(err)}${resultSuffix(env, page, before)}` };
  }
}

async function goto(env: BrowserEnv, step: SequentialStep): Promise<ActionResult> {
  const names = env.apps.map((a) => a.name).join(", ");
  const wanted = (step.app ?? "").trim();
  if (!wanted) return { ok: false, message: `error: goto needs an app (one of ${names})` };
  const app = env.apps.find((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (!app) return { ok: false, message: `error: unknown application ${JSON.stringify(wanted)}; use one of ${names}` };
  const path = (step.path ?? "").trim() || "/";
  let url: URL;
  try {
    url = new URL(path, app.origin + "/");
  } catch {
    return { ok: false, message: `error: ${JSON.stringify(path)} is not a valid path` };
  }
  if (!env.allowedOrigins.has(url.origin)) return { ok: false, message: `error: blocked: ${url.origin} is outside the allowlist; goto takes a path on ${app.name}, such as "/"` };
  if (url.origin !== app.origin) return { ok: false, message: `error: ${url.origin} belongs to another application; use that application's name with a relative path` };
  const page = await pageFor(env, app.name);
  try {
    const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await settle(env, page);
    const status = res?.status() ?? 0;
    const landed = pathOf(page.url());
    const redirect = landed !== pathOf(url.toString()) ? ` (redirected to ${landed})` : "";
    if (status >= 400) return { ok: false, message: `error: ${app.name} ${pathOf(url.toString())} returned HTTP ${status}${redirect}` };
    return { ok: true, message: `ok: opened ${app.name} ${pathOf(url.toString())}${redirect}` };
  } catch (err) {
    return { ok: false, message: `error: navigation failed: ${firstLine(err)}` };
  }
}
