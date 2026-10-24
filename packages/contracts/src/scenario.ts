import { z } from "zod";

/** Arena scenario contracts. Ground truth lives only inside the arena; these are the shapes it exposes. */

/** t3 and t4 are holdout templates: never used while developing prompts or the optimizer. t4 runs on a fourth, structurally different application. */
export const TaskTemplateId = z.enum(["t1-order-reconcile", "t2-ticket-triage", "t3-crm-status-sync", "t4-holdout"]);
export type TaskTemplateId = z.infer<typeof TaskTemplateId>;

export const ScenarioRequest = z.object({
  seed: z.number().int().nonnegative(),
  template: TaskTemplateId.default("t1-order-reconcile"),
  records: z.number().int().min(1).max(500).default(100),
});
export type ScenarioRequest = z.infer<typeof ScenarioRequest>;

/** What a user would hand Overclock: the task text, the records, and the apps. No ground truth. */
export const PublicScenario = z.object({
  scenarioId: z.string(),
  seed: z.number(),
  template: TaskTemplateId,
  title: z.string(),
  goal: z.string(),
  records: z.array(z.record(z.string(), z.unknown())),
  applications: z.array(z.object({ name: z.string(), origin: z.string() })),
  holdout: z.boolean(),
});
export type PublicScenario = z.infer<typeof PublicScenario>;

export const FieldMismatch = z.object({
  recordKey: z.string(),
  entity: z.string(),
  field: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
});
export type FieldMismatch = z.infer<typeof FieldMismatch>;

export const CheckResult = z.object({
  scenarioId: z.string(),
  totalRecords: z.number(),
  correctRecords: z.number(),
  accuracy: z.number(),
  mismatches: z.array(FieldMismatch),
  /** Append-only side effects applied more than once (e.g. duplicate notes). */
  duplicateWrites: z.number(),
  /** Entities changed that the task never asked to change. */
  collateralWrites: z.number(),
  /** Records that need human escalation per the rules; correct handling = left unchanged + escalated. */
  escalationExpected: z.number(),
  checkedAt: z.number(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const VariationConfig = z.object({
  theme: z.enum(["default", "dense", "contrast"]).default("default"),
  /** app -> original button text -> replacement */
  renameButtons: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  /** app -> seed for shuffling edit form field order (0 = original order) */
  shuffleFields: z.record(z.string(), z.number()).default({}),
  /** app -> show a confirmation modal before saving edits */
  confirmModal: z.record(z.string(), z.boolean()).default({}),
  /** app -> show an interstitial announcement modal on first page view per session */
  announcementModal: z.record(z.string(), z.boolean()).default({}),
  /** app -> rows per list page */
  pageSize: z.record(z.string(), z.number().int().min(5).max(200)).default({}),
  /** app -> move the edit form behind a "Details" / "Edit" tab */
  editInTab: z.record(z.string(), z.boolean()).default({}),
  /** app -> latency injection */
  latency: z.record(z.string(), z.object({ baseMs: z.number().min(0), jitterMs: z.number().min(0), slowRate: z.number().min(0).max(1).default(0), slowMs: z.number().min(0).default(0) })).default({}),
  /** app -> write failure injection */
  failures: z
    .record(
      z.string(),
      z.object({
        /** 503 before the write commits */
        beforeCommitRate: z.number().min(0).max(1).default(0),
        /** commit the write, then respond 500 (tests duplicate-write handling) */
        afterCommitRate: z.number().min(0).max(1).default(0),
      }),
    )
    .default({}),
  /** app -> max concurrent in-flight requests before 429 */
  concurrencyLimit: z.record(z.string(), z.number().int().min(1)).default({}),
});
export type VariationConfig = z.infer<typeof VariationConfig>;
