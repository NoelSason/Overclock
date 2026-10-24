import type { Locator } from "playwright";
import type { VerificationSpec } from "@overclock/contracts";
import { looseEquals, resolveValue, toStr } from "@overclock/compiler";
import { exprScope, type ActionEnv } from "./actions";
import { NavigationError } from "./errors";
import { resolveLocator } from "./locate";

export interface ReadBackField {
  name: string;
  expected: unknown;
  actual: unknown;
  ok: boolean;
}

export interface ReadBackResult {
  url: string;
  ok: boolean;
  fields: ReadBackField[];
  ms: number;
  status: number;
}

async function readText(l: Locator, attr: "text" | "value"): Promise<string> {
  return l.evaluate((el, a) => {
    if (el instanceof HTMLSelectElement) return a === "value" ? el.value : (el.selectedOptions[0]?.textContent ?? "").trim();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    return ((el as HTMLElement).innerText ?? el.textContent ?? "").trim();
  }, attr);
}

function normalize(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : v;
}

/**
 * Read authoritative state back from the application after a write: navigate fresh to the
 * verification page (no reuse of the form we just submitted) and compare each expected field.
 * Containment counts as a match for long text such as notes lists.
 */
export async function readBack(env: ActionEnv, spec: VerificationSpec, opts: { timeoutMs: number }): Promise<ReadBackResult> {
  const start = performance.now();
  const scope = exprScope(env.scope);
  const url = new URL(toStr(resolveValue(spec.url, scope)), env.origin.endsWith("/") ? env.origin : env.origin + "/").toString();
  const resp = await env.page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs });
  const status = resp?.status() ?? 0;
  if (status >= 400) throw new NavigationError(`Verification page returned ${status}`, undefined, status, url);
  const fields: ReadBackField[] = [];
  for (const f of spec.fields) {
    const expected = normalize(resolveValue(f.equals, scope));
    let actual: unknown = null;
    try {
      const r = await resolveLocator(env.page, f.target, { timeoutMs: 2000 });
      actual = normalize(await readText(r.locator, f.attr));
    } catch {
      actual = null;
    }
    const ok =
      looseEquals(actual, expected) ||
      (typeof actual === "string" && typeof expected === "string" && (actual.toLowerCase() === expected.toLowerCase() || (expected.length >= 12 && actual.includes(expected))));
    fields.push({ name: f.name, expected, actual, ok });
  }
  return { url, ok: fields.every((f) => f.ok), fields, ms: performance.now() - start, status };
}
