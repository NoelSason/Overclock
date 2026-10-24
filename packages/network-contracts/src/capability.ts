import { z } from "zod";
import { DslPlan, Effect, LocatorStrategy } from "@overclock/contracts";

/**
 * Portable Execution Capability: a versioned, typed, sanitized execution artifact shared through
 * Overclock Network. It carries the Procedure DSL plus *semantic* control descriptors — never
 * observation-local ids (`c12`) and never data values — so a fresh runtime can rebind every
 * control against its own live observation before anything executes.
 */

export const CAPABILITY_SCHEMA_VERSION = "1";
/** Hard cap on a serialized capability (enforced client-side and in the SpacetimeDB module). */
export const MAX_CAPABILITY_BYTES = 256 * 1024;

export const PortableControl = z.object({
  /** Portable key referenced by the procedure, e.g. "Support:/tickets/:id/edit:select:status". */
  key: z.string(),
  app: z.string(),
  routeFamily: z.string(),
  kind: z.enum(["input", "select", "button", "link", "table", "fact", "checkbox", "textarea", "tab", "pagination"]),
  role: z.string(),
  name: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  param: z.string().optional(),
  /** Enumerated option values/labels (schema, not data). */
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  /** Table column headers (schema, not data). */
  headers: z.array(z.string()).optional(),
  /** Hash of the enclosing form's field schema (labels, types, order-insensitive). */
  formSignature: z.string().optional(),
  inDialog: z.boolean().optional(),
  tabPanel: z.string().optional(),
  effect: Effect.optional(),
  /** Semantic strategies only (role/label/placeholder/text/testId and label-anchored xpath); no positional css. */
  strategies: z.array(LocatorStrategy).min(1),
  regionFingerprint: z.string().optional(),
});
export type PortableControl = z.infer<typeof PortableControl>;

export const PortablePage = z.object({
  app: z.string(),
  routeFamily: z.string(),
  /** Template to reach the page, e.g. "/orders/{id}"; parameters are named, never concrete ids. */
  pathTemplate: z.string(),
  /** How a fresh runtime can find a concrete instance of a parameterized page during rebinding. */
  reachVia: z.object({ routeFamily: z.string(), tableKey: z.string().optional() }).optional(),
  pageFingerprint: z.string(),
  regionFingerprints: z.record(z.string(), z.string()),
  loadMsP50: z.number().optional(),
  paginated: z.boolean().optional(),
  pages: z.number().optional(),
});
export type PortablePage = z.infer<typeof PortablePage>;

export const PortableApplication = z.object({
  /** Logical app name used by the procedure ("Orders"). */
  name: z.string(),
  /** Normalized origin (scheme://host[:port]) — the only origin this app's steps may touch. */
  origin: z.string(),
  routeFamilies: z.array(z.string()),
  interfaceFingerprint: z.string(),
  /** Coarse, non-sensitive compatibility classes. */
  roleClass: z.string().optional(),
  locale: z.string().optional(),
  featureVariant: z.string().optional(),
});
export type PortableApplication = z.infer<typeof PortableApplication>;

export const PortableCapability = z.object({
  schemaVersion: z.literal(CAPABILITY_SCHEMA_VERSION),
  capabilityId: z.string(),
  version: z.number().int().positive(),
  /** Set from the authenticated SpacetimeDB identity by the server; client values are ignored. */
  publisherId: z.string(),
  applications: z.array(PortableApplication).min(1),
  intent: z.object({
    /** Stable operation signature (normalized task rules hash + record schema). */
    canonicalOperation: z.string(),
    description: z.string(),
    inputSchema: z.object({ recordFields: z.array(z.string()) }),
  }),
  procedure: z.object({
    format: z.literal("overclock-procedure-dsl"),
    compilerVersion: z.string(),
    /** DslPlan whose `control` references are PortableControl keys. */
    plan: DslPlan,
  }),
  controls: z.array(PortableControl),
  pages: z.array(PortablePage),
  requirements: z.object({
    permissions: z.array(z.string()),
    allowedOrigins: z.array(z.string()),
    expectedEffects: z.array(z.object({ effect: Effect, resource: z.string(), stepId: z.string() })),
  }),
  verification: z.object({
    rules: z.array(z.object({ stepId: z.string(), url: z.string(), fields: z.array(z.object({ name: z.string(), control: z.string(), equals: z.string() })) })),
  }),
  provenance: z.object({
    artifactHash: z.string(),
    createdAt: z.number(),
    lastValidatedAt: z.number().optional(),
    validationEvidenceId: z.string().optional(),
    /** Verified write receipts in the publishing run (evidence of success, not trust). */
    verifiedReceipts: z.number().int().nonnegative(),
    /** Version this one repairs, if any. */
    parentVersion: z.number().int().positive().optional(),
  }),
});
export type PortableCapability = z.infer<typeof PortableCapability>;
