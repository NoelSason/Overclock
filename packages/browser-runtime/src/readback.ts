import type { Locator } from "playwright";
import type { ActionNode, VerificationSpec } from "@overclock/contracts";
import { looseEquals, resolveValue, toStr } from "@overclock/compiler";
import { routePattern } from "@overclock/perception";
import { exprScope, readControl, type ActionEnv, type RecordScope } from "./actions";
import { NavigationError } from "./errors";
import { resolveLocator } from "./locate";

export interface ReadBackField {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
  /** Entry-matched fields: how many entries equal the expected value. */
  matches?: number | undefined;
}

export interface ReadBackResult {
  url: string;
  ok: boolean;
  fields: ReadBackField[];
  ms: number;
  status: number;
  /** An entry-matched field found the expected entry more than once. Never fixed by retrying. */
  duplicate: boolean;
  /** The verification page shows a different entity than the page the write targeted. */
  entityMismatch: string | null;
}

const readText = (l: Locator, attr: "text" | "value"): Promise<string> => readControl(l, attr);

function normalize(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
}

/**
 * Absolute URL of the page a write targets: the last navigation before it in its segment, resolved
 * in the record's scope. Both the post-write read-back and reconciliation use it for the entity check.
 */
export function writeTargetUrl(nodes: ActionNode[], writeNodeId: string, scope: RecordScope, origin: string): string | undefined {
  const idx = nodes.findIndex((n) => n.id === writeNodeId);
  const nav = nodes.slice(0, idx < 0 ? 0 : idx).reverse().find((n) => n.type === "navigate" && n.url);
  if (!nav?.url) return undefined;
  try {
    return new URL(toStr(resolveValue(nav.url, exprScope(scope))), origin.endsWith("/") ? origin : origin + "/").toString();
  } catch {
    return undefined;
  }
}

/** Values of a URL's id-like path segments (the ones route patterns turn into ":id"). */
export function entityIds(url: string): string[] {
  const u = new URL(url);
  const pattern = routePattern(u.toString()).split("/");
  return u.pathname
    .split("/")
    .filter((_, i) => pattern[i] === ":id")
    .map((s) => decodeURIComponent(s));
}

/**
 * Count the entries of a collection region whose text equals `expected` exactly (whitespace
 * normalized). Entries are the region's innermost list items outside forms; a region without a
 * list is one entry (its text without headings and form chrome). An entry matches when its own
 * text, or the text of one of its elements, equals the expected value, so an entry's timestamp
 * doesn't block a match and a longer unrelated entry that merely contains the text doesn't match.
 */
export async function countMatchingEntries(region: Locator, expected: string): Promise<{ matches: number; entries: number }> {
  return region.evaluate((el, exp) => {
    const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const CHROME = "h1,h2,h3,h4,h5,h6,form,label,input,select,textarea,button,script,style";
    const items = Array.from(el.querySelectorAll("li,[role=listitem]")).filter((i) => !i.closest("form") && !i.querySelector("li,[role=listitem]"));
    if (!items.length) {
      const c = el.cloneNode(true) as HTMLElement;
      for (const x of Array.from(c.querySelectorAll(CHROME))) x.remove();
      const parts: string[] = [];
      const walk = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const t = norm(walk.currentNode.textContent);
        if (t) parts.push(t);
      }
      const text = parts.join(" ");
      return { matches: text === exp ? 1 : 0, entries: text ? 1 : 0 };
    }
    const own = (e: Element) => norm(e.textContent) === exp || Array.from(e.querySelectorAll("*")).some((d) => !d.matches(CHROME) && !d.closest(CHROME) && norm(d.textContent) === exp);
    return { matches: items.filter(own).length, entries: items.length };
  }, expected);
}

/**
 * Read authoritative state back from the application after a write: navigate fresh to the
 * verification page (no reuse of the form we just submitted) and compare each expected field.
 * Fields on collection regions pass only with exactly one matching entry. With `entityUrl` (the
 * page the write targeted), the verification page must show the same entity ids.
 */
export async function readBack(env: ActionEnv, spec: VerificationSpec, opts: { timeoutMs: number; entityUrl?: string | undefined }): Promise<ReadBackResult> {
  const start = performance.now();
  const scope = exprScope(env.scope);
  const url = new URL(toStr(resolveValue(spec.url, scope)), env.origin.endsWith("/") ? env.origin : env.origin + "/").toString();
  let entityMismatch: string | null = null;
  if (opts.entityUrl) {
    const target = entityIds(opts.entityUrl);
    const shown = new Set(entityIds(url));
    const missing = target.filter((id) => !shown.has(id));
    if (missing.length) entityMismatch = `the write targeted ${missing.join(", ")} but verification reads ${new URL(url).pathname}`;
  }
  const resp = await env.page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
  const status = resp?.status() ?? 0;
  if (status >= 400) throw new NavigationError(`Verification page returned ${status}`, undefined, status, url);
  const fields: ReadBackField[] = [];
  if (entityMismatch) fields.push({ name: "entity", expected: entityIds(opts.entityUrl!).join(", "), actual: new URL(url).pathname, ok: false });
  let duplicate = false;
  for (const f of spec.fields) {
    const expected = normalize(resolveValue(f.equals, scope));
    if (f.match === "entry") {
      let counted: { matches: number; entries: number } | null = null;
      try {
        const r = await resolveLocator(env.page, f.target, { timeoutMs: 2000 });
        counted = await countMatchingEntries(r.locator, toStr(expected));
      } catch {
        counted = null;
      }
      const matches = counted?.matches ?? 0;
      if (matches > 1) duplicate = true;
      const actual = counted === null ? null : matches === 1 ? expected : matches === 0 ? `no matching entry (${counted.entries} entries)` : `${matches} matching entries (duplicate)`;
      fields.push({ name: f.name, expected, actual, ok: matches === 1, matches });
      continue;
    }
    let actual: unknown = null;
    try {
      const r = await resolveLocator(env.page, f.target, { timeoutMs: 2000 });
      actual = normalize(await readText(r.locator, f.attr));
    } catch {
      actual = null;
    }
    const ok = looseEquals(actual, expected) || (typeof actual === "string" && typeof expected === "string" && actual.toLowerCase() === expected.toLowerCase());
    fields.push({ name: f.name, expected, actual, ok });
  }
  return { url, ok: fields.every((f) => f.ok), fields, ms: performance.now() - start, status, duplicate, entityMismatch };
}
