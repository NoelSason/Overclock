import type { Locator, Page } from "playwright";
import type { LocatorStrategy, SemanticLocator } from "@overclock/contracts";
import { AmbiguousLocatorError, LocatorNotFoundError } from "./errors";

type Root = Page | Locator;
type AriaRole = Parameters<Page["getByRole"]>[0];

export function strategyToLocator(root: Root, s: LocatorStrategy): Locator {
  switch (s.kind) {
    case "role":
      return root.getByRole(s.role as AriaRole, s.name !== undefined ? { name: s.name, exact: s.exact ?? true } : {});
    case "label":
      return root.getByLabel(s.text, { exact: s.exact ?? true });
    case "placeholder":
      return root.getByPlaceholder(s.text, { exact: true });
    case "testId":
      return root.getByTestId(s.id);
    case "text":
      return root.getByText(s.text, { exact: s.exact ?? false });
    case "css":
      return root.locator(s.selector);
  }
}

export function describeStrategy(s: LocatorStrategy): string {
  switch (s.kind) {
    case "role":
      return `role=${s.role}${s.name !== undefined ? `[name="${s.name}"]` : ""}`;
    case "label":
      return `label="${s.text}"`;
    case "placeholder":
      return `placeholder="${s.text}"`;
    case "testId":
      return `testid=${s.id}`;
    case "text":
      return `text="${s.text}"`;
    case "css":
      return `css=${s.selector}`;
  }
}

export interface Resolved {
  locator: Locator;
  strategyIndex: number;
  ms: number;
  /** Number of probes (protocol round trips) needed. */
  probes: number;
}

async function probe(root: Root, s: LocatorStrategy): Promise<{ locator: Locator; count: number } | null> {
  let l = strategyToLocator(root, s);
  let n = await l.count();
  if (n > 1) {
    const visible = l.filter({ visible: true });
    const vn = await visible.count();
    if (vn >= 1) {
      l = visible;
      n = vn;
    }
  }
  return n === 0 ? null : { locator: l, count: n };
}

/**
 * Resolve a ranked semantic locator to exactly one element.
 *
 * Fast path: probe every strategy once without waiting (one round trip each). Only if none match
 * do we poll, which covers pages still rendering. Multiple matches never resolve silently: an
 * ambiguous strategy is skipped in favour of a lower-ranked unique one, and if every strategy is
 * ambiguous the call fails, so high-impact actions are never taken on a guess.
 */
export async function resolveLocator(page: Page, loc: SemanticLocator, opts: { timeoutMs: number; nodeId?: string; allowFirst?: boolean }): Promise<Resolved> {
  const start = performance.now();
  let probes = 0;
  let root: Root = page;
  if (loc.scope) {
    const scoped = strategyToLocator(page, loc.scope);
    root = (await scoped.count()) > 0 ? scoped.first() : page;
    probes++;
  }
  const deadline = start + opts.timeoutMs;
  let ambiguous = 0;
  for (let round = 0; ; round++) {
    ambiguous = 0;
    for (let i = 0; i < loc.strategies.length; i++) {
      const s = loc.strategies[i]!;
      probes++;
      const r = await probe(root, s);
      if (!r) continue;
      if (r.count === 1 || opts.allowFirst) return { locator: r.locator.first(), strategyIndex: i, ms: performance.now() - start, probes };
      ambiguous = Math.max(ambiguous, r.count);
    }
    if (performance.now() >= deadline) break;
    await page.waitForTimeout(round < 5 ? 50 : 150);
  }
  const desc = loc.strategies.map(describeStrategy).join(" | ");
  if (ambiguous > 1) throw new AmbiguousLocatorError(`Ambiguous target (${ambiguous} matches): ${desc}`, opts.nodeId, ambiguous);
  throw new LocatorNotFoundError(`Target not found: ${desc}`, opts.nodeId, loc.controlId);
}
