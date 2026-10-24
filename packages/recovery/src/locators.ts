import type { LocatorStrategy, ObservedControl, ObservedDialog, SemanticLocator } from "@overclock/contracts";
import type { Observation } from "@overclock/perception";

export function rawOf(obs: Observation, c: ObservedControl) {
  return obs.raw.controls[Number(c.id.slice(1))];
}

export function formOf(obs: Observation, c: ObservedControl) {
  return c.formId ? obs.forms.find((f) => f.id === c.formId) : undefined;
}

export function isFieldKind(c: ObservedControl): boolean {
  return c.tag === "select" || c.tag === "textarea" || (c.tag === "input" && c.role !== "button") || c.role === "textbox" || c.role === "combobox" || c.role === "listbox" || c.role === "checkbox" || c.role === "switch" || c.role === "searchbox" || c.role === "spinbutton";
}

const SIMPLE_ID = /^#[A-Za-z][\w-]*$/;

/**
 * Semantic locator for an observed control, strategies ordered most specific first: test id,
 * accessible role+name (label for fields), unique element id, visible text, then the structural
 * CSS path as a last resort. Duplicated names are scoped to their form (or dialog).
 */
export function locatorForControl(obs: Observation, c: ObservedControl, opts: { controlId?: string | undefined; confidence: number; dialogScope?: LocatorStrategy | undefined }): SemanticLocator {
  const s: LocatorStrategy[] = [];
  if (c.testId) s.push({ kind: "testId", id: c.testId });
  const field = isFieldKind(c);
  if (field) {
    if (c.label) s.push({ kind: "label", text: c.label, exact: true });
    if (c.name && c.name !== c.label) s.push({ kind: "role", role: c.role, name: c.name, exact: true });
  } else if (c.name) {
    s.push({ kind: "role", role: c.role, name: c.name, exact: true });
  }
  if (SIMPLE_ID.test(c.cssPath)) s.push({ kind: "css", selector: c.cssPath });
  if (!field && c.name && c.role !== "tab") s.push({ kind: "text", text: c.name, exact: true });
  if (field && c.placeholder) s.push({ kind: "placeholder", text: c.placeholder });
  if (!SIMPLE_ID.test(c.cssPath)) s.push({ kind: "css", selector: c.cssPath });

  let scope: LocatorStrategy | undefined = opts.dialogScope;
  if (!scope) {
    const dup = obs.controls.filter((o) => o.id !== c.id && o.role === c.role && (o.label ?? o.name) === (c.label ?? c.name)).length > 0;
    const form = formOf(obs, c);
    if (dup && form) scope = { kind: "css", selector: form.cssPath };
  }
  return {
    controlId: opts.controlId,
    strategies: s,
    scope,
    confidence: Math.max(0, Math.min(1, Math.round(opts.confidence * 100) / 100)),
    evidence: [{ observationId: obs.id, url: obs.url, controlId: c.id }],
  };
}

/** Scope strategy for an open dialog: by accessible name when it has a title. */
export function dialogScope(d: ObservedDialog, role: string): LocatorStrategy {
  return d.title ? { kind: "role", role, name: d.title, exact: true } : { kind: "css", selector: ":is([role=dialog],[role=alertdialog],dialog[open]):visible" };
}

export function locatorForFact(obs: Observation, factIdx: number, opts: { controlId?: string | undefined; confidence: number }): SemanticLocator | null {
  const f = obs.raw.facts[factIdx];
  if (!f) return null;
  return {
    controlId: opts.controlId,
    strategies: [
      { kind: "css", selector: `xpath=${f.xpath}` },
      { kind: "css", selector: f.cssPath },
    ],
    confidence: opts.confidence,
    evidence: [{ observationId: obs.id, url: obs.url, controlId: `fact:${f.label}` }],
  };
}

export function locatorForTable(obs: Observation, tableIdx: number, opts: { controlId?: string | undefined; confidence: number }): SemanticLocator | null {
  const t = obs.tables[tableIdx];
  if (!t) return null;
  const strategies: LocatorStrategy[] = [];
  if (t.caption) strategies.push({ kind: "role", role: "table", name: t.caption, exact: true });
  strategies.push({ kind: "css", selector: t.cssPath });
  return { controlId: opts.controlId, strategies, confidence: opts.confidence, evidence: [{ observationId: obs.id, url: obs.url, controlId: t.id }] };
}
