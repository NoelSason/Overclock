import type { Locator, Page, Request, Response } from "playwright";
import type { ActionNode, Condition, ExtractField, ExtractTable, SemanticLocator } from "@overclock/contracts";
import { evaluate, evaluateBool, looseEquals, resolveValue, toStr, type Scope } from "@overclock/compiler";
import { AssertionFailedError, HiddenTargetError, LocatorNotFoundError, NavigationError, OriginBlockedError, PreconditionFailedError, RuntimeError, UnexpectedDialogError, WriteRejectedError, WriteUncertainError } from "./errors";
import { settle } from "./browser";
import { resolveLocator, strategyToLocator } from "./locate";

export interface RecordScope {
  key: string;
  rec: Record<string, unknown>;
  input: Record<string, unknown>;
  out: Record<string, unknown>;
  phase: Record<string, unknown>;
}

export function exprScope(s: RecordScope): Scope {
  return { rec: s.rec, input: s.input, out: s.out, phase: s.phase, key: s.key };
}

export interface ActionEnv {
  page: Page;
  origin: string;
  allowedOrigins: Set<string>;
  scope: RecordScope;
  /** Per-node override of the target locator (set by recovery). */
  locatorOverrides: Map<string, SemanticLocator>;
  defaultTimeoutMs: number;
}

export interface ActionOutcome {
  ms: number;
  locatorTier: number | null;
  output?: unknown;
  writeStatus?: number;
}

function absUrl(origin: string, url: string): string {
  return new URL(url, origin.endsWith("/") ? origin : origin + "/").toString();
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Visible modal dialogs that would intercept input. Native dialogs are handled separately by the worker. */
export async function openDialogText(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>("[role=dialog],[role=alertdialog],dialog[open]"));
      for (const el of els) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        if (el.getAttribute("aria-hidden") === "true") continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        return (el.innerText || el.textContent || "").trim().slice(0, 500);
      }
      return null;
    })
    .catch(() => null);
}

async function target(env: ActionEnv, node: ActionNode): Promise<{ locator: Locator; tier: number }> {
  const loc = env.locatorOverrides.get(node.id) ?? node.target;
  if (!loc) throw new RuntimeError(`Node ${node.id} (${node.type}) has no target`, node.id);
  // Fast path, one browser call: the top-ranked strategy matches exactly one visible element, the
  // element resolveLocator and the visibility check below would accept (a strict isVisible throws
  // on several matches and is false for none). It runs in Playwright's utility world, where the
  // action itself runs too, so the page doesn't set up Playwright's selector engine a second time
  // in its main world (about 10 ms per page). The action still runs Playwright's actionability
  // checks. Anything else takes the full path.
  if (!loc.scope && loc.strategies[0]) {
    const first = strategyToLocator(env.page, loc.strategies[0]);
    if (await first.isVisible().catch(() => false)) return { locator: first, tier: 0 };
  }
  try {
    const r = await resolveLocator(env.page, loc, { timeoutMs: Math.min(node.timeoutMs, 2500), nodeId: node.id });
    if (!(await r.locator.isVisible())) {
      // Give late-rendering pages a brief moment before declaring the control hidden.
      const visible = await r.locator.waitFor({ state: "visible", timeout: 400 }).then(() => true, () => false);
      if (!visible) {
        const dialog = await openDialogText(env.page);
        if (dialog) throw new UnexpectedDialogError(`A dialog is blocking the page: ${dialog.slice(0, 120)}`, node.id, dialog);
        throw new HiddenTargetError(`Target is present but hidden: ${loc.controlId ?? node.id}`, node.id, loc.controlId);
      }
    }
    return { locator: r.locator, tier: r.strategyIndex };
  } catch (err) {
    if (err instanceof HiddenTargetError || err instanceof UnexpectedDialogError) throw err;
    if (err instanceof LocatorNotFoundError) {
      const dialog = await openDialogText(env.page);
      if (dialog) throw new UnexpectedDialogError(`A dialog is blocking the page: ${dialog.slice(0, 120)}`, node.id, dialog);
    }
    throw err;
  }
}

