import { createHash } from "node:crypto";
import type { AppControl, AppModel, DslPlan, DslStep, RunConfigInput } from "@overclock/contracts";
import { compileProgram, hasErrors, lowerPlan } from "@overclock/compiler";
import type { INetworkClient, PortableCapability } from "@overclock/network-contracts";
import { cacheKey, canonicalOperation, type CachedProgram } from "@overclock/swarm";

/**
 * The workflow library and previews behind the Chrome extension. A workflow is a plan this engine
 * learned (or imported) and cached under its exact operation identity: the instructions' text, the
 * record fields, and the application origins. Nothing here matches by similarity: a preview or a
 * run reuses a workflow only when that identity is equal, and every preview is built from the
 * stored plan (lowered and compiled against the actual records) or from a network capability's own
 * plan, never from the request.
 */

export interface WorkflowApp {
  name: string;
  origin: string;
}

export interface WorkflowSummary {
  id: string;
  title: string;
  instructions: string | null;
  applications: WorkflowApp[];
  recordFields: string[];
  learnedRecords: number | null;
  learnedAt: number | null;
  /** Number of records the instructions themselves state ("these 10 orders"), if they do. */
  requiredRecords: number | null;
  source: "learned-here" | "imported";
  importedFrom: string | null;
  review: { status: string; reason?: string | undefined } | null;
  steps: number;
  changingSteps: number;
  runnable: boolean;
  whyNot: string | null;
}

export type StepAction = "open" | "read" | "read-table" | "fill" | "choose" | "click" | "submit" | "decide" | "check" | "wait";

export interface PreviewStep {
  id: string;
  action: StepAction;
  app: string | null;
  text: string;
  changesData: boolean;
  needsApproval: boolean;
  /** Runs only for records where the plan's condition holds. */
  conditional: boolean;
  /** For a change: the page re-read afterwards to confirm it. */
  verifiedBy: string | null;
}

export interface PreviewPhase {
  id: string;
  runs: "once" | "per-record" | "per-derived-item";
  steps: PreviewStep[];
}

export interface WorkflowPreview {
  /** Binds an approval to exactly this workflow and these records. */
  previewId: string;
  source: "local" | "network" | "new";
  workflowId: string | null;
  title: string;
  instructions: string;
  applications: WorkflowApp[];
  recordFields: string[];
  records: number;
  review: { status: string; reason?: string | undefined } | null;
  network: { versionId: string; publisher: string; state: string; validations: number; successfulReuses: number } | null;
  phases: PreviewPhase[];
  /** Steps that change data, and at most how many writes the per-record phases can make. */
  writes: { steps: number; maxWrites: number | null };
  approvals: number;
  modelCalls: "none" | "planning";
  /** Problems that block a run (a mismatched record count, invalid records). */
  blocking: string[];
  notes: string[];
}

export type RecordRow = Record<string, string>;

const MAX_RECORDS = 1000;
const MAX_VALUE = 200;

export function firstSentence(goal: string): string {
  const line = goal.split("\n").find((l) => l.trim()) ?? goal;
  const m = /^(.+?[.!?])(\s|$)/.exec(line.trim());
  return (m ? m[1]! : line.trim()).slice(0, 160);
}

/** Records the instructions state, when they name the learned count as a number ("these 10 customer orders"). */
export function statedRecordCount(goal: string, learned: number | null): number | null {
  if (!learned) return null;
  return new RegExp(`(^|\\D)${learned}(\\D|$)`).test(firstSentence(goal)) ? learned : null;
}

/** Validate records against a workflow's fields: every row has exactly those fields, as non-empty text. */
export function validateRecords(input: unknown, fields: string[]): { records: RecordRow[]; errors: string[] } {
  const errors: string[] = [];
  if (!Array.isArray(input)) return { records: [], errors: ["records must be a list"] };
  if (input.length === 0) errors.push("add at least one record");
  if (input.length > MAX_RECORDS) errors.push(`at most ${MAX_RECORDS} records per run`);
  const records: RecordRow[] = [];
  const seen = new Set<string>();
  for (const [i, row] of input.slice(0, MAX_RECORDS).entries()) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      errors.push(`record ${i + 1} is not a set of fields`);
      continue;
    }
    const out: RecordRow = {};
    for (const k of Object.keys(row)) if (!fields.includes(k)) errors.push(`record ${i + 1} has an unexpected field "${k}" (expected ${fields.join(", ")})`);
    for (const f of fields) {
      const v = (row as Record<string, unknown>)[f];
      const text = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
      if (!text) errors.push(`record ${i + 1} is missing "${f}"`);
      else if (text.length > MAX_VALUE) errors.push(`record ${i + 1}: "${f}" is longer than ${MAX_VALUE} characters`);
      out[f] = text;
    }
    const id = fields.map((f) => out[f]).join("\u0000");
    if (seen.has(id)) errors.push(`record ${i + 1} repeats an earlier record`);
    seen.add(id);
    records.push(out);
  }
  return { records, errors: [...new Set(errors)].slice(0, 20) };
}

