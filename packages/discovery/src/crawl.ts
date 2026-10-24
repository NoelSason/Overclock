import { createHash } from "node:crypto";
import type { Page } from "playwright";
import type { AppBinding, AppModel, AppPage } from "@overclock/contracts";
import { settle, type BrowserManager, type StorageState } from "@overclock/browser-runtime";
import { observe, routePattern, toAppControls, type Observation } from "@overclock/perception";

const UNSAFE_LINK = /(log ?out|sign ?out|logoff|delete|remove|unsubscribe|deactivate)/i;
const DISMISS = /^(dismiss|close|got it|ok|okay|no thanks|continue|×|✕|x)$/i;

export interface CrawlOptions {
  browser: BrowserManager;
  app: AppBinding;
  storageState?: StorageState | undefined;
  maxPages?: number;
  maxPerPattern?: number;
  signal?: AbortSignal;
}

export interface CrawlResult {
  model: AppModel;
  observations: Observation[];
  dismissedDialogs: string[];
}

/** Dismiss a blocking informational dialog during exploration (mutations are blocked anyway). */
async function clearDialogs(page: Page, obs: Observation): Promise<string | null> {
  const open = obs.dialogs.find((d) => d.open);
  if (!open) return null;
  for (const id of open.controlIds) {
    const c = obs.controls.find((x) => x.id === id);
    if (c && c.role === "button" && DISMISS.test(c.name)) {
      await page.locator(c.cssPath).click({ timeout: 2000 }).catch(() => undefined);
      return `${open.title || "dialog"} (dismissed with "${c.name}")`;
    }
  }
  return null;
}

/**
 * UI Scout, deterministic part: bounded breadth-first exploration of one application in a
 * context that aborts every non-GET request. Visits up to `maxPerPattern` concrete pages per
 * route pattern (e.g. two `/orders/:id` pages) and measures real page-load latency.
 */
export async function crawlApp(opts: CrawlOptions): Promise<CrawlResult> {
  const start = performance.now();
  const ctx = await opts.browser.newContext({ allowedOrigins: [opts.app.origin], blockMutations: true, storageState: opts.storageState });
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
  const origin = new URL(opts.app.origin).origin;
  const maxPages = opts.maxPages ?? 14;
  const maxPer = opts.maxPerPattern ?? 2;
  const queue: string[] = [origin + "/"];
  const seenUrls = new Set<string>();
  const perPattern = new Map<string, number>();
  const observations: Observation[] = [];
  const loads = new Map<string, number[]>();
  const dismissed: string[] = [];
  let blocked = 0;
  try {
    while (queue.length && observations.length < maxPages) {
      if (opts.signal?.aborted) break;
      const url = queue.shift()!;
      const key = url.replace(/[?&]page=\d+/, "");
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);
      const t0 = performance.now();
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
      const loadMs = performance.now() - t0;
      if (!resp || resp.status() >= 400) continue;
      // Client-rendered apps fill the page after DOMContentLoaded: wait for requests and DOM to settle.
      await settle(page, { maxMs: 2500 });
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== origin) continue;
      const pattern = routePattern(finalUrl);
      const n = perPattern.get(pattern) ?? 0;
      if (n >= maxPer) continue;
      perPattern.set(pattern, n + 1);
      seenUrls.add(finalUrl.replace(/[?&]page=\d+/, ""));
      let obs = await observe(page);
      const d = await clearDialogs(page, obs);
      if (d) {
        dismissed.push(d);
        await settle(page, { maxMs: 1000 });
        obs = await observe(page);
      }
      obs.metrics.navMs = Math.round(loadMs);
      (loads.get(pattern) ?? loads.set(pattern, []).get(pattern)!).push(loadMs);
      observations.push(obs);
      // Breadth-first: navigation links first, then a couple of record links per table.
      const links = obs.raw.controls.filter((c) => c.role === "link" && c.href && !UNSAFE_LINK.test(c.name) && !UNSAFE_LINK.test(c.href));
      const nav = links.filter((c) => !c.cssPath.includes("td"));
      const records = links.filter((c) => c.cssPath.includes("td")).slice(0, 2);
      for (const c of [...nav, ...records]) {
        let abs: URL;
        try {
          abs = new URL(c.href!, finalUrl);
        } catch {
          continue;
        }
        if (abs.origin !== origin) continue;
        abs.hash = "";
        const p = routePattern(abs.toString());
        if ((perPattern.get(p) ?? 0) >= maxPer) continue;
        if (!seenUrls.has(abs.toString().replace(/[?&]page=\d+/, ""))) queue.push(abs.toString());
      }
    }
  } finally {
    blocked = opts.browser.guardStats.get(ctx)?.blockedMutations ?? 0;
    await ctx.close();
  }
  return { model: buildAppModel(opts.app, observations, loads, performance.now() - start, blocked), observations, dismissedDialogs: dismissed };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
}