type ReadAttr = "text" | "value" | "href";
interface ReadArgs {
  attrs: ReadAttr[];
  /** Batch mode: one XPath per target (null: not batched). */
  paths?: (string | null)[];
}

/**
 * In-page reader, self-contained because Playwright runs it in the page. Two call shapes:
 * `locator.evaluateAll(readTargets, { attrs: [attr] })` reads the elements a locator matched, and
 * `page.evaluate(readTargets, { attrs, paths })` resolves several XPaths in one call, the way
 * Playwright's XPath engine does (document.evaluate, element nodes only, no shadow roots). Each
 * target yields its match count, and its value only when exactly one element matched. The text of
 * a titled region (section, article, role=region) is its content without headings and form
 * chrome: the same value perception records as a region fact.
 */
function readTargets(a: Element[] | ReadArgs, b?: ReadArgs): { n: number; v?: string }[] {
  const read = (el: Element, attr: ReadAttr): string => {
    if (attr === "href") return el.getAttribute("href") ?? "";
    if (attr === "value") {
      if (el instanceof HTMLSelectElement) return el.value;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return String(el.checked);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      return (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
    }
    if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? el.value;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    if (el.matches("section,article,[role=region]")) {
      const c = el.cloneNode(true) as HTMLElement;
      for (const x of Array.from(c.querySelectorAll("h1,h2,h3,h4,h5,h6,form,label,input,select,textarea,button,script,style"))) x.remove();
      const parts: string[] = [];
      const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const t = (walk.currentNode.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) parts.push(t);
      }
      return parts.join(" ");
    }
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  };
  if (Array.isArray(a)) return [a.length === 1 ? { n: 1, v: read(a[0]!, b!.attrs[0]!) } : { n: a.length }];
  return (a.paths ?? []).map((path, i) => {
    if (!path) return { n: -1 };
    const els: Element[] = [];
    const it = document.evaluate(path, document, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE, null);
    for (let node = it.iterateNext(); node; node = it.iterateNext()) if (node.nodeType === Node.ELEMENT_NODE) els.push(node as Element);
    return els.length === 1 ? { n: 1, v: read(els[0]!, a.attrs[i]!) } : { n: els.length };
  });
}

/** Read a control's value (see readTargets). The locator must match one element (resolveLocator's result). */
export async function readControl(locator: Locator, attr: ReadAttr): Promise<string> {
  const [r] = await locator.evaluateAll(readTargets, { attrs: [attr] });
  if (r?.n !== 1) throw new LocatorNotFoundError(`Expected one element to read, found ${r?.n ?? 0}`, undefined);
  return r.v ?? "";
}

/**
 * Reads several controls in one page call where possible: each target whose top-ranked strategy
 * is an XPath (label-anchored facts) and has no scope. A value comes back only for a target whose
 * XPath matched exactly one element, the element resolveLocator would pick on its first probe;
 * every other target is undefined, and the caller resolves it the full way.
 */
export async function readBatch(page: Page, targets: { loc: SemanticLocator; attr: ReadAttr }[]): Promise<(string | undefined)[]> {
  const paths = targets.map(({ loc }) => {
    const s = loc.strategies[0];
    return !loc.scope && s?.kind === "css" && s.selector.startsWith("xpath=") ? s.selector.slice("xpath=".length) : null;
  });
  if (!paths.some((p) => p !== null)) return targets.map(() => undefined);
  const results = await page.evaluate(readTargets, { attrs: targets.map((t) => t.attr), paths }).catch(() => null);
  return targets.map((_, i) => (results?.[i]?.n === 1 ? (results[i]!.v ?? "") : undefined));
}

function parseValue(raw: string, parse: ExtractField["parse"]): unknown {
  switch (parse) {
    case "number": {
      const n = Number(raw.replace(/[$,%\s]/g, ""));
      return Number.isNaN(n) ? null : n;
    }
    case "boolean":
      return /^(true|yes|on|1|checked)$/i.test(raw.trim());
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    default:
      return raw.trim();
  }
}

