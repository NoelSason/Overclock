import type { AppControl, AppModel, AppPage, LocatorStrategy } from "@overclock/contracts";
import { slug } from "@overclock/perception";
import { shortHash } from "./hash";
import { dataContext, findCredentials, findData, isLabelAnchoredXpath, scrubText } from "./sanitize";

/**
 * Portable descriptors: the semantic, data-free description of an app-model control. Export
 * builds PortableControls from these; rebinding builds the same descriptor for every control a
 * fresh runtime observed and compares descriptor to descriptor, so both sides go through one
 * function and cannot drift apart.
 */

export interface ControlDescriptor {
  app: string;
  routeFamily: string;
  kind: AppControl["kind"];
  role: string;
  name: string;
  label?: string | undefined;
  type?: string | undefined;
  param?: string | undefined;
  options?: { value: string; label: string }[] | undefined;
  headers?: string[] | undefined;
  formSignature?: string | undefined;
  inDialog?: boolean | undefined;
  tabPanel?: string | undefined;
  effect?: AppControl["effectGuess"];
  strategies: LocatorStrategy[];
  regionFingerprint?: string | undefined;
  /** Scrubbed text the portable key is derived from. */
  semanticName: string;
  /** Number of data-like fragments dropped while building the descriptor. */
  redactions: number;
}

const EMPTY_CTX = dataContext(undefined);

export function isDataLike(s: string): boolean {
  return findData(s, EMPTY_CTX).length > 0 || findCredentials(s).length > 0;
}

/** Lowercase, collapse whitespace and punctuation; data fragments become placeholders. */
export function normLabel(s: string | undefined): string {
  return scrubText(s ?? "")
    .text.toLowerCase()
    .replace(/[^\p{L}\p{N}{}]+/gu, " ")
    .trim();
}

export function pageOf(model: AppModel, routeFamily: string): AppPage | undefined {
  return model.pages.find((p) => p.routePattern === routeFamily);
}

const FIELD_KINDS = new Set<AppControl["kind"]>(["input", "select", "textarea", "checkbox"]);

/** Order-insensitive hash of a form's field schema: kind, label, type, option values, plus method. Submit names are excluded. */
export function formSignatureOf(model: AppModel, page: AppPage | undefined, formId: string | undefined): string | undefined {
  if (!page || !formId) return undefined;
  const form = page.forms.find((f) => f.id === formId);
  if (!form) return undefined;
  const fields = form.fieldIds
    .map((id) => model.controls[id])
    .filter((c): c is AppControl => !!c && FIELD_KINDS.has(c.kind))
    .map((c) => `${c.kind}|${normLabel(c.label ?? c.name)}|${c.type ?? ""}|${(c.options ?? []).map((o) => o.value).sort().join(",")}`)
    .sort();
  return shortHash(`${form.method}|${fields.join(";")}`, 16);
}

function tableHeaders(c: AppControl): string[] {
  return (c.detail ?? "")
    .split("|")
    .map((h) => h.trim())
    .filter(Boolean);
}

/** Region key of a control: forms by field schema, tables by header set, then facts / actions. */
export function regionKeyOf(c: AppControl, model: AppModel, page: AppPage | undefined): string {
  if (c.kind === "table") return `table:${shortHash(tableHeaders(c).map((h) => normLabel(h)).sort().join("|"), 16)}`;
  if (c.kind === "fact") return "facts";
  const sig = formSignatureOf(model, page, c.formId);
  if (sig) return `form:${sig}`;
  return "actions";
}

/** Region fingerprints of one page keyed by portable region keys (structure hashes only). */
export function regionMap(model: AppModel, page: AppPage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of page.controlIds) {
    const c = model.controls[id];
    const fp = c?.locator.regionFingerprint;
    if (!c || !fp) continue;
    let key = regionKeyOf(c, model, page);
    if (out[key] !== undefined && out[key] !== fp) {
      let n = 2;
      while (out[`${key}#${n}`] !== undefined && out[`${key}#${n}`] !== fp) n++;
      key = `${key}#${n}`;
    }
    out[key] = fp;
  }
  return out;
}

