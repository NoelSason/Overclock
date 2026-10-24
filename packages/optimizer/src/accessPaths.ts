import type { ActionNode, AppControl, AppModel, SemanticLocator } from "@overclock/contracts";
import { parseTemplate, toStr, evaluate, type CompiledSegment } from "@overclock/compiler";

/**
 * Online access-path selection (the query-optimizer idea applied to browser reads).
 *
 * A per-record "detail read" segment — navigate to /entity/{key} and extract facts — costs one
 * page load per record. If the app also has a paginated list table whose rows link to the same
 * detail route and whose columns carry the same facts, a scan of P list pages can serve every
 * remaining record. Detection is structural (from observed app models); the switch decision is
 * made from measured latencies; and substitution is only enabled after the scanned values match
 * detail reads that already executed, so outputs are provably interchangeable.
 */

export interface AccessPathCandidate {
  segmentId: string;
  app: string;
  /** Detail route template, e.g. "/orders/{$rec.orderId}" */
  detailTemplate: string;
  keyExpr: string;
  /** Segment of the path holding the key (index after splitting on "/"). */
  keyPathIndex: number;
  listPath: string;
  table: AppControl;
  next?: AppControl | undefined;
  pages: number | null;
  /** extract node id -> field name -> table header */
  fieldMap: Record<string, Record<string, { header: string; parse: string }>>;
  linkHeader: string;
  navNodeId: string;
  pageParam: string | null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function factLabel(c: AppControl): string {
  const name = c.detail ?? c.name;
  const parts = name.split("›");
  return norm(parts[parts.length - 1]!);
}

/** Find detail-read segments that a list scan could serve. */
export function findAccessPathCandidates(segments: CompiledSegment[], models: AppModel[]): AccessPathCandidate[] {
  const out: AccessPathCandidate[] = [];
  for (const seg of segments) {
    if (seg.kind !== "read" || !seg.app) continue;
    const nav = seg.nodes[0];
    if (!nav || nav.type !== "navigate" || nav.when || !nav.url || !("template" in nav.url)) continue;
    const rest = seg.nodes.slice(1);
    if (!rest.length || rest.some((n) => n.type !== "extract" || !n.fields || n.when)) continue;
    const parts = parseTemplate(nav.url.template.split("?")[0]!);
    const exprs = parts.filter((p) => p.expr !== undefined);
    if (exprs.length !== 1) continue;
    const keyExpr = exprs[0]!.expr!;
    const detailPattern = parts.map((p) => p.lit + (p.expr !== undefined ? ":id" : "")).join("");
    const keyPathIndex = detailPattern.split("/").indexOf(":id");
    if (keyPathIndex < 0) continue;
    const model = models.find((m) => m.app === seg.app);
    if (!model) continue;
    for (const page of model.pages) {
      for (const t of page.tables) {
        const linkHeader = t.linkHeaders.find((h) => t.sampleLinks.some((l) => routeOf(l) === detailPattern));
        if (!linkHeader) continue;
        const table = page.controlIds.map((id) => model.controls[id]!).find((c) => c?.kind === "table" && c.detail === t.headers.join(" | "));
        if (!table) continue;
        const headers = t.headers.map(norm);
        const fieldMap: AccessPathCandidate["fieldMap"] = {};
        let ok = true;
        for (const n of rest) {
          fieldMap[n.id] = {};
          for (const f of n.fields!) {
            const ctrl = f.target.controlId ? model.controls[f.target.controlId] : undefined;
            if (!ctrl || ctrl.kind !== "fact") {
              ok = false;
              break;
            }
            const label = factLabel(ctrl);
            const i = headers.indexOf(label);
            if (i < 0) {
              ok = false;
              break;
            }
            fieldMap[n.id]![f.name] = { header: t.headers[i]!, parse: f.parse };
          }
          if (!ok) break;
        }
        if (!ok) continue;
        const next = page.controlIds.map((id) => model.controls[id]!).find((c) => c?.kind === "pagination" && /next/i.test(c.name));
        const lt = model.features.listTables.find((x) => x.page === page.routePattern && x.controlId === table.id);
        const pageParam = next?.detail && /[?&]page=\d+/.test(next.detail) ? "page" : null;
        out.push({ segmentId: seg.id, app: seg.app, detailTemplate: nav.url.template, keyExpr, keyPathIndex, listPath: page.routePattern, table, next, pages: lt?.pages ?? null, fieldMap, linkHeader, navNodeId: nav.id, pageParam });
        break;
      }
      if (out.at(-1)?.segmentId === seg.id) break;
    }
  }
  return out;
}

function routeOf(href: string): string {
  try {
    const u = new URL(href, "http://x");
    return u.pathname
      .split("/")
      .map((s) => (s && /(?=.*\d)[A-Za-z0-9_-]{2,}/.test(decodeURIComponent(s)) ? ":id" : s))
      .join("/");
  } catch {
    return "";
  }
}

/** IR nodes for scanning one list page (or the whole list via pagination when pages are unknown). */
export function scanNodes(c: AccessPathCandidate, page: number | null, idPrefix: string): ActionNode[] {
  const columns: Record<string, string> = { __link: c.linkHeader };
  for (const fields of Object.values(c.fieldMap)) for (const [, v] of Object.entries(fields)) columns[`h:${v.header}`] = v.header;
  const url = page !== null && c.pageParam ? `${c.listPath}?${c.pageParam}=${page}` : c.listPath;
  const base = { dependsOn: [] as string[], preconditions: [], postconditions: [], reads: [`page:${c.app}:${c.listPath}`], writes: [], effect: "read" as const, retryPolicy: "safe" as const, app: c.app, sessionKey: c.app };
  return [
    { ...base, id: `${idPrefix}_nav`, type: "navigate", url: { value: url }, timeoutMs: 15_000, description: `access path: open ${url}` },
    {
      ...base,
      id: `${idPrefix}_rows`,
      type: "extract",
      dependsOn: [`${idPrefix}_nav`],
      timeoutMs: 60_000,
      table: { target: c.table.locator as SemanticLocator, columns, linkColumns: ["__link"], pagination: page === null && c.next ? { next: c.next.locator as SemanticLocator, maxPages: 200 } : undefined },
      description: "access path: scan list rows",
    },
  ];
}

/** Key of a scanned row: the detail-URL path segment its link points to. */
export function rowKey(c: AccessPathCandidate, row: Record<string, string>): string | null {
  const href = row.__linkHref;
  if (!href) return null;
  try {
    const seg = new URL(href, "http://x").pathname.split("/")[c.keyPathIndex];
    return seg ? decodeURIComponent(seg) : null;
  } catch {
    return null;
  }
}

function parseLike(raw: string, parse: string): unknown {
  if (parse === "number") {
    const n = Number(raw.replace(/[$,%\s]/g, ""));
    return Number.isNaN(n) ? null : n;
  }
  if (parse === "boolean") return /^(true|yes|on|1|checked)$/i.test(raw.trim());
  return raw.trim();
}

/** Outputs the detail-read segment would have produced, built from a scanned row. */
export function outputsFromRow(c: AccessPathCandidate, row: Record<string, string>, detailUrl: string): Record<string, unknown> {
  const out: Record<string, unknown> = { [c.navNodeId]: { url: detailUrl, status: 200, via: "list-scan" } };
  for (const [nodeId, fields] of Object.entries(c.fieldMap)) {
    const o: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(fields)) o[name] = parseLike(row[`h:${v.header}`] ?? "", v.parse);
    out[nodeId] = o;
  }
  return out;
}