export async function checkCondition(env: ActionEnv, c: Condition): Promise<{ ok: boolean; detail?: { expected: unknown; actual: unknown } }> {
  const scope = exprScope(env.scope);
  switch (c.kind) {
    case "expr":
      return { ok: evaluateBool(c.expr, scope) };
    case "visible":
    case "hidden": {
      let visible = false;
      try {
        const r = await resolveLocator(env.page, c.target, { timeoutMs: c.kind === "visible" ? 1500 : 0 });
        visible = await r.locator.isVisible();
      } catch {
        visible = false;
      }
      return { ok: c.kind === "visible" ? visible : !visible };
    }
    case "url":
      return { ok: globToRegExp(c.pattern).test(new URL(env.page.url()).pathname) || globToRegExp(c.pattern).test(env.page.url()) };
    case "textPresent": {
      const text = toStr(resolveValue(c.text, scope));
      return { ok: (await env.page.getByText(text, { exact: false }).count()) > 0 };
    }
    case "fieldEquals": {
      const r = await resolveLocator(env.page, c.target, { timeoutMs: 1500 });
      const actual = await readControl(r.locator, c.attr);
      const expected = resolveValue(c.expected, scope);
      return { ok: looseEquals(actual.trim(), typeof expected === "string" ? expected.trim() : expected), detail: { expected, actual } };
    }
  }
}

async function navigate(env: ActionEnv, node: ActionNode): Promise<ActionOutcome> {
  const start = performance.now();
  if (!node.url) throw new RuntimeError(`navigate ${node.id} has no url`, node.id);
  const url = absUrl(env.origin, toStr(resolveValue(node.url, exprScope(env.scope))));
  const origin = new URL(url).origin;
  if (!env.allowedOrigins.has(origin)) throw new OriginBlockedError(`Navigation to ${origin} is outside the allowlist`, url);
  let resp: Response | null;
  try {
    resp = await env.page.goto(url, { waitUntil: "domcontentloaded", timeout: node.timeoutMs });
  } catch (err) {
    throw new NavigationError(`Navigation failed: ${(err as Error).message.split("\n")[0]}`, node.id, null, url);
  }
  const status = resp?.status() ?? 0;
  if (status >= 400) throw new NavigationError(`Navigation to ${url} returned ${status}`, node.id, status, url);
  return { ms: performance.now() - start, locatorTier: null, output: { url: env.page.url(), status } };
}

/** Wait for the state-changing request a submit triggers, or fail fast if a dialog intercepts it. */
type WriteSignal = { kind: "response"; status: number } | { kind: "error"; message: string } | { kind: "dialog"; text: string } | { kind: "failed"; reason: string };

