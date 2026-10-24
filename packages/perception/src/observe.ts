import { createHash, randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { AppControl, Effect, LocatorStrategy, ObservedControl, PageObservation, SemanticLocator } from "@overclock/contracts";
import { extractDom, type RawControl, type RawDom } from "./dom";

const ID_SEGMENT = /^(?=.*\d)[A-Za-z0-9_-]{2,}$|^[0-9a-f-]{16,}$/i;

/** `/orders/ORD-50012/edit?x=1` -> `/orders/:id/edit` */
export function routePattern(url: string): string {
  const u = new URL(url);
  return (
    u.pathname
      .split("/")
      .map((seg) => (seg && ID_SEGMENT.test(decodeURIComponent(seg)) ? ":id" : seg))
      .join("/") || "/"
  );
}

const h = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/**
 * Structural fingerprint: role/name structure, form schema, table headers, dialogs, headings
 * shape, and route — never data values, so a changed timestamp or record does not invalidate
 * anything, but a renamed button or reordered form does (and only for its region).
 */
export function fingerprint(raw: RawDom, route: string): { page: string; regions: Record<string, string> } {
  const regions: Record<string, string> = {};
  raw.forms.forEach((f, i) => {
    const fields = f.fieldIdx.map((k) => {
      const c = raw.controls[k]!;
      return `${c.role}:${c.label ?? c.name}:${c.type ?? ""}:${(c.options ?? []).map((o) => o.value).join(",")}:${c.tabPanel ?? ""}`;
    });
    const submits = f.submitIdx.map((k) => raw.controls[k]!.name);
    regions[`form${i}`] = h(`${f.method}|${fields.join(";")}|${submits.join(";")}`);
  });
  raw.tables.forEach((t, i) => (regions[`table${i}`] = h(t.headers.join("|"))));
  regions.dialogs = h(raw.dialogs.filter((d) => d.open).map((d) => d.title).join("|"));
  regions.nav = h(raw.controls.filter((c) => c.region?.startsWith("nav")).map((c) => `${c.role}:${c.name}`).join("|"));
  regions.facts = h(raw.facts.map((f) => f.label).join("|"));
  const buttons = raw.controls.filter((c) => c.role === "button" && !c.formIdx).map((c) => c.name);
  regions.actions = h(buttons.join("|"));
  return { page: h(`${route}|${Object.values(regions).join("|")}`), regions };
}

export interface ObserveOptions {
  maxText?: number;
  maxControls?: number;
  scopeSelector?: string | null;
}

export interface Observation extends PageObservation {
  raw: RawDom;
}

/** Tier-3/4 perception: one page.evaluate round trip producing a compact page description. */
export async function observe(page: Page, opts: ObserveOptions = {}): Promise<Observation> {
  const start = performance.now();
  const raw = await page.evaluate(extractDom, { maxText: opts.maxText ?? 2500, maxControls: opts.maxControls ?? 400, scopeSelector: opts.scopeSelector ?? null });
  const route = routePattern(raw.url);
  const fp = fingerprint(raw, route);
  const controls: ObservedControl[] = raw.controls.map((c) => toObserved(c));
  const bytes = JSON.stringify(raw).length;
  return {
    id: randomUUID().slice(0, 8),
    url: raw.url,
    routePattern: route,
    title: raw.title,
    headings: raw.headings,
    controls,
    forms: raw.forms.map((f) => ({ id: `f${f.idx}`, name: f.name, action: f.action, method: f.method, fieldIds: f.fieldIdx.map((i) => `c${i}`), submitIds: f.submitIdx.map((i) => `c${i}`), cssPath: f.cssPath })),
    tables: raw.tables.map((t) => ({ id: `t${t.idx}`, caption: t.caption, headers: t.headers, rowCount: t.rowCount, sampleRows: t.sampleRows, linkHeaders: t.linkHeaders, sampleLinks: t.sampleLinks, cssPath: t.cssPath })),
    dialogs: raw.dialogs.map((d) => ({ id: `d${d.idx}`, title: d.title, text: d.text, controlIds: d.controlIdx.map((i) => `c${i}`), open: d.open })),
    text: raw.text,
    facts: raw.facts.map((f) => ({ label: f.label, value: f.value, cssPath: f.cssPath })),
    fingerprint: fp,
    metrics: { snapshotMs: Math.round((performance.now() - start) * 10) / 10, bytes },
    raw,
  };
}

function toObserved(c: RawControl): ObservedControl {
  return {
    id: `c${c.idx}`,
    role: c.role,
    name: c.name,
    tag: c.tag,
    type: c.type,
    label: c.label,
    placeholder: c.placeholder,
    testId: c.testId,
    value: c.value,
    options: c.options,
    href: c.href,
    formId: c.formIdx !== undefined && c.formIdx >= 0 ? `f${c.formIdx}` : undefined,
    region: c.region,
    inDialog: c.inDialog,
    tabPanel: c.tabPanel,
    disabled: c.disabled,
    visible: c.visible,
    cssPath: c.cssPath,
  };
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "x"
  );
}