function enumerationOptions(c: AppControl): { value: string; label: string }[] | undefined {
  if (c.kind !== "select" || !c.options?.length) return undefined;
  if (c.options.length > 100) return undefined;
  const bad = c.options.some((o) => isDataLike(o.value) || isDataLike(o.label) || o.value.length > 60 || o.label.length > 80);
  return bad ? undefined : c.options.map((o) => ({ value: o.value, label: o.label }));
}

/** Semantic strategies only: role/label/placeholder/text/testId and label-anchored xpath. */
export function semanticStrategies(c: AppControl): { strategies: LocatorStrategy[]; dropped: number } {
  const out: LocatorStrategy[] = [];
  let dropped = 0;
  for (const s of c.locator.strategies) {
    switch (s.kind) {
      case "role":
        if (s.name !== undefined && isDataLike(s.name)) {
          out.push({ kind: "role", role: s.role });
          dropped++;
        } else out.push(s);
        break;
      case "label":
      case "placeholder":
      case "text":
        if (isDataLike(s.text)) dropped++;
        else out.push(s);
        break;
      case "testId":
        if (isDataLike(s.id)) dropped++;
        else out.push(s);
        break;
      case "css":
        if (isLabelAnchoredXpath(s) && !isDataLike(s.selector.replace(/^xpath=/, ""))) out.push(s);
        else dropped++;
        break;
    }
  }
  const seen = new Set<string>();
  const unique = out.filter((s) => {
    const k = JSON.stringify(s);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) unique.push({ kind: "role", role: c.role });
  return { strategies: unique, dropped };
}

export function describeControl(c: AppControl, model: AppModel): ControlDescriptor {
  const page = pageOf(model, c.page);
  let redactions = 0;
  const scrub = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    const r = scrubText(s);
    redactions += r.count;
    return r.text;
  };
  const isTable = c.kind === "table";
  // Table captions on list pages usually carry counts ("100 orders · showing 1–25"): data.
  const tableName = isTable && (/\d/.test(c.name) || isDataLike(c.name)) ? "table" : c.name;
  if (isTable && tableName !== c.name) redactions++;
  const name = isTable ? tableName : (scrub(c.name) ?? "");
  const label = scrub(c.label);
  const options = enumerationOptions(c);
  if (c.kind === "select" && c.options?.length && !options) redactions++;
  const param = c.param && /^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/.test(c.param) && !isDataLike(c.param) ? c.param : undefined;
  if (c.param && !param) redactions++;
  const { strategies, dropped } = semanticStrategies(c);
  redactions += dropped;
  const headers = isTable ? tableHeaders(c).map((h) => scrub(h) ?? h) : undefined;
  const semanticName = isTable ? (tableName === "table" ? "table" : tableName) : label || name || c.kind;
  return {
    app: c.app,
    routeFamily: c.page,
    kind: c.kind,
    role: c.role,
    name,
    label,
    type: c.type,
    param,
    options,
    headers,
    formSignature: formSignatureOf(model, page, c.formId),
    inDialog: c.inDialog || undefined,
    tabPanel: scrub(c.tabPanel),
    effect: c.effectGuess,
    strategies,
    regionFingerprint: c.locator.regionFingerprint,
    semanticName,
    redactions,
  };
}

/** `${app}:${routeFamily}:${kind}:${slug(label||name)}` */
export function baseKey(d: Pick<ControlDescriptor, "app" | "routeFamily" | "kind" | "semanticName">): string {
  return `${d.app}:${d.routeFamily}:${d.kind}:${slug(d.semanticName)}`;
}

/** Context qualifiers used, in order, to disambiguate two controls with the same base key. */
export function qualifiers(d: ControlDescriptor): string[] {
  const q: string[] = [];
  if (d.inDialog) q.push("@dialog");
  if (d.tabPanel) q.push(`@tab_${slug(d.tabPanel)}`);
  if (d.formSignature) q.push(`@f${d.formSignature.slice(0, 6)}`);
  if (d.param) q.push(`@p_${slug(d.param)}`);
  if (d.headers?.length) q.push(`@h${shortHash(d.headers.join("|"), 6)}`);
  return q;
}
