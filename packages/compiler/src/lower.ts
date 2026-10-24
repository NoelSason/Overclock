import type { ActionNode, AppBinding, AppControl, AppModel, Condition, DslPlan, DslStep, ExecutionProgram, SemanticLocator } from "@overclock/contracts";
import { IR_VERSION } from "@overclock/contracts";
import { ExprError, parseExpr, templateExprs } from "./expr";

export interface Issue {
  severity: "error" | "warning";
  code: string;
  message: string;
  stepId?: string | undefined;
  phaseId?: string | undefined;
}

export interface LowerInput {
  plan: DslPlan;
  models: AppModel[];
  apps: AppBinding[];
  goal: string;
  inputs: Record<string, unknown>;
  programId: string;
  strategyId: string;
}

export interface LowerResult {
  program: ExecutionProgram;
  issues: Issue[];
}

const DEFAULT_TIMEOUT = 10_000;

/** `{$rec.id}`-style template with every expression replaced by `*` (for resource identity). */
export function templateShape(t: string): string {
  return t.replace(/\{[^}]*\}/g, "{}");
}

/** Resource key for the entity a page shows: app + path template with the trailing /edit removed. */
export function pageResource(app: string, urlTemplate: string): string {
  const path = urlTemplate.split("?")[0]!.replace(/\/(edit|update)\/?$/, "");
  return `page:${app}:${path}`;
}

function attrFor(c: AppControl): "text" | "value" {
  return c.kind === "input" || c.kind === "select" || c.kind === "textarea" || c.kind === "checkbox" ? "value" : "text";
}

function base(id: string, type: ActionNode["type"], extra: Partial<ActionNode> = {}): ActionNode {
  return { id, type, dependsOn: [], preconditions: [], postconditions: [], reads: [], writes: [], effect: "read", retryPolicy: "safe", timeoutMs: DEFAULT_TIMEOUT, ...extra };
}

/** Expressions used by a step (for validation and data-dependency inference). */
export function stepExprs(s: DslStep): string[] {
  const xs: string[] = [];
  if (s.when) xs.push(s.when);
  switch (s.op) {
    case "goto":
      xs.push(...templateExprs(s.url));
      break;
    case "fill":
    case "select":
      xs.push(s.value);
      break;
    case "submit":
      for (const g of s.guards) xs.push(g.equals);
      for (const f of s.verify.fields) xs.push(f.equals);
      xs.push(...templateExprs(s.verify.url));
      for (const w of s.writes) xs.push(...templateExprs(w));
      break;
    case "compute":
      for (const a of s.assign) xs.push(a.expr);
      break;
    case "assert":
      xs.push(s.expr);
      break;
    default:
      break;
  }
  return xs;
}

/**
 * Lower a planner DSL plan into IR. Every control reference is resolved against the observed
 * app models; anything unresolvable becomes an error issue (never a guessed locator).
 */