export function pageKey(route: string): string {
  return slug(route.replace(/:id/g, "id")) || "root";
}

const IRREVERSIBLE = /\b(delete|remove|destroy|refund|pay|purchase|buy|send|publish|transfer|close account|deactivate|cancel order)\b/i;

function kindOf(c: RawControl): AppControl["kind"] {
  if (c.role === "tab") return "tab";
  if (c.role === "checkbox" || c.role === "switch") return "checkbox";
  if (c.tag === "select" || c.role === "combobox" || c.role === "listbox") return "select";
  if (c.tag === "textarea") return "textarea";
  if (c.role === "textbox" || c.role === "searchbox" || c.role === "spinbutton") return "input";
  if (c.role === "link" && /^(next|previous|prev|older|newer|›|»|‹|«)( page)?$/i.test(c.name)) return "pagination";
  if (c.role === "link") return "link";
  return "button";
}

function locatorFor(c: RawControl, kind: AppControl["kind"], dup: boolean, formScope: LocatorStrategy | undefined): SemanticLocator {
  const s: LocatorStrategy[] = [];
  const name = c.name;
  if (kind === "input" || kind === "select" || kind === "textarea" || kind === "checkbox") {
    if (c.label) s.push({ kind: "label", text: c.label, exact: true });
    if (name) s.push({ kind: "role", role: c.role, name, exact: true });
    if (c.placeholder) s.push({ kind: "placeholder", text: c.placeholder });
  } else {
    if (name) s.push({ kind: "role", role: c.role, name, exact: true });
    if (name && c.role !== "tab") s.push({ kind: "text", text: name, exact: true });
  }
  if (c.testId) s.splice(1, 0, { kind: "testId", id: c.testId });
  s.push({ kind: "css", selector: c.cssPath });
  return { strategies: s, scope: dup ? formScope : undefined, confidence: name || c.label ? 0.9 : 0.5, evidence: [] };
}

function guessEffect(c: RawControl, raw: RawDom): Effect | undefined {
  const kind = kindOf(c);
  if (kind !== "button") return undefined;
  if (IRREVERSIBLE.test(c.name)) return "irreversible";
  const form = c.formIdx !== undefined && c.formIdx >= 0 ? raw.forms[c.formIdx] : undefined;
  if (form && form.submitIdx.includes(c.idx)) return form.method === "post" ? "remote-write" : "read";
  return undefined;
}

/**
 * Promote an observation's controls, tables, and facts into app-model controls with stable,
 * globally unique ids and ranked, evidence-backed semantic locators.
 */