async function waitForWrite(env: ActionEnv, node: ActionNode, act: () => Promise<void>): Promise<number> {
  const origin = env.origin.replace(/\/$/, "");
  let settled = false;
  let stopListening = () => undefined as void;
  // Page listeners and one timer, removed as soon as the write settles. (Playwright waiters
  // lingered until their timeout after every write, and each timeout built an error with a stack
  // trace on the engine's main thread.) A request that fails at the network layer, including one
  // our own mutation guard blocks, never yields a response.
  const signalP = new Promise<WriteSignal>((resolve) => {
    const onResponse = (r: Response) => {
      if (r.request().method() !== "GET" && r.url().startsWith(origin)) resolve({ kind: "response", status: r.status() });
    };
    const onFailed = (r: Request) => {
      if (r.method() !== "GET" && r.url().startsWith(origin)) resolve({ kind: "failed", reason: r.failure()?.errorText ?? "request failed" });
    };
    const timer = setTimeout(() => resolve({ kind: "error", message: `Timeout ${node.timeoutMs}ms exceeded while waiting for the write response` }), node.timeoutMs);
    env.page.on("response", onResponse);
    env.page.on("requestfailed", onFailed);
    stopListening = () => {
      clearTimeout(timer);
      env.page.off("response", onResponse);
      env.page.off("requestfailed", onFailed);
    };
  });
  let first: WriteSignal;
  try {
    await act();
    const dialogP: Promise<WriteSignal> = (async () => {
      while (!settled) {
        await new Promise((r) => setTimeout(r, 120));
        if (settled) break;
        const text = await openDialogText(env.page);
        if (text) return { kind: "dialog", text } as WriteSignal;
      }
      return signalP;
    })();
    first = await Promise.race([signalP, dialogP]);
  } finally {
    settled = true;
    stopListening();
  }
  if (first.kind === "failed") {
    if (/BLOCKED_BY_CLIENT/i.test(first.reason)) throw new WriteRejectedError("Write blocked by the execution guard; not sent", node.id, 0);
    throw new WriteUncertainError(`Write request failed at the network layer (${first.reason}); commit state unknown`, node.id, null);
  }
  if (first.kind === "dialog") throw new UnexpectedDialogError(`Submit was intercepted by a dialog: ${first.text.slice(0, 120)}`, node.id, first.text);
  if (first.kind === "error") {
    // No response observed: the request may never have left, or the response was lost.
    const text = await openDialogText(env.page);
    if (text) throw new UnexpectedDialogError(`Submit was intercepted by a dialog: ${text.slice(0, 120)}`, node.id, text);
    throw new WriteUncertainError(`No response to the write request (${first.message.split("\n")[0]})`, node.id, null);
  }
  await env.page.waitForLoadState("domcontentloaded", { timeout: node.timeoutMs }).catch(() => undefined);
  const status = first.status;
  if (status === 429) throw new WriteRejectedError("Write throttled (429); not committed", node.id, 429);
  if (status >= 500) throw new WriteUncertainError(`Write returned ${status}; commit state unknown`, node.id, status);
  if (status >= 400) {
    const body = await env.page.locator("body").innerText().catch(() => "");
    throw new WriteRejectedError(`Write rejected with ${status}`, node.id, status, body.slice(0, 300));
  }
  return status;
}

async function extractFields(env: ActionEnv, node: ActionNode, fields: ExtractField[]): Promise<ActionOutcome> {
  const start = performance.now();
  const out: Record<string, unknown> = {};
  let worstTier = 0;
  const locs = fields.map((f) => env.locatorOverrides.get(`${node.id}#${f.name}`) ?? f.target);
  // Fast path: every field with a top-ranked XPath read in one page call (see readBatch).
  const batched = await readBatch(env.page, fields.map((f, i) => ({ loc: locs[i]!, attr: f.attr })));
  for (const [i, f] of fields.entries()) {
    try {
      const loc = locs[i]!;
      if (batched[i] !== undefined) {
        out[f.name] = parseValue(batched[i]!, f.parse);
        continue;
      }
      // Next fastest, one browser call: the top-ranked strategy (not an XPath) matches exactly
      // one element, the one resolveLocator would pick on its first probe. Anything else (no
      // match yet, several, a scoped locator) takes the full path below.
      if (!loc.scope && loc.strategies[0]) {
        const [quick] = (await strategyToLocator(env.page, loc.strategies[0]).evaluateAll(readTargets, { attrs: [f.attr] }).catch(() => null)) ?? [];
        if (quick?.n === 1) {
          out[f.name] = parseValue(quick.v ?? "", f.parse);
          continue;
        }
      }
      const r = await resolveLocator(env.page, loc, { timeoutMs: Math.min(node.timeoutMs, 2500), nodeId: node.id });
      worstTier = Math.max(worstTier, r.strategyIndex);
      out[f.name] = parseValue(await readControl(r.locator, f.attr), f.parse);
    } catch (err) {
      if (f.optional) {
        out[f.name] = null;
        continue;
      }
      if (err instanceof LocatorNotFoundError) throw new LocatorNotFoundError(`${err.message} (field ${f.name})`, `${node.id}#${f.name}`, f.target.controlId);
      throw err;
    }
  }
  return { ms: performance.now() - start, locatorTier: worstTier, output: out };
}

interface TablePage {
  missing: string[];
  rows: Record<string, string>[];
}

interface TableArgs {
  columns: Record<string, string>;
  links: string[];
}

