import { z } from "zod";

/**
 * Procedure DSL: the only plan format a model is allowed to produce.
 *
 * Constraints that make it safe to accept from a model:
 * - Every `control` must be an id from the observed app model. The compiler rejects unknown ids,
 *   so a model cannot invent a target it never saw.
 * - Values are expressions in the closed, side-effect-free Overclock expression language.
 * - No recursion and no free-form maps, so it fits the structured-output JSON schema subset.
 */

/**
 * Schemas are built by a factory so the same definitions serve two encodings:
 *  - canonical (`optional` keys) for code, tests, and stored artifacts;
 *  - model-facing (`required + nullable`): structured outputs cap a schema at 24 optional
 *    parameters, and required-nullable fields don't count toward that limit.
 */
type OptFn<M> = M extends "canonical" ? <T extends z.ZodTypeAny>(t: T) => z.ZodOptional<T> : <T extends z.ZodTypeAny>(t: T) => z.ZodNullable<T>;

function makeDsl<M extends "canonical" | "model">(mode: M) {
  const opt = (mode === "canonical" ? <T extends z.ZodTypeAny>(t: T) => t.optional() : <T extends z.ZodTypeAny>(t: T) => t.nullable()) as OptFn<M>;
  const Expr = z
    .string()
    .describe(
      "Overclock expression. Paths: $rec.<field>, $input.<name>, $out.<stepId>.<field>, $phase.<phaseId> (list of finished record scopes). Literals: 'text', 12, true, null. Operators: == != < <= > >= && || ! in. Functions: lower upper trim len contains startsWith concat coalesce get lookup pluck filterBy countBy entries unique range toNumber isEmpty.",
    );

  const Template = z
    .string()
    .describe("String template; {expr} segments are evaluated, e.g. '/orders/{$rec.orderId}'. Paths are relative to the app origin.");

  const ControlRef = z.string().describe("Control id copied exactly from the app model");

  const StepBase = {
    id: z.string().describe("Unique step id within the plan, snake_case"),
    when: opt(Expr.describe("Guard: the step is skipped when this evaluates falsy")),
    after: opt(z.array(z.string()).describe("Extra step ids this step must wait for")),
    note: opt(z.string()),
  };

  const DslGoto = z.object({ ...StepBase, op: z.literal("goto"), app: z.string(), url: Template });
  const DslFill = z.object({ ...StepBase, op: z.literal("fill"), control: ControlRef, value: Expr });
  const DslSelect = z.object({ ...StepBase, op: z.literal("select"), control: ControlRef, value: Expr });
  const DslClick = z.object({
    ...StepBase,
    op: z.literal("click"),
    control: ControlRef,
    purpose: z.enum(["navigate", "open", "tab", "toggle", "dismiss", "paginate", "other"]),
  });
  const DslSubmit = z.object({
    ...StepBase,
    op: z.literal("submit"),
    control: ControlRef,
    writes: z.array(z.string()).describe("Resource keys written, e.g. 'app:support:ticket:{$out.find_ticket.ticketId}'"),
    guards: z
      .array(z.object({ control: ControlRef, equals: Expr }))
      .describe("Compare-and-swap checks evaluated on the form before submitting: current value must equal the value read earlier"),
    verify: z.object({
      url: Template.describe("Page that shows the saved state (loaded fresh after the write)"),
      fields: z.array(z.object({ name: z.string(), control: ControlRef, equals: Expr })),
    }),
    irreversible: z.boolean().describe("True for payments, deletions, publishing, sending messages, refunds"),
  });
  const DslExtract = z.object({
    ...StepBase,
    op: z.literal("extract"),
    fields: z.array(
      z.object({
        name: z.string(),
        control: ControlRef,
        parse: z.enum(["string", "number", "boolean"]),
        optional: opt(z.boolean()),
      }),
    ),
  });
  const DslExtractTable = z.object({
    ...StepBase,
    op: z.literal("extractTable"),
    table: ControlRef,
    columns: z.array(z.object({ name: z.string(), header: z.string() })),
    key: opt(z.string().describe("Output column name that uniquely keys rows")),
    links: opt(z.array(z.string()).describe("Output column names whose cell link href should be captured as <name>Href")),
    paginateNext: opt(ControlRef.describe("'Next page' control; the runtime clicks it until disabled/absent or maxPages")),
    maxPages: opt(z.number().int()),
  });
  const DslCompute = z.object({
    ...StepBase,
    op: z.literal("compute"),
    assign: z.array(z.object({ name: z.string(), expr: Expr })),
  });
  const DslAssert = z.object({ ...StepBase, op: z.literal("assert"), expr: Expr, message: z.string() });
  const DslWait = z.object({
    ...StepBase,
    op: z.literal("waitFor"),
    control: opt(ControlRef),
    text: opt(z.string()),
  });

  const DslStep = z.discriminatedUnion("op", [
    DslGoto,
    DslFill,
    DslSelect,
    DslClick,
    DslSubmit,
    DslExtract,
    DslExtractTable,
    DslCompute,
    DslAssert,
    DslWait,
  ]);

  const DslPhase = z.object({
    id: z.string(),
    kind: z.enum(["once", "foreach"]),
    over: opt(Expr.describe("foreach only: list expression, usually $input.records")),
    key: opt(Expr.describe("foreach only: stable unique key per item, e.g. $rec.orderId")),
    maxIterations: opt(z.number().int()),
    dependsOn: z.array(z.string()).describe("Phase ids that must fully complete first"),
    steps: z.array(DslStep),
  });

  const DslPlan = z.object({
    strategy: z.object({
      name: z.string(),
      summary: z.string(),
      rationale: z.string(),
    }),
    phases: z.array(DslPhase),
    outcomes: z.array(z.object({ id: z.string(), description: z.string() })),
    assumptions: z.array(z.string()),
    risks: z.array(z.string()),
  });

  return { DslGoto, DslFill, DslSelect, DslClick, DslSubmit, DslExtract, DslExtractTable, DslCompute, DslAssert, DslWait, DslStep, DslPhase, DslPlan };
}

