import type { ActionNode, AppControl, ExtractField, SemanticLocator } from "@overclock/contracts";
import { resolveValue, toStr } from "@overclock/compiler";
import { describeStrategy, exprScope, type ActionEnv } from "@overclock/browser-runtime";

/** What kind of element the failing node needs. */
export type TargetKind = "button" | "link" | "tab" | "field" | "select" | "checkbox" | "value" | "table";

/** Everything the original (now broken) locator and its node tell us about the intended control. */
export interface TargetDescriptor {
  kind: TargetKind;
  role?: string | undefined;
  /** Names the control was known by: accessible name, label, placeholder, text, control-id hint. */
  names: string[];
  label?: string | undefined;
  testId?: string | undefined;
  cssId?: string | undefined;
  param?: string | undefined;
  inputType?: string | undefined;
  options?: string[] | undefined;
  /** For select nodes: the value the node will choose (the candidate must offer it). */
  desired?: string | undefined;
  /** CSS of the container the original locator was scoped to (usually its form). */
  scopeCss?: string | undefined;
  controlId?: string | undefined;
  /** Short human summary of the original locator. */
  summary: string;
}

/** `orders.orders_id_edit.update_order_button_2` -> `update order` */
export function controlIdHint(controlId: string | undefined): string | undefined {
  if (!controlId) return undefined;
  const last = controlId.split(".").pop() ?? "";
  const words = last
    .replace(/_\d+$/, "")
    .replace(/_(button|link|pagination|table|fact|tab)$/, "")
    .replace(/_/g, " ")
    .trim();
  return words || undefined;
}

export function locatorKey(loc: SemanticLocator): string {
  return loc.controlId ?? loc.strategies.map(describeStrategy).join("|");
}

export function describeLocator(loc: SemanticLocator): string {
  return (loc.controlId ? `${loc.controlId}: ` : "") + loc.strategies.map(describeStrategy).join(" | ");
}

function kindOf(node: ActionNode, loc: SemanticLocator, field: ExtractField | undefined, info: AppControl | undefined, role: string | undefined): TargetKind {
  if (field) return "value";
  if (node.type === "extract" && node.table) return "table";
  if (node.type === "select") return "select";
  if (node.type === "fill") return role === "checkbox" || info?.kind === "checkbox" || info?.type === "checkbox" ? "checkbox" : "field";
  if (node.type === "click") {
    if (role === "link" || info?.kind === "link" || info?.kind === "pagination") return "link";
    if (role === "tab" || info?.kind === "tab") return "tab";
    if (role === "checkbox" || info?.kind === "checkbox") return "checkbox";
    return "button";
  }
  void loc;
  return "value";
}

/** The locator currently in effect for the failing key, plus the original one it replaced. */
export function failingLocator(node: ActionNode, env: ActionEnv, errNodeId: string | undefined): { key: string; field?: ExtractField; current?: SemanticLocator; original?: SemanticLocator } {
  const key = errNodeId && errNodeId !== node.id ? errNodeId : node.id;
  if (key.includes("#")) {
    const name = key.slice(key.indexOf("#") + 1);
    const field = node.fields?.find((f) => f.name === name);
    return { key, field, current: env.locatorOverrides.get(key) ?? field?.target, original: field?.target };
  }
  const original = node.target ?? node.table?.target;
  return { key, current: env.locatorOverrides.get(key) ?? original, original };
}

export function describeTarget(args: { node: ActionNode; env: ActionEnv; loc: SemanticLocator; field?: ExtractField | undefined; info?: AppControl | undefined }): TargetDescriptor {
  const { node, env, loc, field, info } = args;
  const names: string[] = [];
  const add = (s: string | undefined) => {
    if (s && !names.includes(s)) names.push(s);
  };
  let role: string | undefined;
  let label: string | undefined;
  let testId: string | undefined;
  let cssId: string | undefined;
  let param: string | undefined;
  for (const s of loc.strategies) {
    switch (s.kind) {
      case "role":
        role ??= s.role;
        add(s.name);
        break;
      case "label":
        label ??= s.text;
        add(s.text);
        break;
      case "placeholder":
      case "text":
        add(s.text);
        break;
      case "testId":
        testId ??= s.id;
        break;
      case "css": {
        const id = /^#([A-Za-z][\w-]*)$/.exec(s.selector.trim());
        if (id) cssId ??= id[1];
        const nm = /\[name=["']?([\w-]+)["']?\]/.exec(s.selector);
        if (nm) param ??= nm[1];
        break;
      }
    }
  }
  if (info) {
    role ??= info.role;
    label ??= info.label;
    add(info.label);
    add(info.name);
    param ??= info.param;
  }
  if (field) add(field.name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " "));
  add(controlIdHint(loc.controlId));
  let desired: string | undefined;
  if (node.type === "select" && node.input) {
    try {
      desired = toStr(resolveValue(node.input, exprScope(env.scope)));
    } catch {
      desired = undefined;
    }
  }
  const scopeCss = loc.scope?.kind === "css" ? loc.scope.selector : undefined;
  return {
    kind: kindOf(node, loc, field, info, role),
    role,
    names,
    label,
    testId,
    cssId,
    param,
    inputType: info?.type,
    options: info?.options?.map((o) => o.value),
    desired,
    scopeCss,
    controlId: loc.controlId,
    summary: describeLocator(loc),
  };
}

export function isWriteNode(node: ActionNode): boolean {
  return node.effect === "remote-write" || node.effect === "irreversible";
}

/** Plain-language statement of what the failing node is trying to reach (for models and events). */
export function intentOf(node: ActionNode, d: TargetDescriptor): string {
  const name = d.names[0] ? `"${d.names[0]}"` : "the original control";
  switch (d.kind) {
    case "button":
      if (isWriteNode(node)) return `the button that submits (saves) the form being edited, previously labelled ${name}`;
      return `the button ${name}${node.description ? ` (${node.description})` : ""}`;
    case "link":
      return `the link ${name}`;
    case "tab":
      return `the tab ${name}`;
    case "select":
      return `the dropdown field for ${name}${d.desired ? `; it must offer the option "${d.desired}"` : ""}`;
    case "checkbox":
      return `the checkbox ${name}`;
    case "field":
      return `the text field for ${name}`;
    case "table":
      return `the data table ${name}`;
    case "value":
      return `the displayed value or field for ${name}`;
  }
}