/**
 * In-page table reader, self-contained because Playwright runs it in the page. Two call shapes:
 * `locator.evaluate(readTable, args)` reads the one element a resolved locator points at, and
 * `locator.evaluateAll(readTable, args)` reads the elements a strategy matched, yielding their
 * count and, only when exactly one matched, its rows.
 */
function readTable(a: Element | Element[], args: TableArgs): { n: number; page?: TablePage } {
  const els = Array.isArray(a) ? a : [a];
  if (els.length !== 1) return { n: els.length };
  const el = els[0]!;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const tableEl = el.tagName === "TABLE" ? (el as HTMLTableElement) : (el.querySelector("table") as HTMLTableElement | null);
  if (!tableEl) return { n: 1, page: { missing: Object.values(args.columns), rows: [] } };
  let headerCells = Array.from(tableEl.querySelectorAll("thead th"));
  if (headerCells.length === 0) headerCells = Array.from(tableEl.querySelectorAll("tr:first-child th, tr:first-child td"));
  const headers = headerCells.map((h) => norm((h as HTMLElement).innerText || h.textContent || ""));
  const idx: Record<string, number> = {};
  const missing: string[] = [];
  for (const [name, header] of Object.entries(args.columns)) {
    const i = headers.indexOf(norm(header));
    if (i < 0) missing.push(header);
    else idx[name] = i;
  }
  const bodyRows = tableEl.tBodies.length ? Array.from(tableEl.tBodies).flatMap((b) => Array.from(b.rows)) : Array.from(tableEl.rows).slice(1);
  const rows = bodyRows
    .filter((tr) => tr.querySelectorAll("td").length > 0)
    .map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td,th"));
      const row: Record<string, string> = {};
      for (const [name, i] of Object.entries(idx)) {
        const cell = cells[i] as HTMLElement | undefined;
        row[name] = (cell?.innerText ?? cell?.textContent ?? "").trim();
        if (args.links.includes(name)) row[name + "Href"] = cell?.querySelector("a")?.getAttribute("href") ?? "";
      }
      return row;
    });
  return { n: 1, page: { missing, rows } };
}

