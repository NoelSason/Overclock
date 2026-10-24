import type { Locator, Page, Response } from "playwright";
import type { ActionNode, Condition, ExtractField, ExtractTable, SemanticLocator } from "@overclock/contracts";
import { evaluate, evaluateBool, looseEquals, resolveValue, toStr, type Scope } from "@overclock/compiler";
import { AssertionFailedError, HiddenTargetError, LocatorNotFoundError, NavigationError, OriginBlockedError, PreconditionFailedError, RuntimeError, UnexpectedDialogError, WriteRejectedError, WriteUncertainError } from "./errors";
import { resolveLocator } from "./locate";

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

async function readControl(locator: Locator, attr: "text" | "value" | "href"): Promise<string> {
  if (attr === "href") return (await locator.getAttribute("href")) ?? "";
  if (attr === "value") {
    return locator.evaluate((el) => {
      if (el instanceof HTMLSelectElement) return el.value;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return String(el.checked);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      return (el as HTMLElement).innerText?.trim() ?? el.textContent?.trim() ?? "";
    });
  }
  return locator.evaluate((el) => {
    if (el instanceof HTMLSelectElement) return el.selectedOptions[0]?.textContent?.trim() ?? el.value;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  });
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
  const respP: Promise<WriteSignal> = env.page
    .waitForResponse((r) => r.request().method() !== "GET" && r.url().startsWith(origin), { timeout: node.timeoutMs })
    .then((r): WriteSignal => ({ kind: "response", status: r.status() }))
    .catch((e: Error): WriteSignal => ({ kind: "error", message: e.message }));
  // A request that fails at the network layer (including our own mutation guard) never yields a response.
  const failedP: Promise<WriteSignal> = env.page
    .waitForEvent("requestfailed", { predicate: (r) => r.method() !== "GET" && r.url().startsWith(origin), timeout: node.timeoutMs })
    .then((r): WriteSignal => ({ kind: "failed", reason: r.failure()?.errorText ?? "request failed" }))
    .catch(() => new Promise<WriteSignal>(() => undefined));
  await act();
  const dialogP: Promise<WriteSignal> = (async () => {
    while (!settled) {
      await new Promise((r) => setTimeout(r, 120));
      if (settled) break;
      const text = await openDialogText(env.page);
      if (text) return { kind: "dialog", text } as WriteSignal;
    }
    return respP;
  })();
  const first = await Promise.race([respP, dialogP, failedP]);
  settled = true;
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
  for (const f of fields) {
    try {
      const override = env.locatorOverrides.get(`${node.id}#${f.name}`);
      const r = await resolveLocator(env.page, override ?? f.target, { timeoutMs: Math.min(node.timeoutMs, 2500), nodeId: node.id });
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

async function readTablePage(table: Locator, spec: ExtractTable): Promise<TablePage> {
  return table.evaluate(
    (el, args) => {
      const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
      const tableEl = el.tagName === "TABLE" ? (el as HTMLTableElement) : (el.querySelector("table") as HTMLTableElement | null);
      if (!tableEl) return { missing: Object.values(args.columns), rows: [] };
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
      return { missing, rows };
    },
    { columns: spec.columns, links: spec.linkColumns },
  );
}

async function extractTable(env: ActionEnv, node: ActionNode, spec: ExtractTable): Promise<ActionOutcome> {
  const start = performance.now();
  const loc = env.locatorOverrides.get(node.id) ?? spec.target;
  const resolved = await resolveLocator(env.page, loc, { timeoutMs: Math.min(node.timeoutMs, 3000), nodeId: node.id });
  const all: Record<string, string>[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let tier = resolved.strategyIndex;
  let table = resolved.locator;
  for (;;) {
    const page = await readTablePage(table, spec);
    if (page.missing.length) throw new LocatorNotFoundError(`Table columns not found: ${page.missing.join(", ")}`, node.id, spec.target.controlId);
    for (const row of page.rows) {
      const k = spec.key ? row[spec.key] : undefined;
      if (k !== undefined) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      all.push(row);
    }
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
      const isCheck = await t.locator.evaluate((el) => el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"));
      if (isCheck) await t.locator.setChecked(v === true || /^(true|yes|on|1|checked)$/i.test(toStr(v)), { timeout: node.timeoutMs });
      else await t.locator.fill(toStr(v), { timeout: node.timeoutMs });
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
