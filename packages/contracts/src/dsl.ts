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
  when: Expr.optional().describe("Guard: the step is skipped when this evaluates falsy"),
  after: z.array(z.string()).optional().describe("Extra step ids this step must wait for"),
  note: z.string().optional(),
};

export const DslGoto = z.object({ ...StepBase, op: z.literal("goto"), app: z.string(), url: Template });
export const DslFill = z.object({ ...StepBase, op: z.literal("fill"), control: ControlRef, value: Expr });
export const DslSelect = z.object({ ...StepBase, op: z.literal("select"), control: ControlRef, value: Expr });
export const DslClick = z.object({
  ...StepBase,
  op: z.literal("click"),
  control: ControlRef,
  purpose: z.enum(["navigate", "open", "tab", "toggle", "dismiss", "paginate", "other"]),
});
export const DslSubmit = z.object({
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
export const DslExtract = z.object({
  ...StepBase,
  op: z.literal("extract"),
  fields: z.array(
    z.object({
      name: z.string(),
      control: ControlRef,
      parse: z.enum(["string", "number", "boolean"]),
      optional: z.boolean().optional(),
    }),
  ),
});
export const DslExtractTable = z.object({
  ...StepBase,
  op: z.literal("extractTable"),
  table: ControlRef,
  columns: z.array(z.object({ name: z.string(), header: z.string() })),
  key: z.string().optional().describe("Output column name that uniquely keys rows"),
  links: z.array(z.string()).optional().describe("Output column names whose cell link href should be captured as <name>Href"),
  paginateNext: ControlRef.optional().describe("'Next page' control; the runtime clicks it until disabled/absent or maxPages"),
  maxPages: z.number().int().optional(),
});
export const DslCompute = z.object({
  ...StepBase,
  op: z.literal("compute"),
  assign: z.array(z.object({ name: z.string(), expr: Expr })),
});
export const DslAssert = z.object({ ...StepBase, op: z.literal("assert"), expr: Expr, message: z.string() });
export const DslWait = z.object({
  ...StepBase,
  op: z.literal("waitFor"),
  control: ControlRef.optional(),
  text: z.string().optional(),
});

export const DslStep = z.discriminatedUnion("op", [DslGoto, DslFill, DslSelect, DslClick, DslSubmit, DslExtract, DslExtractTable, DslCompute, DslAssert, DslWait]);
export type DslStep = z.infer<typeof DslStep>;
export type DslStepOp = DslStep["op"];

export const DslPhase = z.object({
  id: z.string(),
  kind: z.enum(["once", "foreach"]),
  over: Expr.optional().describe("foreach only: list expression, usually $input.records"),
  key: Expr.optional().describe("foreach only: stable unique key per item, e.g. $rec.orderId"),
  maxIterations: z.number().int().optional(),
  dependsOn: z.array(z.string()).describe("Phase ids that must fully complete first"),
  steps: z.array(DslStep),
});
export type DslPhase = z.infer<typeof DslPhase>;

export const DslPlan = z.object({
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
export type DslPlan = z.infer<typeof DslPlan>;

/** Replacement for one invalidated phase segment, produced by local recompilation (recovery L3). */
export const DslSegmentPatch = z.object({
  phaseId: z.string(),
  replaceStepIds: z.array(z.string()),
  steps: z.array(DslStep),
  rationale: z.string(),
});
export type DslSegmentPatch = z.infer<typeof DslSegmentPatch>;

/**
 * Model-facing encoding. Structured outputs cap a schema at 24 optional parameters and 16
 * union-typed (incl. nullable) parameters. The step fields shared by every variant (`when`,
 * `after`, `note`) therefore become required, with "" / [] meaning absent; the remaining
 * per-variant fields stay optional (well under the cap). `normalizeModelPlan` restores the
 * canonical form.
 */
const REQUIRED_EMPTY = new Set(["when", "after", "note"]);

export function toModelSchema(schema: z.ZodType): z.ZodType {
  const conv = (s: z.ZodType, key?: string): z.ZodType => {
    const desc = s.description;
    let out: z.ZodType;
    if (s instanceof z.ZodOptional) {
      const inner = conv(s.unwrap() as z.ZodType);
      out = key && REQUIRED_EMPTY.has(key) ? inner : inner.optional();
    } else if (s instanceof z.ZodObject) out = z.object(Object.fromEntries(Object.entries(s.shape as Record<string, z.ZodType>).map(([k, v]) => [k, conv(v, k)])));
    else if (s instanceof z.ZodArray) out = z.array(conv(s.element as z.ZodType));
    else if (s instanceof z.ZodDiscriminatedUnion) out = z.discriminatedUnion(s.def.discriminator, (s.options as z.ZodObject[]).map((o) => conv(o) as z.ZodObject) as [z.ZodObject, ...z.ZodObject[]]);
    else return s;
    return desc ? out.describe(desc) : out;
  };
  return conv(schema);
}

/** Drop the empty sentinels (and any nulls) a model emitted for absent values, then parse canonically. */
export function normalizeModelOutput<T extends z.ZodType>(canonical: T, value: unknown): z.infer<T> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === null) continue;
        if (REQUIRED_EMPTY.has(k) && (x === "" || (Array.isArray(x) && x.length === 0))) continue;
        out[k] = strip(x);
      }
      return out;
    }
    return v;
  };
  return canonical.parse(strip(value));
}

export const DslPlanForModel = toModelSchema(DslPlan);

export function normalizeModelPlan(plan: unknown): DslPlan {
  return normalizeModelOutput(DslPlan, plan);
}