function previewId(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** Readable form of a URL template: "{$rec.orderId}" -> "{orderId}", "{encode($out.read_order.email)}" -> "{email}". */
function readableTemplate(t: string): string {
  return t.replace(/\{([^{}]+)\}/g, (_m, expr: string) => {
    const ids = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    return `{${ids.at(-1) ?? "value"}}`;
  });
}

type ControlLabel = (id: string) => { label: string; app: string | null };

function labelsFromModels(models: AppModel[]): ControlLabel {
  const all = new Map<string, AppControl>();
  for (const m of models) for (const [id, c] of Object.entries(m.controls)) all.set(id, c);
  return (id) => {
    const c = all.get(id);
    return { label: c?.label || c?.name || id, app: c?.app ?? null };
  };
}

function labelsFromCapability(cap: PortableCapability): ControlLabel {
  const all = new Map(cap.controls.map((c) => [c.key, c]));
  return (id) => {
    const c = all.get(id);
    return { label: c?.label || c?.name || id, app: c?.app ?? null };
  };
}

function describe(step: DslStep, label: ControlLabel): PreviewStep {
  const base = { id: step.id, conditional: !!step.when, changesData: false, needsApproval: false, verifiedBy: null as string | null };
  switch (step.op) {
    case "goto":
      return { ...base, action: "open", app: step.app, text: `Open ${step.app} ${readableTemplate(step.url)}` };
    case "extract": {
      const app = step.fields[0] ? label(step.fields[0].control).app : null;
      return { ...base, action: "read", app, text: `Read ${step.fields.map((f) => f.name).join(", ")}` };
    }
    case "extractTable": {
      const t = label(step.table);
      return { ...base, action: "read-table", app: t.app, text: `Read the ${t.label} table (${step.columns.map((c) => c.header).join(", ")})` };
    }
    case "fill": {
      const c = label(step.control);
      return { ...base, action: "fill", app: c.app, text: `Fill “${c.label}”` };
    }
    case "select": {
      const c = label(step.control);
      return { ...base, action: "choose", app: c.app, text: `Choose “${c.label}”` };
    }
    case "click": {
      const c = label(step.control);
      return { ...base, action: "click", app: c.app, text: `Click “${c.label}”` };
    }
    case "submit": {
      const c = label(step.control);
      return { ...base, action: "submit", app: c.app, text: `Save with “${c.label}”`, changesData: true, needsApproval: step.irreversible, verifiedBy: readableTemplate(step.verify.url) };
    }
    case "compute":
      return { ...base, action: "decide", app: null, text: `Decide ${step.assign.map((a) => a.name).join(", ")} (no browser)` };
    case "assert":
      return { ...base, action: "check", app: null, text: `Check: ${step.message}` };
    case "waitFor":
      return { ...base, action: "wait", app: null, text: "Wait for the page" };
  }
}

function phasesOf(plan: DslPlan, label: ControlLabel): PreviewPhase[] {
  return plan.phases.map((p) => ({
    id: p.id,
    runs: p.kind === "once" ? "once" : /^\s*\$input\./.test(p.over ?? "") ? "per-record" : "per-derived-item",
    steps: p.steps.map((s) => describe(s, label)),
  }));
}

function writeCounts(phases: PreviewPhase[], records: number): WorkflowPreview["writes"] {
  const steps = phases.reduce((n, p) => n + p.steps.filter((s) => s.changesData).length, 0);
  const derived = phases.some((p) => p.runs === "per-derived-item" && p.steps.some((s) => s.changesData));
  const perRecord = phases.filter((p) => p.runs === "per-record").reduce((n, p) => n + p.steps.filter((s) => s.changesData).length, 0);
  const once = phases.filter((p) => p.runs === "once").reduce((n, p) => n + p.steps.filter((s) => s.changesData).length, 0);
  return { steps, maxWrites: derived ? null : perRecord * records + once };
}

export interface WorkflowServiceDeps {
  cache: { list(): (CachedProgram & { key: string })[]; get(key: string): CachedProgram | undefined };
  network: () => Promise<INetworkClient | null>;
  /** Whether this engine can plan new workflows (a model key is configured). */
  planningAvailable: boolean;
  /** Applications a new task may use, beyond those of learned workflows. */
  extraApplications?: WorkflowApp[];
}

export class WorkflowService {
  constructor(private readonly d: WorkflowServiceDeps) {}

  /** Learned workflows, newest first. */
  list(): WorkflowSummary[] {
    return this.d.cache
      .list()
      .map((e) => this.summary(e))
      .sort((a, b) => (b.learnedAt ?? 0) - (a.learnedAt ?? 0) || a.title.localeCompare(b.title));
  }

  /** Applications this engine has workflows for (and any configured extras): the supported environment. */
  applications(): WorkflowApp[] {
    const out = new Map<string, WorkflowApp>();
    for (const w of this.list()) for (const a of w.applications) out.set(a.origin, a);
    for (const a of this.d.extraApplications ?? []) out.set(new URL(a.origin).origin, { name: a.name, origin: new URL(a.origin).origin });
    return [...out.values()].sort((a, b) => a.origin.localeCompare(b.origin));
  }

  private summary(e: CachedProgram & { key: string }): WorkflowSummary {
    const learned = e.learned;
    const steps = e.plan.phases.flatMap((p) => p.steps);
    const identityOk = !!learned && cacheKey({ goal: learned.goal, applications: learned.applications, records: [Object.fromEntries(learned.recordFields.map((f) => [f, ""]))] } as never) === e.key;
    const reviewed = e.review?.status === "passed";
    const whyNot = !learned ? "Its instructions weren't stored when it was learned, so it can't be rerun from here." : !identityOk ? "Its stored instructions don't match its identity; it won't be reused." : !reviewed ? "Its plan has no passed review, so it can't run without planning again." : null;
    return {
      id: e.key,
      title: learned ? firstSentence(learned.goal) : (e.plan.strategy.summary || e.plan.strategy.name),
      instructions: learned?.goal ?? null,
      applications: learned?.applications ?? e.models.map((m) => ({ name: m.app, origin: m.origin })),
      recordFields: learned?.recordFields ?? [],
      learnedRecords: learned?.records ?? null,
      learnedAt: learned?.at ?? null,
      requiredRecords: learned ? statedRecordCount(learned.goal, learned.records) : null,
      source: learned?.source.kind === "network" ? "imported" : "learned-here",
      importedFrom: learned?.source.kind === "network" ? learned.source.versionId : null,
      review: e.review ? { status: e.review.status, ...("reason" in e.review ? { reason: e.review.reason } : {}) } : null,
      steps: steps.length,
      changingSteps: steps.filter((s) => s.op === "submit").length,
      runnable: whyNot === null,
      whyNot,
    };
  }

  workflow(id: string): (CachedProgram & { key: string }) | null {
    return this.d.cache.list().find((e) => e.key === id) ?? null;
  }

  /** Preview a learned workflow on these records, or a new task (instructions + applications). */
  async preview(req: { workflowId?: string | undefined; instructions?: string | undefined; applications?: string[] | undefined; records: unknown }): Promise<WorkflowPreview> {
    if (req.workflowId) return this.previewLearned(req.workflowId, req.records);
    return this.previewNew(req.instructions ?? "", req.applications ?? [], req.records);
  }

  private previewLearned(id: string, rawRecords: unknown): WorkflowPreview {
    const entry = this.workflow(id);
    if (!entry) throw new WorkflowError(404, "That workflow isn't in this engine's library.");
    const s = this.summary(entry);
    if (!s.runnable || !entry.learned) throw new WorkflowError(409, s.whyNot ?? "This workflow can't be rerun.");
    const { records, errors } = validateRecords(rawRecords, s.recordFields);
    const blocking = [...errors];
    if (s.requiredRecords !== null && records.length !== s.requiredRecords) blocking.push(`These instructions say ${s.requiredRecords} records (“${s.title}”), and this batch has ${records.length}. Use ${s.requiredRecords} records, or describe a new task.`);
    const goal = entry.learned.goal;
    const apps = entry.learned.applications;
    const notes: string[] = [];
    if (!blocking.length) {
      // The same lowering and compilation a run performs, on these records: a plan that no longer
      // compiles is reported here instead of failing mid-run.
      if (cacheKey({ goal, applications: apps, records } as never) !== id) blocking.push("These records' fields don't match the workflow's identity.");
      const lowered = lowerPlan({ plan: entry.plan, models: entry.models, apps, goal, inputs: { records }, programId: "preview", strategyId: "preview" });
      if (hasErrors(lowered.issues)) blocking.push(`The stored plan doesn't compile for these records: ${lowered.issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 2).join("; ")}`);
      else {
        const compiled = compileProgram(lowered.program);
        notes.push(`Compiled: ${compiled.graph.segments.length} browser segments, ${records.length} record(s).`);
      }
    }
    const phases = phasesOf(entry.plan, labelsFromModels(entry.models));
    return {
      previewId: previewId({ id, records }),
      source: "local",
      workflowId: id,
      title: s.title,
      instructions: goal,
      applications: apps,
      recordFields: s.recordFields,
      records: records.length,
      review: s.review,
      network: null,
      phases,
      writes: writeCounts(phases, records.length),
      approvals: phases.reduce((n, p) => n + p.steps.filter((x) => x.needsApproval).length, 0),
      modelCalls: "none",
      blocking,
      notes,
    };
  }

  private async previewNew(instructions: string, appNames: string[], rawRecords: unknown): Promise<WorkflowPreview> {
    const goal = instructions.trim();
    if (!goal) throw new WorkflowError(400, "Describe the task first.");
    const supported = this.applications();
    const apps = appNames.map((n) => supported.find((a) => a.name === n));
    if (!appNames.length || apps.some((a) => !a)) throw new WorkflowError(400, `Choose applications from this engine's environment: ${supported.map((a) => a.name).join(", ") || "none configured"}.`);
    const fields = Array.isArray(rawRecords) && rawRecords[0] && typeof rawRecords[0] === "object" ? Object.keys(rawRecords[0] as object).sort() : [];
    const { records, errors } = validateRecords(rawRecords, fields);
    const applications = apps as WorkflowApp[];
    const id = cacheKey({ goal, applications, records } as never);
    // Exactly the same instructions, fields, and applications as a learned workflow: that workflow.
    const same = this.workflow(id);
    if (same && this.summary(same).runnable) return this.previewLearned(id, rawRecords);
    const base = { workflowId: null, title: firstSentence(goal), instructions: goal, applications, recordFields: fields, records: records.length, review: null, approvals: 0 };
    const client = await this.d.network().catch(() => null);
    if (client && !errors.length) {
      const op = canonicalOperation(goal, fields);
      const look = await client.lookup({ origins: applications.map((a) => a.origin), canonicalOperation: op, signatures: [] }).catch(() => null);
      const best = look?.candidates.find((c) => c.canonicalOperation === op && c.state === "ACTIVE");
      if (best) {
        const fetched = await client.fetchArtifact(best.versionId).catch(() => null);
        if (fetched && fetched.capability.intent.canonicalOperation === op) {
          const phases = phasesOf(fetched.capability.procedure.plan, labelsFromCapability(fetched.capability));
          return {
            ...base,
            previewId: previewId({ op, applications, records, versionId: best.versionId }),
            source: "network",
            network: { versionId: best.versionId, publisher: best.publisherId.slice(0, 16), state: best.state, validations: best.validations, successfulReuses: best.successfulReuses },
            phases,
            writes: writeCounts(phases, records.length),
            approvals: phases.reduce((n, p) => n + p.steps.filter((x) => x.needsApproval).length, 0),
            modelCalls: "none",
            blocking: errors,
            notes: ["Before anything runs, this engine re-checks every control against the live pages (read-only) and refuses the workflow if a control can't be matched safely."],
          };
        }
      }
    }
    const blocking = [...errors];
    if (!this.d.planningAvailable) blocking.push("This engine has no model access configured, so it can't plan a new task. Pick a learned workflow instead.");
    return {
      ...base,
      previewId: previewId({ goal, applications, records }),
      source: "new",
      network: null,
      phases: [],
      writes: { steps: 0, maxWrites: null },
      modelCalls: "planning",
      blocking,
      notes: [
        "No learned workflow matches these exact instructions. Overclock will explore the applications (read-only) and plan the steps with Claude: model calls, typically about $0.40–0.50 for a three-app task.",
        "The plan passes an adversarial review before any write, and every write is checked by re-reading the page.",
      ],
    };
  }

  /** The run configuration for an approved preview; re-derives everything from the library, not the request. */
  async runConfig(req: { previewId: string; workflowId?: string | undefined; instructions?: string | undefined; applications?: string[] | undefined; records: unknown; allowModelCalls?: boolean | undefined }): Promise<RunConfigInput> {
    const p = await this.preview(req);
    if (p.previewId !== req.previewId) throw new WorkflowError(409, "The workflow or records changed since you reviewed them. Review the preview again.");
    if (p.blocking.length) throw new WorkflowError(422, p.blocking[0]!);
    const records = validateRecords(req.records, p.recordFields).records;
    const common = { goal: p.instructions, applications: p.applications, records, mode: "overclock" as const, thumbnails: true, maxWorkers: 8, label: `extension: ${p.title}` };
    if (p.source === "local") return { ...common, knowledge: "local-only", cache: "warm" };
    if (p.source === "network") return { ...common, knowledge: "network-read" };
    if (!req.allowModelCalls) throw new WorkflowError(422, "A new task needs model calls. Confirm the cost to continue.");
    return { ...common, knowledge: "local-only", cache: "warm" };
  }
}

export class WorkflowError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