const canonical = makeDsl("canonical");
const forModel = makeDsl("model");

export const DslGoto = canonical.DslGoto;
export const DslFill = canonical.DslFill;
export const DslSelect = canonical.DslSelect;
export const DslClick = canonical.DslClick;
export const DslSubmit = canonical.DslSubmit;
export const DslExtract = canonical.DslExtract;
export const DslExtractTable = canonical.DslExtractTable;
export const DslCompute = canonical.DslCompute;
export const DslAssert = canonical.DslAssert;
export const DslWait = canonical.DslWait;
export const DslStep = canonical.DslStep;
export const DslPhase = canonical.DslPhase;
export const DslPlan = canonical.DslPlan;
export type DslStep = z.infer<typeof DslStep>;
export type DslStepOp = DslStep["op"];
export type DslPhase = z.infer<typeof DslPhase>;
export type DslPlan = z.infer<typeof DslPlan>;

/** Model-facing schema (required + nullable). Parse with it, then `normalizeModelPlan`. */
export const DslPlanForModel = forModel.DslPlan;

/** Convert a model-encoded plan (nulls for absent values) into the canonical form. */
export function normalizeModelPlan(plan: z.infer<typeof DslPlanForModel>): DslPlan {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== null) out[k] = strip(x);
      return out;
    }
    return v;
  };
  return DslPlan.parse(strip(plan));
}

/** Replacement for one invalidated phase segment, produced by local recompilation (recovery L3). */
export const DslSegmentPatch = z.object({
  phaseId: z.string(),
  replaceStepIds: z.array(z.string()),
  steps: z.array(DslStep),
  rationale: z.string(),
});
export type DslSegmentPatch = z.infer<typeof DslSegmentPatch>;
