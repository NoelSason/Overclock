import type { DslPlan, DslStep } from "@overclock/contracts";
import { parseTemplate } from "@overclock/compiler";
import { routePattern } from "@overclock/perception";

/**
 * Plan walking helpers shared by export (local id -> portable key), rebinding (portable key ->
 * fresh local id), static analysis, and the sanitizer. A plan references controls in exactly
 * these places; anything that adds a reference site to the DSL must be added here too.
 */

export type RefRole = "target" | "guard" | "verify" | "extract" | "table" | "paginate" | "wait";

export interface ControlRef {
  phaseId: string;
  stepId: string;
  op: DslStep["op"];
  role: RefRole;
  ref: string;
  /** App of the page the step acts on (last goto in the phase), as the compiler resolves it. */
  app: string | undefined;
}

export function controlRefs(plan: DslPlan): ControlRef[] {
  const out: ControlRef[] = [];
  for (const phase of plan.phases) {
    let app: string | undefined;
    for (const s of phase.steps) {
      const push = (role: RefRole, ref: string) => out.push({ phaseId: phase.id, stepId: s.id, op: s.op, role, ref, app });
      switch (s.op) {
        case "goto":
          app = s.app;
          break;
        case "fill":
        case "select":
        case "click":
          push("target", s.control);
          break;
        case "submit":
          push("target", s.control);
          for (const g of s.guards) push("guard", g.control);
          for (const f of s.verify.fields) push("verify", f.control);
          break;
        case "extract":
          for (const f of s.fields) push("extract", f.control);
          break;
        case "extractTable":
          push("table", s.table);
          if (s.paginateNext) push("paginate", s.paginateNext);
          break;
        case "waitFor":
          if (s.control) push("wait", s.control);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

/** Copy of the plan with every control reference replaced by `fn(ref)`. */
export function mapControlRefs(plan: DslPlan, fn: (ref: string, ctx: ControlRef) => string): DslPlan {
  const p = structuredClone(plan);
  for (const phase of p.phases) {
    let app: string | undefined;
    for (const s of phase.steps) {
      const m = (role: RefRole, ref: string) => fn(ref, { phaseId: phase.id, stepId: s.id, op: s.op, role, ref, app });
      switch (s.op) {
        case "goto":
          app = s.app;
          break;
        case "fill":
        case "select":
        case "click":
          s.control = m("target", s.control);
          break;
        case "submit":
          s.control = m("target", s.control);
          for (const g of s.guards) g.control = m("guard", g.control);
          for (const f of s.verify.fields) f.control = m("verify", f.control);
          break;
        case "extract":
          for (const f of s.fields) f.control = m("extract", f.control);
          break;
        case "extractTable":
          s.table = m("table", s.table);
          if (s.paginateNext) s.paginateNext = m("paginate", s.paginateNext);
          break;
        case "waitFor":
          if (s.control) s.control = m("wait", s.control);
          break;
        default:
          break;
      }
    }
  }
  return p;
}

export interface SubmitContext {
  phaseId: string;
  step: Extract<DslStep, { op: "submit" }>;
  app: string | undefined;
  /** fill/select steps on the same page chain since the last goto (the fields the submit sends). */
  fills: Extract<DslStep, { op: "fill" | "select" }>[];
  /** extract steps earlier in the phase (values read before the write). */
  reads: Extract<DslStep, { op: "extract" }>[];
}

/** Every submit with the fields it fills and the reads that precede it. */
export function submitContexts(plan: DslPlan): SubmitContext[] {
  const out: SubmitContext[] = [];
  for (const phase of plan.phases) {
    let app: string | undefined;
    let fills: SubmitContext["fills"] = [];
    const reads: SubmitContext["reads"] = [];
    for (const s of phase.steps) {
      if (s.op === "goto") {
        app = s.app;
        fills = [];
      } else if (s.op === "fill" || s.op === "select") fills.push(s);
      else if (s.op === "extract") reads.push(s);
      else if (s.op === "submit") {
        out.push({ phaseId: phase.id, step: s, app, fills: [...fills], reads: [...reads] });
        fills = [];
      }
    }
  }
  return out;
}

/** goto url templates per app (phase order), used to find touched route families. */
export function gotoTemplates(plan: DslPlan): { app: string; url: string; stepId: string }[] {
  const out: { app: string; url: string; stepId: string }[] = [];
  for (const phase of plan.phases) for (const s of phase.steps) if (s.op === "goto") out.push({ app: s.app, url: s.url, stepId: s.id });
  return out;
}

/** Route family of a url template, computed the way perception computes it for a live URL. */
export function templateRoute(template: string): string | null {
  let filled: string;
  try {
    filled = parseTemplate(template)
      .map((p) => p.lit + (p.expr !== undefined ? "X1" : ""))
      .join("");
  } catch {
    return null;
  }
  try {
    const u = /^[a-z][a-z0-9+.-]*:/i.test(filled) ? new URL(filled) : new URL(filled, "http://placeholder.invalid");
    return routePattern(u.toString());
  } catch {
    return null;
  }
}
