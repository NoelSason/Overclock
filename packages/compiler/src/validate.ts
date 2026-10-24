import { ExecutionProgramSchema, type ActionNode, type ExecutionProgram } from "@overclock/contracts";
import { CycleError, findCycle } from "./graph";
import { parseExpr, templateExprs } from "./expr";
import type { Issue } from "./lower";
import { valueExprs } from "./values";

const SUPPORTED = new Set(["navigate", "locate", "click", "fill", "select", "extract", "assert", "branch", "foreach", "waitFor", "checkpoint", "compute"]);

function nodeExprs(n: ActionNode): string[] {
  const xs: string[] = [];
  if (n.when) xs.push(n.when);
  if (n.condition) xs.push(n.condition);
  if (n.over) xs.push(n.over);
  if (n.key) xs.push(n.key);
  xs.push(...valueExprs(n.input), ...valueExprs(n.url));
  for (const e of Object.values(n.assign ?? {})) xs.push(e);
  if (n.verify) {
    xs.push(...valueExprs(n.verify.url));
    for (const f of n.verify.fields) xs.push(...valueExprs(f.equals));
  }
  for (const c of [...n.preconditions, ...n.postconditions]) {
    if (c.kind === "expr") xs.push(c.expr);
    if (c.kind === "fieldEquals") xs.push(...valueExprs(c.expected));
    if (c.kind === "textPresent") xs.push(...valueExprs(c.text));
  }
  for (const w of [...n.writes, ...n.reads]) xs.push(...templateExprs(w));
  return xs;
}

function validateScope(nodes: ActionNode[], scopeName: string, outer: Set<string>, issues: Issue[]): void {
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) issues.push({ severity: "error", code: "duplicate-id", message: `Duplicate node id ${n.id} in ${scopeName}`, stepId: n.id });
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const d of n.dependsOn) if (!ids.has(d) && !outer.has(d)) issues.push({ severity: "error", code: "missing-dependency", message: `Node ${n.id} depends on missing node ${d}`, stepId: n.id });
  }
  const local = nodes.map((n) => ({ id: n.id, deps: n.dependsOn.filter((d) => ids.has(d)) }));
  const cycle = findCycle(local);
  if (cycle.length) issues.push({ severity: "error", code: "cycle", message: new CycleError(cycle).message });
}

/**
 * Structural and safety validation of an IR program. Anything the executor could not run
 * safely is rejected here, before a single browser action happens.
 */
export function validateProgram(program: ExecutionProgram): Issue[] {
  const issues: Issue[] = [];
  const parsed = ExecutionProgramSchema.safeParse(program);
  if (!parsed.success) {
    for (const e of parsed.error.issues.slice(0, 20)) issues.push({ severity: "error", code: "schema", message: `${e.path.join(".")}: ${e.message}` });
    return issues;
  }
  const allowed = new Set(program.allowedOrigins);
  for (const a of program.apps) if (!allowed.has(new URL(a.origin).origin)) issues.push({ severity: "error", code: "origin", message: `App ${a.name} origin ${a.origin} is not allowlisted` });
  const appNames = new Set(program.apps.map((a) => a.name));
  const topIds = new Set(program.nodes.map((n) => n.id));
  validateScope(program.nodes, "program", new Set(), issues);

  const visit = (n: ActionNode, inBody: boolean): void => {
    if (!SUPPORTED.has(n.type)) issues.push({ severity: "error", code: "unsupported", message: `Unsupported operation ${n.type}`, stepId: n.id });
    if (n.app && !appNames.has(n.app)) issues.push({ severity: "error", code: "unknown-app", message: `Node ${n.id} targets unknown app ${n.app}`, stepId: n.id });
    for (const e of nodeExprs(n)) {
      try {
        parseExpr(e);
      } catch (err) {
        issues.push({ severity: "error", code: "bad-expression", message: `Node ${n.id}: ${(err as Error).message}`, stepId: n.id });
      }
    }
    const writes = n.effect === "remote-write" || n.effect === "irreversible";
    if (writes && n.retryPolicy === "safe") issues.push({ severity: "error", code: "unsafe-retry", message: `Node ${n.id} writes remotely but has retry policy "safe"`, stepId: n.id });
    if (n.effect === "irreversible" && !n.requiresApproval && !program.approvalPolicy.approvedNodes.includes(n.id))
      issues.push({ severity: "error", code: "approval", message: `Irreversible node ${n.id} must require human approval`, stepId: n.id });
    if (writes && !n.verify) issues.push({ severity: "error", code: "missing-verification", message: `State-changing node ${n.id} has no read-back verification`, stepId: n.id });
    if (writes && n.writes.length === 0) issues.push({ severity: "error", code: "rw-consistency", message: `State-changing node ${n.id} declares no written resources`, stepId: n.id });
    if (!writes && n.writes.length > 0) issues.push({ severity: "error", code: "rw-consistency", message: `Read-only node ${n.id} declares written resources`, stepId: n.id });
    if (["click", "fill", "select", "locate"].includes(n.type) && !n.target) issues.push({ severity: "error", code: "missing-target", message: `Node ${n.id} (${n.type}) has no target`, stepId: n.id });
    if (n.type === "navigate" && !n.url) issues.push({ severity: "error", code: "missing-url", message: `Navigate ${n.id} has no url`, stepId: n.id });
    if (n.type === "foreach") {
      if (inBody) issues.push({ severity: "error", code: "nested-foreach", message: `Nested foreach ${n.id} is not supported`, stepId: n.id });
      if (!n.over || !n.key) issues.push({ severity: "error", code: "foreach", message: `foreach ${n.id} needs 'over' and 'key'`, stepId: n.id });
      if (!n.maxIterations) issues.push({ severity: "error", code: "unbounded-loop", message: `foreach ${n.id} has no maxIterations bound`, stepId: n.id });
      validateScope(n.body ?? [], `foreach ${n.id}`, topIds, issues);
      for (const b of n.body ?? []) visit(b, true);
    }
  };
  for (const n of program.nodes) visit(n, false);
  if (program.expectedOutcomes.length === 0) issues.push({ severity: "error", code: "missing-outcomes", message: "Program has no expected outcome assertions" });
  return issues;
}

export function hasErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
