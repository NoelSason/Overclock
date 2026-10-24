import { z } from "zod";

/**
 * Semantic Execution IR.
 *
 * The planner never emits this directly: it emits the Procedure DSL (dsl.ts), which the
 * compiler lowers into IR after resolving every control reference against observed
 * evidence. The executor only ever consumes validated IR.
 */

export const IR_VERSION = "1.0";

export const ActionType = z.enum([
  "navigate",
  "locate",
  "click",
  "fill",
  "select",
  "extract",
  "assert",
  "branch",
  "foreach",
  "waitFor",
  "checkpoint",
  "compute",
]);
export type ActionType = z.infer<typeof ActionType>;

export const Effect = z.enum(["read", "local-write", "remote-write", "irreversible"]);
export type Effect = z.infer<typeof Effect>;

export const RetryPolicy = z.enum(["safe", "verify-before-retry", "never"]);
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const LocatorStrategy = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string().optional(), exact: z.boolean().optional() }),
  z.object({ kind: z.literal("label"), text: z.string(), exact: z.boolean().optional() }),
  z.object({ kind: z.literal("placeholder"), text: z.string() }),
  z.object({ kind: z.literal("testId"), id: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string(), exact: z.boolean().optional() }),
  z.object({ kind: z.literal("css"), selector: z.string() }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const ObservationReference = z.object({
  observationId: z.string(),
  url: z.string().optional(),
  controlId: z.string().optional(),
});
export type ObservationReference = z.infer<typeof ObservationReference>;

export const SemanticLocator = z.object({
  /** App-model control id this locator was derived from (evidence link). */
  controlId: z.string().optional(),
  /** Ranked alternatives; the runtime tries them in order. */
  strategies: z.array(LocatorStrategy).min(1),
  /** Optional container that scopes every strategy (e.g. a form or dialog). */
  scope: LocatorStrategy.optional(),
  frame: z.string().optional(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(ObservationReference).default([]),
  /** Region fingerprint the locator was validated against (for change detection). */
  regionFingerprint: z.string().optional(),
});
export type SemanticLocator = z.infer<typeof SemanticLocator>;

/**
 * Values are either literals or expressions in the safe expression language
 * (see compiler/expr). Templates interpolate `{expr}` segments into a string.
 */
export const ValueSpec = z.union([
  z.object({ value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
  z.object({ expr: z.string() }),
  z.object({ template: z.string() }),
]);
export type ValueSpec = z.infer<typeof ValueSpec>;

export const Condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expr"), expr: z.string(), description: z.string().optional() }),
  z.object({ kind: z.literal("visible"), target: SemanticLocator }),
  z.object({ kind: z.literal("hidden"), target: SemanticLocator }),
  z.object({ kind: z.literal("url"), pattern: z.string() }),
  z.object({ kind: z.literal("textPresent"), text: ValueSpec }),
  z.object({ kind: z.literal("fieldEquals"), target: SemanticLocator, expected: ValueSpec, attr: z.enum(["value", "text"]).default("value") }),
]);
export type Condition = z.infer<typeof Condition>;

export const ParseKind = z.enum(["string", "number", "boolean", "json"]);

export const ExtractField = z.object({
  name: z.string(),
  target: SemanticLocator,
  attr: z.enum(["text", "value", "href"]).default("text"),
  parse: ParseKind.default("string"),
  optional: z.boolean().default(false),
});
export type ExtractField = z.infer<typeof ExtractField>;

export const ExtractTable = z.object({
  target: SemanticLocator,
  /** output field name -> column header text */
  columns: z.record(z.string(), z.string()),
  /** Column (output name) whose value keys each row. */
  key: z.string().optional(),
  /** Column (output name) whose link href should also be captured as `<name>Href`. */
  linkColumns: z.array(z.string()).default([]),
  pagination: z
    .object({
      next: SemanticLocator,
      maxPages: z.number().int().min(1).max(200),
    })
    .optional(),
});
export type ExtractTable = z.infer<typeof ExtractTable>;

export const VerificationSpec = z.object({
  /** Where to read the authoritative state back from (fresh navigation). */
  url: ValueSpec,
  fields: z.array(
    z.object({ target: SemanticLocator, equals: ValueSpec, attr: z.enum(["value", "text"]).default("text"), name: z.string() }),
  ),
});
export type VerificationSpec = z.infer<typeof VerificationSpec>;

export interface ActionNode {
  id: string;
  type: ActionType;
  description?: string | undefined;
  dependsOn: string[];
  /** Origin key (application name) this node executes against; drives segment grouping. */
  app?: string | undefined;
  target?: SemanticLocator | undefined;
  input?: ValueSpec | undefined;
  /** navigate */
  url?: ValueSpec | undefined;
  /** extract */
  fields?: ExtractField[] | undefined;
  table?: ExtractTable | undefined;
  /** compute: name -> expression */
  assign?: Record<string, string> | undefined;
  /** branch: expression evaluated to a boolean, exposed as $out.<id>.taken */
  condition?: string | undefined;
  /** Guard: the node is SKIPPED when this expression evaluates falsy. */
  when?: string | undefined;
  /** foreach */
  over?: string | undefined;
  as?: string | undefined;
  key?: string | undefined;
  maxIterations?: number | undefined;
  body?: ActionNode[] | undefined;
  /** waitFor */
  until?: Condition | undefined;

  preconditions: Condition[];
  postconditions: Condition[];
  /** Resource keys (templates allowed) read or written by this node. */
  reads: string[];
  writes: string[];
  effect: Effect;
  retryPolicy: RetryPolicy;
  /** Read-back verification for state-changing nodes. */
  verify?: VerificationSpec | undefined;
  estimatedLatencyMs?: number | undefined;
  timeoutMs: number;
  sessionKey?: string | undefined;
  resourceLocks?: string[] | undefined;
  evidence?: ObservationReference[] | undefined;
  requiresApproval?: boolean | undefined;
}

export const ActionNodeSchema: z.ZodType<ActionNode> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: ActionType,
    description: z.string().optional(),
    dependsOn: z.array(z.string()),
    app: z.string().optional(),
    target: SemanticLocator.optional(),
    input: ValueSpec.optional(),
    url: ValueSpec.optional(),
    fields: z.array(ExtractField).optional(),
    table: ExtractTable.optional(),
    assign: z.record(z.string(), z.string()).optional(),
    condition: z.string().optional(),
    when: z.string().optional(),
    over: z.string().optional(),
    as: z.string().optional(),
    key: z.string().optional(),
    maxIterations: z.number().int().positive().optional(),
    body: z.array(ActionNodeSchema).optional(),
    until: Condition.optional(),
    preconditions: z.array(Condition),
    postconditions: z.array(Condition),
    reads: z.array(z.string()),
    writes: z.array(z.string()),
    effect: Effect,
    retryPolicy: RetryPolicy,
    verify: VerificationSpec.optional(),
    estimatedLatencyMs: z.number().optional(),
    timeoutMs: z.number().int().positive(),
    sessionKey: z.string().optional(),
    resourceLocks: z.array(z.string()).optional(),
    evidence: z.array(ObservationReference).optional(),
    requiresApproval: z.boolean().optional(),
  }),
) as z.ZodType<ActionNode>;

