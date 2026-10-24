import { z } from "zod";
import { Effect, SemanticLocator } from "./ir";

/** A single interactive (or extractable) element seen on a page. */
export const ObservedControl = z.object({
  /** Observation-local id, e.g. "c12". */
  id: z.string(),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  type: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
  value: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  href: z.string().optional(),
  formId: z.string().optional(),
  region: z.string().optional(),
  inDialog: z.boolean().optional(),
  /** Name of the tab panel containing the control when that panel is not the active one. */
  tabPanel: z.string().optional(),
  disabled: z.boolean().optional(),
  visible: z.boolean(),
  cssPath: z.string(),
});
export type ObservedControl = z.infer<typeof ObservedControl>;

export const ObservedForm = z.object({
  id: z.string(),
  name: z.string().optional(),
  action: z.string().optional(),
  method: z.string(),
  fieldIds: z.array(z.string()),
  submitIds: z.array(z.string()),
  cssPath: z.string(),
});
export type ObservedForm = z.infer<typeof ObservedForm>;

export const ObservedTable = z.object({
  id: z.string(),
  caption: z.string().optional(),
  headers: z.array(z.string()),
  rowCount: z.number().int(),
  sampleRows: z.array(z.array(z.string())),
  /** Headers whose cells contain links (e.g. to a detail page). */
  linkHeaders: z.array(z.string()),
  sampleLinks: z.array(z.string()).default([]),
  cssPath: z.string(),
});
export type ObservedTable = z.infer<typeof ObservedTable>;

export const ObservedDialog = z.object({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  controlIds: z.array(z.string()),
  open: z.boolean(),
});
export type ObservedDialog = z.infer<typeof ObservedDialog>;

export const PageFingerprint = z.object({
  page: z.string(),
  regions: z.record(z.string(), z.string()),
});
export type PageFingerprint = z.infer<typeof PageFingerprint>;

export const PageObservation = z.object({
  id: z.string(),
  url: z.string(),
  routePattern: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  controls: z.array(ObservedControl),
  forms: z.array(ObservedForm),
  tables: z.array(ObservedTable),
  dialogs: z.array(ObservedDialog),
  /** Bounded visible text (untrusted page content). */
  text: z.string(),
  /** Key/value pairs rendered as definition lists or label:value rows on detail pages. */
  facts: z.array(z.object({ label: z.string(), value: z.string(), cssPath: z.string() })),
  fingerprint: PageFingerprint,
  metrics: z.object({ snapshotMs: z.number(), bytes: z.number(), navMs: z.number().optional() }),
});
export type PageObservation = z.infer<typeof PageObservation>;

/** A control promoted into the app model with a stable, globally unique id. */
export const AppControl = z.object({
  id: z.string(),
  app: z.string(),
  page: z.string(),
  role: z.string(),
  name: z.string(),
  label: z.string().optional(),
  type: z.string().optional(),
  /** Form parameter name (the input's name attribute), for GET forms that map to URLs. */
  param: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  kind: z.enum(["input", "select", "button", "link", "table", "fact", "checkbox", "textarea", "tab", "pagination"]),
  formId: z.string().optional(),
  inDialog: z.boolean().optional(),
  tabPanel: z.string().optional(),
  locator: SemanticLocator,
  effectGuess: Effect.optional(),
  /** For tables: headers; for facts: the label; for links: the href. */
  detail: z.string().optional(),
  /** A sample value observed during exploration (untrusted page data). */
  sample: z.string().optional(),
});
export type AppControl = z.infer<typeof AppControl>;

export const AppPage = z.object({
  routePattern: z.string(),
  exampleUrl: z.string(),
  title: z.string(),
  headings: z.array(z.string()),
  controlIds: z.array(z.string()),
  tables: z.array(ObservedTable),
  facts: z.array(z.string()),
  forms: z.array(z.object({ id: z.string(), method: z.string(), action: z.string().optional(), fieldIds: z.array(z.string()), submitIds: z.array(z.string()) })),
  loadMs: z.object({ p50: z.number(), samples: z.number() }),
  fingerprint: z.string(),
  observationId: z.string(),
});
export type AppPage = z.infer<typeof AppPage>;

export const AppOperation = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(["navigate", "search", "read", "list", "edit", "bulk", "other"]),
  page: z.string(),
  params: z.array(z.string()),
  controlIds: z.array(z.string()),
  effect: Effect,
  evidence: z.string(),
});
export type AppOperation = z.infer<typeof AppOperation>;

export const AppFeatures = z.object({
  listTables: z.array(z.object({ page: z.string(), controlId: z.string(), headers: z.array(z.string()), rowsPerPage: z.number(), paginated: z.boolean() })),
  bulkOperations: z.array(z.object({ page: z.string(), description: z.string(), controlIds: z.array(z.string()) })),
  search: z.array(z.object({ page: z.string(), controlId: z.string() })),
});
export type AppFeatures = z.infer<typeof AppFeatures>;

export const AppModel = z.object({
  app: z.string(),
  origin: z.string(),
  pages: z.array(AppPage),
  controls: z.record(z.string(), AppControl),
  operations: z.array(AppOperation),
  features: AppFeatures,
  fingerprint: z.string(),
  crawl: z.object({ pagesVisited: z.number(), ms: z.number(), blockedMutations: z.number() }),
});
export type AppModel = z.infer<typeof AppModel>;