/** In-page: a strategy's match count and, for exactly one match, the disabled check extractTable makes on "next". */
function nextState(els: Element[]): { n: number; disabled?: boolean } {
  if (els.length !== 1) return { n: els.length };
  const e = els[0]!;
  return { n: 1, disabled: e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true" || e.classList.contains("disabled") };
}

async function readTablePage(table: Locator, spec: ExtractTable): Promise<TablePage> {
  return (await table.evaluate(readTable, { columns: spec.columns, links: spec.linkColumns })).page!;
}

/**
 * The common single-page case in one round of page calls: the table's top strategy is read in the
 * same call that matches it, while every strategy of the "next" control is matched at the same
 * time (all through Playwright's own selector engines). It returns rows only for what the full
 * path would decide on its first probes without waiting: the table's top strategy matched exactly
 * one element, the table has rows and every column, and "next" resolves (first strategy with
 * exactly one match, every earlier one with none) to a disabled control. Anything else (an empty
 * or still-rendering table, an ambiguous or missing control, a scoped locator, a further page)
 * returns null, and the caller takes the full path unchanged.
 */
async function singlePageTable(page: Page, loc: SemanticLocator, spec: ExtractTable, nextLoc: SemanticLocator | undefined): Promise<TablePage | null> {
  const top = loc.strategies[0];
  if (!top || loc.scope || (nextLoc && (nextLoc.scope || nextLoc.strategies.length === 0))) return null;
  const args: TableArgs = { columns: spec.columns, links: spec.linkColumns };
  const [table, ...next] = await Promise.all([
    strategyToLocator(page, top).evaluateAll(readTable, args).catch(() => null),
    ...(nextLoc?.strategies ?? []).map((s) => strategyToLocator(page, s).evaluateAll(nextState).catch(() => null)),
  ]);
  if (table?.n !== 1 || !table.page || table.page.rows.length === 0 || table.page.missing.length) return null;
  if (nextLoc) {
    const first = next.findIndex((r) => r === null || r.n !== 0);
    if (first < 0 || next[first]?.n !== 1 || next[first]?.disabled !== true) return null;
  }
  return table.page;
}

async function extractTable(env: ActionEnv, node: ActionNode, spec: ExtractTable): Promise<ActionOutcome> {
  const start = performance.now();
  const loc = env.locatorOverrides.get(node.id) ?? spec.target;
  const all: Record<string, string>[] = [];
  const seen = new Set<string>();
  const keep = (rows: Record<string, string>[]) => {
    for (const row of rows) {
      const k = spec.key ? row[spec.key] : undefined;
      if (k !== undefined) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      all.push(row);
    }
  };
  const nextLoc = spec.pagination && spec.pagination.maxPages > 1 ? (env.locatorOverrides.get(`${node.id}#next`) ?? spec.pagination.next) : undefined;
  const quick = await singlePageTable(env.page, loc, spec, nextLoc);
  if (quick) {
    keep(quick.rows);
    return { ms: performance.now() - start, locatorTier: 0, output: { rows: all, pages: 1 } };
  }
  const resolved = await resolveLocator(env.page, loc, { timeoutMs: Math.min(node.timeoutMs, 3000), nodeId: node.id });
  let pages = 0;
  let tier = resolved.strategyIndex;
  let table = resolved.locator;
  for (;;) {
    let page = await readTablePage(table, spec);
    if (page.rows.length === 0) {
      // A client-rendered table may still be filling. Wait while the page is busy (requests in
      // flight or the DOM changing), at most 1.5 s; an empty table on a settled page is final.
      // Server-rendered pages settle in about the quiet period, so "no rows" costs ~60 ms, not 1.5 s.
      await settle(env.page, { maxMs: 1500, quietMs: 60 });
      page = await readTablePage(table, spec);
    }
    if (page.missing.length) throw new LocatorNotFoundError(`Table columns not found: ${page.missing.join(", ")}`, node.id, spec.target.controlId);
    keep(page.rows);
    pages++;
    if (!spec.pagination || pages >= spec.pagination.maxPages) break;
    let next: Locator;
    try {
      const nextLoc = env.locatorOverrides.get(`${node.id}#next`) ?? spec.pagination.next;
      next = (await resolveLocator(env.page, nextLoc, { timeoutMs: 300 })).locator;
    } catch {
      break; // no next control: last page
    }
    const disabled = await next.evaluate((e) => e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true" || e.classList.contains("disabled"));
    if (disabled) break;
    const before = env.page.url();
    await next.click({ timeout: node.timeoutMs });
    await env.page.waitForLoadState("domcontentloaded", { timeout: node.timeoutMs });
    if (env.page.url() === before) await env.page.waitForTimeout(50);
    const again = await resolveLocator(env.page, loc, { timeoutMs: 3000, nodeId: node.id });
    table = again.locator;
    tier = Math.max(tier, again.strategyIndex);
  }
  return { ms: performance.now() - start, locatorTier: tier, output: { rows: all, pages } };
}

export async function executeAction(env: ActionEnv, node: ActionNode): Promise<ActionOutcome> {
  const start = performance.now();
  const scope = exprScope(env.scope);
  switch (node.type) {
    case "navigate":
      return navigate(env, node);
    case "locate": {
      const t = await target(env, node);
      return { ms: performance.now() - start, locatorTier: t.tier };
    }
    case "click": {
      const t = await target(env, node);
      if (node.effect === "remote-write" || node.effect === "irreversible") {
        const status = await waitForWrite(env, node, () => t.locator.click({ timeout: node.timeoutMs }));
        return { ms: performance.now() - start, locatorTier: t.tier, writeStatus: status };
      }
      await t.locator.click({ timeout: node.timeoutMs });
      await env.page.waitForLoadState("domcontentloaded", { timeout: node.timeoutMs }).catch(() => undefined);
      return { ms: performance.now() - start, locatorTier: t.tier };
    }
    case "fill": {
      const t = await target(env, node);
      const v = node.input ? resolveValue(node.input, scope) : "";
      // Text first: Playwright refuses to fill a checkbox or radio at once, changing nothing, and
      // only then is it asked what the element is, so most fills need no extra page call.
      try {
        await t.locator.fill(toStr(v), { timeout: node.timeoutMs });
      } catch (err) {
        const isCheck = await t.locator.evaluate((el) => el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")).catch(() => false);
        if (!isCheck) throw err;
        await t.locator.setChecked(v === true || /^(true|yes|on|1|checked)$/i.test(toStr(v)), { timeout: node.timeoutMs });
      }
      return { ms: performance.now() - start, locatorTier: t.tier };
    }
    case "select": {
      const t = await target(env, node);
      const v = toStr(node.input ? resolveValue(node.input, scope) : "");
      try {
        await t.locator.selectOption(v, { timeout: 1500 });
      } catch {
        // Fall back to a case-insensitive label/value match against the observed options.
        const match = await t.locator.evaluate((el, want) => {
          if (!(el instanceof HTMLSelectElement)) return null;
          const w = want.trim().toLowerCase();
          const o = Array.from(el.options).find((opt) => opt.value.toLowerCase() === w || (opt.textContent ?? "").trim().toLowerCase() === w);
          return o ? o.value : null;
        }, v);
        if (match === null) throw new AssertionFailedError(`Option "${v}" not available`, node.id);
        await t.locator.selectOption(match, { timeout: node.timeoutMs });
      }
      return { ms: performance.now() - start, locatorTier: t.tier };
    }
    case "extract":
      if (node.table) return extractTable(env, node, node.table);
      return extractFields(env, node, node.fields ?? []);
    case "compute":
    case "checkpoint": {
      const out: Record<string, unknown> = {};
      for (const [name, expr] of Object.entries(node.assign ?? {})) {
        out[name] = evaluate(expr, { ...scope, out: { ...env.scope.out, [node.id]: out } });
      }
      return { ms: performance.now() - start, locatorTier: null, output: out };
    }
    case "branch":
      return { ms: performance.now() - start, locatorTier: null, output: { taken: node.condition ? evaluateBool(node.condition, scope) : false } };
    case "assert": {
      if (node.condition && !evaluateBool(node.condition, scope)) throw new AssertionFailedError(`Assertion failed: ${node.description ?? node.condition}`, node.id);
      return { ms: performance.now() - start, locatorTier: null };
    }
    case "waitFor": {
      if (!node.until) return { ms: 0, locatorTier: null };
      const deadline = start + node.timeoutMs;
      while (!(await checkCondition(env, node.until)).ok) {
        if (performance.now() > deadline) throw new AssertionFailedError(`waitFor timed out: ${node.description ?? node.id}`, node.id);
        await env.page.waitForTimeout(100);
      }
      return { ms: performance.now() - start, locatorTier: null };
    }
    case "foreach":
      throw new RuntimeError("foreach nodes are expanded by the scheduler, not executed", node.id);
  }
}

export async function checkPreconditions(env: ActionEnv, node: ActionNode): Promise<void> {
  const stale: { name: string; expected: unknown; actual: unknown }[] = [];
  for (const c of node.preconditions) {
    const r = await checkCondition(env, c);
    if (!r.ok) {
      if (c.kind === "fieldEquals") stale.push({ name: c.target.controlId ?? "field", expected: r.detail?.expected, actual: r.detail?.actual });
      else throw new PreconditionFailedError(`Precondition failed (${c.kind}) for ${node.id}`, node.id);
    }
  }
  if (stale.length) throw new PreconditionFailedError(`Stale data before ${node.id}: ${stale.map((s) => `${s.name} expected ${JSON.stringify(s.expected)} got ${JSON.stringify(s.actual)}`).join("; ")}`, node.id, stale);
}

export async function checkPostconditions(env: ActionEnv, node: ActionNode): Promise<void> {
  for (const c of node.postconditions) {
    const r = await checkCondition(env, c);
    if (!r.ok) throw new AssertionFailedError(`Postcondition failed (${c.kind}) after ${node.id}`, node.id);
  }
}