export const OutcomeAssertion = z.object({
  id: z.string(),
  description: z.string(),
  /** Expression evaluated per record scope (foreach) or globally. */
  expr: z.string().optional(),
  scope: z.enum(["record", "run"]).default("record"),
});
export type OutcomeAssertion = z.infer<typeof OutcomeAssertion>;

export const ApprovalPolicy = z.object({
  /** Effects that always require explicit human approval before execution. */
  requireApprovalFor: z.array(Effect).default(["irreversible"]),
  /** Pre-approved node ids (set by the user in the dashboard). */
  approvedNodes: z.array(z.string()).default([]),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicy>;

export const AppBinding = z.object({ name: z.string(), origin: z.string().url() });
export type AppBinding = z.infer<typeof AppBinding>;

export const ExecutionProgramSchema = z.object({
  version: z.string(),
  id: z.string(),
  goal: z.string(),
  strategy: z.object({ id: z.string(), name: z.string(), summary: z.string() }),
  allowedOrigins: z.array(z.string()),
  apps: z.array(AppBinding),
  inputs: z.record(z.string(), z.unknown()),
  nodes: z.array(ActionNodeSchema),
  expectedOutcomes: z.array(OutcomeAssertion),
  approvalPolicy: ApprovalPolicy,
});
export type ExecutionProgram = z.infer<typeof ExecutionProgramSchema>;