export function buildAppModel(app: AppBinding, observations: Observation[], loads: Map<string, number[]>, ms: number, blockedMutations: number): AppModel {
  const controls: AppModel["controls"] = {};
  const pages: AppPage[] = [];
  const byPattern = new Map<string, Observation[]>();
  for (const o of observations) (byPattern.get(o.routePattern) ?? byPattern.set(o.routePattern, []).get(o.routePattern)!).push(o);
  for (const [pattern, obsList] of byPattern) {
    const first = obsList[0]!;
    const ctrls = toAppControls(app.name, first);
    // A control is stable if it also appears on the second sample of the same pattern.
    const second = obsList[1] ? new Set(toAppControls(app.name, obsList[1]).map((c) => c.id)) : null;
    for (const c of ctrls) {
      if (second && !second.has(c.id) && c.kind !== "fact") c.locator.confidence = Math.min(c.locator.confidence, 0.6);
      controls[c.id] = c;
    }
    pages.push({
      routePattern: pattern,
      exampleUrl: first.url,
      title: first.title,
      headings: first.headings,
      controlIds: ctrls.map((c) => c.id),
      tables: first.tables,
      facts: first.facts.map((f) => f.label),
      forms: first.forms.map((f) => ({ id: f.id, method: f.method, action: f.action, fieldIds: f.fieldIds.map((cid) => ctrls.find((c) => c.locator.evidence[0]?.controlId === cid)?.id).filter((x): x is string => !!x), submitIds: f.submitIds.map((cid) => ctrls.find((c) => c.locator.evidence[0]?.controlId === cid)?.id).filter((x): x is string => !!x) })),
      loadMs: { p50: Math.round(median(loads.get(pattern) ?? [0])), samples: loads.get(pattern)?.length ?? 0 },
      fingerprint: first.fingerprint.page,
      observationId: first.id,
    });
  }
  const listTables = pages.flatMap((p) =>
    p.tables
      .filter((t) => t.rowCount >= 3)
      .map((t) => {
        const ctrl = p.controlIds.map((id) => controls[id]!).find((c) => c.kind === "table" && c.detail === t.headers.join(" | "));
        const paginated = p.controlIds.some((id) => controls[id]?.kind === "pagination");
        const text = byPattern.get(p.routePattern)?.[0]?.text ?? "";
        const m = /page\s+\d+\s+of\s+(\d+)/i.exec(text);
        return { page: p.routePattern, controlId: ctrl?.id ?? "", headers: t.headers, rowsPerPage: t.rowCount, paginated, pages: m ? Number(m[1]) : undefined };
      }),
  );
  const bulkOperations = pages
    .filter((p) => /import|bulk|batch|csv/i.test(`${p.routePattern} ${p.title} ${p.headings.join(" ")}`) && p.forms.some((f) => f.method === "post"))
    .map((p) => ({ page: p.routePattern, description: `${p.title}: ${p.headings.join(" / ")}`, controlIds: p.controlIds.filter((id) => ["textarea", "input", "button"].includes(controls[id]!.kind)) }));
  const search = pages.flatMap((p) => p.forms.filter((f) => f.method === "get").flatMap((f) => f.fieldIds.slice(0, 1).map((controlId) => ({ page: p.routePattern, controlId }))));
  const fp = createHash("sha1")
    .update(
      pages
        .map((p) => p.fingerprint)
        .sort()
        .join("|"),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    app: app.name,
    origin: app.origin,
    pages,
    controls,
    operations: [],
    features: { listTables, bulkOperations, search },
    fingerprint: fp,
    crawl: { pagesVisited: observations.length, ms: Math.round(ms), blockedMutations },
  };
}
