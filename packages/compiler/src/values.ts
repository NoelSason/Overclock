import type { ValueSpec } from "@overclock/contracts";
import { evaluate, renderTemplate, templateExprs, parseExpr, type Scope } from "./expr";

export function resolveValue(spec: ValueSpec, scope: Scope): unknown {
  if ("value" in spec) return spec.value;
  if ("expr" in spec) return evaluate(spec.expr, scope);
  return renderTemplate(spec.template, scope);
}

/** All expressions embedded in a value spec (for validation and dependency inference). */
export function valueExprs(spec: ValueSpec | undefined): string[] {
  if (!spec) return [];
  if ("expr" in spec) return [spec.expr];
  if ("template" in spec) return templateExprs(spec.template);
  return [];
}

export function valueOutRefs(spec: ValueSpec | undefined): string[] {
  return valueExprs(spec).flatMap((e) => [...parseExpr(e).outRefs]);
}