export function lowerPlan(input: LowerInput): LowerResult {
  const issues: Issue[] = [];
  const controls = new Map<string, AppControl>();
  for (const m of input.models) for (const [id, c] of Object.entries(m.controls)) controls.set(id, c);
  const appNames = new Set(input.apps.map((a) => a.name));
  const phaseIds = new Set(input.plan.phases.map((p) => p.id));
  const allStepIds = new Set<string>();
  const nodes: ActionNode[] = [];

  const control = (s: DslStep, id: string, app: string | undefined): AppControl | null => {
    const c = controls.get(id);
    if (!c) {
      issues.push({ severity: "error", code: "unknown-control", message: `Step "${s.id}" references control "${id}", which was never observed`, stepId: s.id });
      return null;
    }
    if (app && c.app !== app) issues.push({ severity: "error", code: "control-app-mismatch", message: `Step "${s.id}" uses ${c.app} control "${id}" while the page is ${app} (add a goto first)`, stepId: s.id });
    return c;
  };
  const locatorOf = (c: AppControl): SemanticLocator => structuredClone(c.locator);

  for (const phase of input.plan.phases) {
    if (allStepIds.has(phase.id)) issues.push({ severity: "error", code: "duplicate-id", message: `Phase id "${phase.id}" collides with a step id`, phaseId: phase.id });
    for (const d of phase.dependsOn) if (!phaseIds.has(d)) issues.push({ severity: "error", code: "unknown-phase", message: `Phase "${phase.id}" depends on unknown phase "${d}"`, phaseId: phase.id });

    const body: ActionNode[] = [];
    const localIds = new Set<string>();
    let app: string | undefined;
    let pageUrl: string | undefined;
    const lastOnApp = new Map<string, string>();

    for (const s of phase.steps) {
      if (allStepIds.has(s.id) || phaseIds.has(s.id)) issues.push({ severity: "error", code: "duplicate-id", message: `Duplicate step id "${s.id}"`, stepId: s.id });
      allStepIds.add(s.id);
      // Validate expressions first so later inference can rely on them.
      const exprs = stepExprs(s);
      const deps = new Set<string>(s.after ?? []);
      for (const e of exprs) {
        try {
          const p = parseExpr(e);
          for (const r of p.roots) if (!["rec", "input", "out", "phase", "key"].includes(r)) issues.push({ severity: "error", code: "unknown-root", message: `Step "${s.id}" uses unknown path root $${r}`, stepId: s.id });
          if (p.roots.has("rec") && phase.kind !== "foreach") issues.push({ severity: "error", code: "rec-outside-foreach", message: `Step "${s.id}" uses $rec outside a foreach phase`, stepId: s.id });
          for (const ref of p.outRefs) {
            if (!localIds.has(ref)) issues.push({ severity: "error", code: "unknown-ref", message: `Step "${s.id}" reads $out.${ref}, which is not an earlier step in phase "${phase.id}"`, stepId: s.id });
            else deps.add(ref);
          }
          for (const ref of p.phaseRefs) {
            if (!phaseIds.has(ref)) issues.push({ severity: "error", code: "unknown-phase", message: `Step "${s.id}" reads $phase.${ref}, which is not a phase`, stepId: s.id });
            else if (!phase.dependsOn.includes(ref)) issues.push({ severity: "error", code: "phase-dependency", message: `Step "${s.id}" reads $phase.${ref} but phase "${phase.id}" does not depend on it`, stepId: s.id });
          }
        } catch (err) {
          issues.push({ severity: "error", code: "bad-expression", message: `Step "${s.id}": ${err instanceof ExprError ? err.message : String(err)}`, stepId: s.id });
        }
      }

      let n: ActionNode;
      switch (s.op) {
        case "goto": {
          if (!appNames.has(s.app)) issues.push({ severity: "error", code: "unknown-app", message: `Step "${s.id}" navigates to unknown app "${s.app}"`, stepId: s.id });
          if (/^[a-z]+:\/\//i.test(s.url)) {
            const origin = input.apps.find((a) => a.name === s.app)?.origin;
            if (!origin || !s.url.startsWith(origin)) issues.push({ severity: "error", code: "origin", message: `Step "${s.id}" navigates outside the app's origin`, stepId: s.id });
          }
          app = s.app;
          pageUrl = s.url;
          n = base(s.id, "navigate", { app, url: { template: s.url }, reads: [pageResource(app, s.url)] });
          break;
        }
        case "fill":
        case "select": {
          const c = control(s, s.control, app);
          n = base(s.id, s.op, { app, target: c ? locatorOf(c) : undefined, input: { expr: s.value }, effect: "local-write" });
          if (c && s.op === "select" && c.kind !== "select") issues.push({ severity: "warning", code: "select-non-select", message: `Step "${s.id}" selects on a ${c.kind}`, stepId: s.id });
          break;
        }
        case "click": {
          const c = control(s, s.control, app);
          if (c?.effectGuess === "remote-write" || c?.effectGuess === "irreversible")
            issues.push({ severity: "error", code: "write-via-click", message: `Step "${s.id}" clicks "${c.name}", which writes; use a submit step with verification`, stepId: s.id });
          n = base(s.id, "click", { app, target: c ? locatorOf(c) : undefined, effect: s.purpose === "toggle" ? "local-write" : "read", description: s.purpose });
          break;
        }
        case "submit": {
          const c = control(s, s.control, app);
          const irreversible = s.irreversible || c?.effectGuess === "irreversible";
          const verifyFields = s.verify.fields
            .map((f) => {
              const vc = controls.get(f.control);
              if (!vc) {
                issues.push({ severity: "error", code: "unknown-control", message: `Step "${s.id}" verifies with unknown control "${f.control}"`, stepId: s.id });
                return null;
              }
              return { name: f.name, target: locatorOf(vc), equals: { expr: f.equals }, attr: attrFor(vc) };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          if (verifyFields.length === 0) issues.push({ severity: "error", code: "missing-verification", message: `Submit "${s.id}" has no read-back verification fields`, stepId: s.id });
          if (s.writes.length === 0) issues.push({ severity: "error", code: "missing-writes", message: `Submit "${s.id}" declares no written resources`, stepId: s.id });
          const guards: Condition[] = s.guards
            .map((g) => {
              const gc = controls.get(g.control);
              if (!gc) {
                issues.push({ severity: "error", code: "unknown-control", message: `Step "${s.id}" guards with unknown control "${g.control}"`, stepId: s.id });
                return null;
              }
              return { kind: "fieldEquals" as const, target: locatorOf(gc), expected: { expr: g.equals }, attr: attrFor(gc) };
            })
            .filter((x): x is NonNullable<typeof x> => x !== null);
          // Compare-and-swap guards must see the form as loaded, before any fill/select changes it:
          // attach them to the first interaction after the edit page's goto (or the submit itself).
          let guardHost: ActionNode | undefined;
          if (app) {
            const lastGoto = [...body].reverse().find((b) => b.type === "navigate" && b.app === app);
            if (lastGoto) guardHost = body.slice(body.indexOf(lastGoto) + 1).find((b) => b.app === app && (b.type === "fill" || b.type === "select" || b.type === "click"));
          }
          if (guardHost) guardHost.preconditions.push(...guards);
          n = base(s.id, "click", {
            app,
            target: c ? locatorOf(c) : undefined,
            effect: irreversible ? "irreversible" : "remote-write",
            retryPolicy: irreversible ? "never" : "verify-before-retry",
            requiresApproval: irreversible || undefined,
            preconditions: guardHost ? [] : guards,
            writes: [...s.writes, ...(app ? [pageResource(app, s.verify.url)] : [])],
            verify: { url: { template: s.verify.url }, fields: verifyFields },
            timeoutMs: 15_000,
          });
          break;
        }
        case "extract": {
          n = base(s.id, "extract", {
            app,
            reads: app && pageUrl ? [pageResource(app, pageUrl)] : [],
            fields: s.fields.map((f) => {
              const c = control(s, f.control, app);
              return { name: f.name, target: c ? locatorOf(c) : { strategies: [{ kind: "css" as const, selector: "__missing__" }], confidence: 0, evidence: [] }, attr: c ? attrFor(c) : "text", parse: f.parse, optional: f.optional ?? false };
            }),
          });
          break;
        }
        case "extractTable": {
          const c = control(s, s.table, app);
          const next = s.paginateNext ? control(s, s.paginateNext, app) : null;
          const columns: Record<string, string> = {};
          for (const col of s.columns) columns[col.name] = col.header;
          if (c && c.kind === "table") {
            const headers = (c.detail ?? "").split("|").map((h) => h.trim().toLowerCase());
            for (const col of s.columns) if (headers.length && !headers.includes(col.header.trim().toLowerCase())) issues.push({ severity: "error", code: "unknown-column", message: `Step "${s.id}" reads column "${col.header}", which the table does not have (${c.detail})`, stepId: s.id });
          }
          n = base(s.id, "extract", {
            app,
            reads: app && pageUrl ? [pageResource(app, pageUrl)] : [],
            table: {
              target: c ? locatorOf(c) : { strategies: [{ kind: "css", selector: "table" }], confidence: 0, evidence: [] },
              columns,
              key: s.key ?? undefined,
              linkColumns: s.links ?? [],
              pagination: next ? { next: locatorOf(next), maxPages: Math.min(200, s.maxPages ?? 50) } : undefined,
            },
            timeoutMs: 60_000,
          });
          break;
        }
        case "compute": {
          const assign: Record<string, string> = {};
          for (const a of s.assign) assign[a.name] = a.expr;
          n = base(s.id, "compute", { assign });
          break;
        }
        case "assert":
          n = base(s.id, "assert", { condition: s.expr, description: s.message });
          break;
        case "waitFor": {
          const c = s.control ? control(s, s.control, app) : null;
          n = base(s.id, "waitFor", {
            app,
            until: c ? { kind: "visible", target: locatorOf(c) } : { kind: "textPresent", text: { value: s.text ?? "" } },
            timeoutMs: 10_000,
          });
          break;
        }
      }
      if (s.when) n.when = s.when;
      if (s.note) n.description = n.description ? `${n.description}: ${s.note}` : s.note;
      // Page continuity: actions on a page depend on the step that loaded or last changed it.
      if (n.app && s.op !== "goto") {
        const prev = lastOnApp.get(n.app);
        if (prev) deps.add(prev);
        else if (n.type !== "compute" && n.type !== "assert") issues.push({ severity: "error", code: "no-page", message: `Step "${s.id}" acts on ${n.app} before any goto in phase "${phase.id}"`, stepId: s.id });
      }
      if (n.app) lastOnApp.set(n.app, s.id);
      n.dependsOn = [...deps].filter((d) => d !== s.id);
      if (s.op === "goto" || s.op === "extract" || s.op === "extractTable" || s.op === "submit" || s.op === "click" || s.op === "fill" || s.op === "select" || s.op === "waitFor") n.sessionKey = n.app;
      localIds.add(s.id);
      body.push(n);
    }

    if (phase.kind === "foreach") {
      if (!phase.over) issues.push({ severity: "error", code: "foreach-over", message: `foreach phase "${phase.id}" has no 'over' list`, phaseId: phase.id });
      if (!phase.key) issues.push({ severity: "error", code: "foreach-key", message: `foreach phase "${phase.id}" has no stable 'key'`, phaseId: phase.id });
      for (const e of [phase.over, phase.key]) {
        if (!e) continue;
        try {
          const p = parseExpr(e);
          for (const ref of p.phaseRefs) if (!phase.dependsOn.includes(ref)) issues.push({ severity: "error", code: "phase-dependency", message: `Phase "${phase.id}" iterates over $phase.${ref} without depending on it`, phaseId: phase.id });
        } catch (err) {
          issues.push({ severity: "error", code: "bad-expression", message: `Phase "${phase.id}": ${(err as Error).message}`, phaseId: phase.id });
        }
      }
      const records = Array.isArray(input.inputs.records) ? input.inputs.records.length : 0;
      const maxIterations = Math.min(phase.maxIterations ?? Math.max(records, 1) * 4, 5000);
      nodes.push(base(phase.id, "foreach", { over: phase.over ?? undefined, key: phase.key ?? undefined, as: "rec", maxIterations, body, dependsOn: [...phase.dependsOn], timeoutMs: 3_600_000 }));
    } else {
      for (const n of body) if (n.dependsOn.length === 0) n.dependsOn = [...phase.dependsOn];
      nodes.push(...body);
      nodes.push(base(phase.id, "checkpoint", { dependsOn: body.map((n) => n.id), description: `end of phase ${phase.id}` }));
    }
  }

  if (input.plan.outcomes.length === 0) issues.push({ severity: "error", code: "missing-outcomes", message: "Plan declares no expected outcomes" });

  const program: ExecutionProgram = {
    version: IR_VERSION,
    id: input.programId,
    goal: input.goal,
    strategy: { id: input.strategyId, name: input.plan.strategy.name, summary: input.plan.strategy.summary },
    allowedOrigins: input.apps.map((a) => new URL(a.origin).origin),
    apps: input.apps,
    inputs: input.inputs,
    nodes,
    expectedOutcomes: input.plan.outcomes.map((o) => ({ id: o.id, description: o.description, scope: "record" as const })),
    approvalPolicy: { requireApprovalFor: ["irreversible"], approvedNodes: [] },
  };
  return { program, issues };
}