export function keyFor(c: AccessPathCandidate, scope: Record<string, unknown>): string {
  return toStr(evaluate(c.keyExpr, scope));
}

/** Compare a scanned row with outputs a real detail read produced. */
export function equivalent(c: AccessPathCandidate, row: Record<string, string>, outputs: Record<string, unknown>): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const [nodeId, fields] of Object.entries(c.fieldMap)) {
    const real = (outputs[nodeId] ?? {}) as Record<string, unknown>;
    for (const [name, v] of Object.entries(fields)) {
      const a = norm(toStr(parseLike(row[`h:${v.header}`] ?? "", v.parse)));
      const b = norm(toStr(real[name]));
      if (a !== b) diffs.push(`${name}: list "${a}" vs detail "${b}"`);
    }
  }
  return { ok: diffs.length === 0, diffs };
}

/** Expected wall time of the remaining detail reads vs a (parallel) scan, from measured latency. */
export function compareCosts(args: { remaining: number; detailMs: number; navMs: number; pages: number; workers: number; parallelPages: boolean }): { detailMs: number; scanMs: number } {
  const w = Math.max(1, args.workers);
  const detailMs = (args.remaining * args.detailMs) / w;
  const perPage = args.navMs + 80;
  const scanMs = args.parallelPages ? Math.ceil(args.pages / w) * perPage : args.pages * perPage;
  return { detailMs, scanMs };
}