export function toAppControls(app: string, obs: Observation): AppControl[] {
  const raw = obs.raw;
  const pk = pageKey(obs.routePattern);
  const prefix = `${slug(app)}.${pk}`;
  const used = new Map<string, number>();
  const uniqueId = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  };
  const nameCount = new Map<string, number>();
  for (const c of raw.controls) {
    const k = `${c.role}|${c.label ?? c.name}`;
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  const out: AppControl[] = [];
  const ev = (controlId: string) => [{ observationId: obs.id, url: obs.url, controlId }];
  for (const c of raw.controls) {
    if (!c.visible && !c.tabPanel && c.role !== "checkbox") continue;
    if (c.inDialog && !raw.dialogs.some((d) => d.open && d.controlIdx.includes(c.idx))) continue;
    const kind = kindOf(c);
    // Skip per-record links inside data tables (the table control covers them).
    if (kind === "link" && c.cssPath.includes("td")) continue;
    const label = c.label ?? c.name;
    if (!label && kind !== "input") continue;
    const id = uniqueId(`${prefix}.${slug(label || kind)}${kind === "button" || kind === "link" || kind === "pagination" ? "_" + kind : ""}`);
    const form = c.formIdx !== undefined && c.formIdx >= 0 ? raw.forms[c.formIdx] : undefined;
    const dup = (nameCount.get(`${c.role}|${label}`) ?? 0) > 1;
    const locator = locatorFor(c, kind, dup, form ? { kind: "css", selector: form.cssPath } : undefined);
    locator.controlId = id;
    locator.evidence = ev(`c${c.idx}`);
    locator.regionFingerprint = form ? obs.fingerprint.regions[`form${c.formIdx}`] : obs.fingerprint.regions.actions;
    out.push({
      id,
      app,
      page: obs.routePattern,
      role: c.role,
      name: c.name,
      label: c.label,
      type: c.type,
      param: c.param,
      options: c.options,
      kind,
      formId: form ? `f${form.idx}` : undefined,
      inDialog: c.inDialog,
      tabPanel: c.tabPanel,
      locator,
      effectGuess: guessEffect(c, raw),
      detail: kind === "link" || kind === "pagination" ? c.href : undefined,
      sample: kind === "input" || kind === "textarea" || kind === "select" || kind === "checkbox" ? c.value?.slice(0, 40) : undefined,
    });
  }
  raw.tables.forEach((t) => {
    // Captions often carry data ("10 customers, showing 1-10"); identity must come from structure.
    const stableCaption = t.caption && !/\d/.test(t.caption) ? t.caption : undefined;
    const ident = stableCaption ?? (t.headers.slice(0, 2).join(" ") || "table");
    const id = uniqueId(`${prefix}.${slug(ident)}_table`);
    const strategies: LocatorStrategy[] = [];
    if (stableCaption) strategies.push({ kind: "role", role: "table", name: stableCaption, exact: true });
    if (raw.tables.length === 1) strategies.push({ kind: "css", selector: "table" });
    strategies.push({ kind: "css", selector: t.cssPath });
    out.push({
      id,
      app,
      page: obs.routePattern,
      role: "table",
      name: stableCaption ?? ident,
      kind: "table",
      locator: { controlId: id, strategies, confidence: 0.9, evidence: ev(`t${t.idx}`), regionFingerprint: obs.fingerprint.regions[`table${t.idx}`] },
      detail: t.headers.join(" | "),
    });
  });
  raw.facts.forEach((f) => {
    const id = uniqueId(`${prefix}.${slug(f.label)}_fact`);
    out.push({
      id,
      app,
      page: obs.routePattern,
      role: "definition",
      name: f.label,
      kind: "fact",
      locator: { controlId: id, strategies: [{ kind: "css", selector: `xpath=${f.xpath}` }, { kind: "css", selector: f.cssPath }], confidence: 0.85, evidence: ev(`fact:${f.label}`), regionFingerprint: obs.fingerprint.regions.facts },
      detail: f.label,
      sample: f.value.slice(0, 60),
    });
  });
  return out;
}
