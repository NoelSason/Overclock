import { createHash } from "node:crypto";
import { canonicalGoalText, canonicalRecordFields, type AgentRole, type AppBinding, type AppModel, type ArtifactSummary, type CostEstimate, type DslPlan, type EventPayload, type RunConfig, type StageName } from "@overclock/contracts";
import type { BrowserManager, StorageState } from "@overclock/browser-runtime";
import { compileProgram, hasErrors, lowerPlan, validateProgram, type CompiledProgram, type Issue } from "@overclock/compiler";
import { buildCatalog, classifyEffects, crawlApp, critiquePlan, dryRunCandidate, generatePlan, renderCatalog, repairPlan, strategyDirectives, type CritiqueResult, type DryRunResult } from "@overclock/discovery";
import type { ClaudeProvider, JevProvider } from "@overclock/models";
import { estimateCost, recommendWorkers, selectCandidate, type LatencyModel } from "@overclock/optimizer";
import { decidePolicy, type PolicyDecision } from "./policy";
import { blockingRisks, reviewPlan, type Assessment, type PlanReview } from "./review";

export interface SwarmDeps {
  runId: string;
  config: RunConfig;
  emit(e: EventPayload): void;
  now(): number;
  browser: BrowserManager;
  /** Session for exploration (read-only explorer role when the app offers one). */
  exploreState?: StorageState | undefined;
  claude: ClaudeProvider;
  jev: JevProvider | null;
  latency: LatencyModel;
  signal: AbortSignal;
  saveArtifact(agentId: string, kind: ArtifactSummary["kind"], title: string, summary: string, data: unknown, stats?: Record<string, number | string>): void;
  /** Warm-start cache (local-only knowledge policy). */
  cache?: ProgramCache | undefined;
  /** A plan imported from the Overclock Network and already rebound to this runtime's controls. */
  imported?: { plan: DslPlan; models: AppModel[]; label: string; reason: string } | undefined;
}

/** A cached plan, with the review it passed before its writes ran (absent in entries written before reviews were recorded). */
export interface CachedProgram {
  plan: DslPlan;
  models: AppModel[];
  review?: PlanReview | undefined;
  /** The cache key it was stored under; a read must match it exactly (entries without it are ignored). */
  key?: string | undefined;
}

export interface ProgramCache {
  get(key: string): CachedProgram | undefined;
  put(key: string, value: CachedProgram): void;
}

export interface CompiledCandidate {
  candidateId: string;
  name: string;
  plan: DslPlan;
  compiled: CompiledProgram | null;
  issues: Issue[];
  valid: boolean;
  estimate: CostEstimate | null;
  workers: number;
  dryRun?: DryRunResult | undefined;
  critique?: CritiqueResult | undefined;
  planningMs: number;
  repaired: boolean;
  /** Set once the candidate passed the review its policy requires. */
  review?: PlanReview | undefined;
}

export interface SwarmResult {
  selected: CompiledCandidate;
  candidates: CompiledCandidate[];
  models: AppModel[];
  policy: PolicyDecision;
  workers: number;
  reason: string;
  /** Review the selected plan passed; stored with it in the cache and required for publication. */
  review: PlanReview;
}

/**
 * Operation identity of a task for the local plan cache: a hash of the exact instructions
 * (canonicalGoalText) and the record schema. Record ids and values don't change it; any different
 * literal, number, or condition does, so a plan is never reused for an operation it wasn't
 * written for. (It used to replace literals and numbers with placeholders, which let a plan for
 * "approved" serve a request for "rejected".)
 */
export function canonicalOperation(goal: string, recordFields: string[]): string {
  return `op2:${createHash("sha256").update(JSON.stringify({ goal: canonicalGoalText(goal), recordFields: canonicalRecordFields(recordFields) })).digest("hex")}`;
}

export function cacheKey(config: RunConfig): string {
  const fields = [...new Set(config.records.flatMap((r) => Object.keys(r)))];
  return `${canonicalOperation(config.goal, fields)}|${config.applications.map((a) => new URL(a.origin).origin).sort().join(",")}`;
}

/** Small helpers shared by the staged and streaming pipelines. */
export class SwarmContext {
  constructor(readonly d: SwarmDeps) {}

  stage<T>(stage: StageName, detail: string | undefined, fn: () => Promise<T>): Promise<T> {
    this.d.emit({ type: "stage", stage, phase: "start", detail });
    return fn().finally(() => this.d.emit({ type: "stage", stage, phase: "end" }));
  }

  async agent<T>(agentId: string, role: AgentRole, label: string, extra: { model?: string; app?: string }, fn: () => Promise<T>): Promise<T> {
    const t = this.d.now();
    this.d.emit({ type: "agent.started", agentId, role, label, ...extra });
    try {
      const r = await fn();
      this.d.emit({ type: "agent.finished", agentId, ok: true, ms: Math.round(this.d.now() - t) });
      return r;
    } catch (err) {
      this.d.emit({ type: "agent.finished", agentId, ok: false, ms: Math.round(this.d.now() - t), error: (err as Error).message.slice(0, 300) });
      throw err;
    }
  }

  /** UI Scouts: crawl every app in parallel; emits live scout.page events and app-model artifacts. */
  async discoverApps(opts: { maxPerPattern?: number; maxPages?: number; agentSuffix?: string } = {}): Promise<AppModel[]> {
    const d = this.d;
    return Promise.all(
      d.config.applications.map((app) =>
        this.agent(`ui-scout:${app.name}${opts.agentSuffix ?? ""}`, "ui-scout", `UI Scout · ${app.name}`, { app: app.name }, async () => {
          const agentId = `ui-scout:${app.name}${opts.agentSuffix ?? ""}`;
          const r = await crawlApp({
            browser: d.browser,
            app,
            storageState: d.exploreState,
            signal: d.signal,
            maxPerPattern: opts.maxPerPattern,
            maxPages: opts.maxPages,
            onPage: (obs, loadMs) => {
              d.latency.observeNav(app.name, loadMs);
              d.emit({ type: "scout.page", agentId, app: app.name, url: new URL(obs.url).pathname, routePattern: obs.routePattern, loadMs: Math.round(loadMs), controls: obs.controls.length });
            },
          });
          for (const t of r.model.features.listTables) if (t.pages && t.controlId) d.latency.tablePages.set(t.controlId, t.pages);
          const stats = { pages: r.model.pages.length, controls: Object.keys(r.model.controls).length, tables: r.model.features.listTables.length, ms: r.model.crawl.ms, blockedMutations: r.model.crawl.blockedMutations };
          d.saveArtifact(agentId, "app-model", `${app.name} app model`, `${stats.pages} route patterns, ${stats.controls} controls, ${stats.tables} list tables; ${r.dismissedDialogs.length ? `dismissed ${r.dismissedDialogs.join(", ")}` : "no blocking dialogs"}`, r.model, stats);
          return r.model;
        }),
      ),
    );
  }

  async classifyEffects(models: AppModel[]): Promise<void> {
    const d = this.d;
    await this.agent("dependency-scout:effects", "dependency-scout", "Dependency Scout · side effects", { model: d.jev?.usable ? d.jev.config.model : "heuristic" }, async () => {
      const r = await classifyEffects(d.jev?.usable ? d.jev : null, models, d.signal);
      const writes = r.results.filter((x) => x.final !== "read");
      d.saveArtifact("dependency-scout:effects", "effect-classification", "Control side effects", `${r.results.length} controls classified (${writes.length} write, ${r.results.filter((x) => x.final === "irreversible").length} irreversible) in ${Math.round(r.ms)} ms with ${r.modelCalls} Jev call(s)`, r.results, { controls: r.results.length, writes: writes.length, jevCalls: r.modelCalls });
    });
  }

  async catalogs(models: AppModel[]): Promise<string> {
    const d = this.d;
    await Promise.all(
      models.map((m) =>
        this.agent(`ui-scout:${m.app}:catalog`, "ui-scout", `UI Scout · ${m.app} operations`, { model: d.claude.modelFor("helper"), app: m.app }, async () => {
          const r = await buildCatalog(d.claude, m, d.signal);
          m.operations = r.operations;
          d.saveArtifact(`ui-scout:${m.app}:catalog`, "app-model", `${m.app} operation catalog`, `${r.operations.length} operations`, r.operations, { operations: r.operations.length });
        }).catch(() => undefined),
      ),
    );
    return renderCatalog(models);
  }

  /** Workflow Scout: plan with one directive, lower, validate, one repair round on errors, compile. */
  async planCandidate(models: AppModel[], directive: { name: string; text: string }, catalog: string | undefined, index: number): Promise<CompiledCandidate> {
    const d = this.d;
    const candidateId = `cand-${index + 1}-${directive.name}`;
    const agentId = `workflow-scout:${directive.name}`;
    return this.agent(agentId, index === 0 ? "planner" : "workflow-scout", `Workflow Scout · ${directive.name}`, { model: d.claude.modelFor("planner") }, async () => {
      const t0 = d.now();
      const records = d.config.records;
      let plan = (await generatePlan(d.claude, { goal: d.config.goal, records, models, directive, catalog, signal: d.signal })).data;
      d.emit({ type: "candidate.proposed", candidateId, name: plan.strategy.name || directive.name, summary: plan.strategy.summary, agentId });
      let { compiled, issues } = this.compile(plan, models, candidateId);
      let repaired = false;
      if (hasErrors(issues)) {
        repaired = true;
        plan = (await repairPlan(d.claude, { goal: d.config.goal, records, models, directive, catalog, previous: { plan, issues: issues.filter((i) => i.severity === "error") }, signal: d.signal })).data;
        ({ compiled, issues } = this.compile(plan, models, candidateId));
      }
      const valid = !hasErrors(issues) && compiled !== null;
      d.saveArtifact(agentId, "plan", `Plan: ${plan.strategy.name}`, `${plan.phases.length} phase(s), ${plan.phases.reduce((n, p) => n + p.steps.length, 0)} steps; ${valid ? "valid" : `${issues.filter((i) => i.severity === "error").length} error(s)`}${repaired ? " after one repair round" : ""}`, { plan, issues }, { phases: plan.phases.length, steps: plan.phases.reduce((n, p) => n + p.steps.length, 0) });
      return { candidateId, name: plan.strategy.name || directive.name, plan, compiled, issues, valid, estimate: null, workers: 1, planningMs: d.now() - t0, repaired };
    });
  }

  compile(plan: DslPlan, models: AppModel[], candidateId: string): { compiled: CompiledProgram | null; issues: Issue[] } {
    const d = this.d;
    const lowered = lowerPlan({ plan, models, apps: d.config.applications, goal: d.config.goal, inputs: { records: d.config.records }, programId: `${d.runId}:${candidateId}`, strategyId: candidateId });
    const issues = [...lowered.issues, ...validateProgram(lowered.program)];
    if (hasErrors(issues)) return { compiled: null, issues };
    try {
      return { compiled: compileProgram(lowered.program, (n) => d.latency.nodeMs(n)), issues };
    } catch (err) {
      return { compiled: null, issues: [...issues, { severity: "error", code: "compile", message: (err as Error).message }] };
    }
  }

  estimate(c: CompiledCandidate, remainingModelMs = 0): void {
    if (!c.compiled) return;
    const d = this.d;
    const failures = c.dryRun ? c.dryRun.segments.filter((s) => !s.ok).length / Math.max(1, c.dryRun.segments.filter((s) => !s.skipped).length) : 0.02;
    const base = {
      compiled: c.compiled,
      records: d.config.records.length,
      latency: d.latency,
      remainingModelMs,
      modelCostUsd: 0,
      failureRate: { value: Math.max(0.01, failures), source: c.dryRun ? ("measured" as const) : ("default" as const) },
      repairMs: { value: 1500, source: "default" as const },
    };
    const fixed = d.config.concurrency === "fixed";
    const workers = fixed ? (d.config.initialWorkers ?? d.config.maxWorkers) : recommendWorkers(base, d.config.maxWorkers).workers;
    c.workers = workers;
    c.estimate = estimateCost({ ...base, workers }).estimate;
  }
}

/**
 * Stage-gated pipeline (modes B, C, D): discovery -> planning (K competing candidates) ->
 * verification (critique + dry-run probes) -> cost-based selection. Nothing executes until a
 * strategy is selected and compiled.
 */
export async function runStagedSwarm(deps: SwarmDeps): Promise<SwarmResult> {
  const ctx = new SwarmContext(deps);
  const d = deps;
  if (d.imported) {
    const imp = d.imported;
    const features = { phases: imp.plan.phases.length, apps: imp.models.length };
    d.emit({ type: "policy.decision", intelligence: "network-import", candidates: 0, reason: imp.reason, features });
    const { compiled, issues } = ctx.compile(imp.plan, imp.models, "network");
    if (compiled) {
      const c: CompiledCandidate = { candidateId: "network", name: `${imp.plan.strategy.name} (${imp.label})`, plan: imp.plan, compiled, issues, valid: true, estimate: null, workers: 1, planningMs: 0, repaired: false };
      d.emit({ type: "candidate.proposed", candidateId: "network", name: c.name, summary: imp.plan.strategy.summary, agentId: "network" });
      ctx.estimate(c);
      d.emit({ type: "candidate.evaluated", candidateId: "network", estimate: c.estimate, valid: true, issues: [] });
      d.emit({ type: "candidate.selected", candidateId: "network", reason: imp.reason, ranking: [{ candidateId: "network", totalMs: c.estimate?.totalMs ?? null }] });
      const review: PlanReview = { status: "not-required", reason: "imported capability: reviewed by its publisher (publication requires a passed review), admitted by the network validator, rebound here" };
      return { selected: c, candidates: [c], models: imp.models, policy: { intelligence: "network-import", candidates: 0, catalog: false, critique: false, dryRun: false, reason: imp.reason, features }, workers: c.workers, reason: imp.reason, review };
    }
    d.emit({ type: "log", level: "warn", message: `imported plan did not compile here (${issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 2).join("; ")}); discovering cold` });
  }
  const key = cacheKey(d.config);
  let cached = d.config.cache === "warm" ? d.cache?.get(key) : undefined;
  if (cached && cached.review?.status !== "passed" && decidePolicy(d.config, cached.models, strategyDirectives(cached.models).length, false).critique) {
    // A warm start skips the critique, so it may only reuse a plan that passed one when this task's policy requires it.
    d.emit({ type: "log", level: "warn", message: `warm cache: the cached plan has no passed review (${cached.review ? cached.review.reason : "recorded before reviews were tracked"}) and this task requires one; planning cold` });
    cached = undefined;
  }

  let models: AppModel[];
  if (cached) models = cached.models;
  else models = await ctx.stage("discovery", "UI scouts crawling", () => ctx.discoverApps());

  const directives = strategyDirectives(models);
  const policy = decidePolicy(d.config, models, directives.length, !!cached);
  d.emit({ type: "policy.decision", intelligence: policy.intelligence, candidates: policy.candidates, reason: policy.reason, features: policy.features });

  if (cached && policy.intelligence === "warm-cache") {
    const { compiled, issues } = ctx.compile(cached.plan, models, "warm");
    if (compiled) {
      const c: CompiledCandidate = { candidateId: "warm", name: `${cached.plan.strategy.name} (cached)`, plan: cached.plan, compiled, issues, valid: true, estimate: null, workers: 1, planningMs: 0, repaired: false };
      d.emit({ type: "candidate.proposed", candidateId: "warm", name: c.name, summary: cached.plan.strategy.summary, agentId: "cache" });
      ctx.estimate(c);
      d.emit({ type: "candidate.evaluated", candidateId: "warm", estimate: c.estimate, valid: true, issues: [] });
      d.emit({ type: "candidate.selected", candidateId: "warm", reason: "warm start: reused the locally cached compiled program", ranking: [{ candidateId: "warm", totalMs: c.estimate?.totalMs ?? null }] });
      return { selected: c, candidates: [c], models, policy, workers: c.workers, reason: "warm cache", review: cached.review ?? { status: "not-required", reason: "cached before reviews were recorded; this task's policy requires none" } };
    }
  }

  const effects = ctx.classifyEffects(models);
  const catalog = policy.catalog ? await ctx.stage("discovery", "operation catalogs", () => ctx.catalogs(models)) : undefined;
  await effects;

  const chosen = directives.slice(0, Math.max(1, policy.candidates));
  const failed = (i: number, name: string, err: unknown): CompiledCandidate => ({
    candidateId: `cand-${i + 1}-${name}`,
    name,
    plan: { strategy: { name, summary: "planner failed", rationale: "" }, phases: [], outcomes: [], assumptions: [], risks: [] },
    compiled: null,
    issues: [{ severity: "error", code: "planner", message: (err as Error).message }],
    valid: false,
    estimate: null,
    workers: 1,
    planningMs: 0,
    repaired: false,
  });
  const candidates = await ctx.stage("planning", `${chosen.length} candidate(s)`, () => Promise.all(chosen.map((dir, i) => ctx.planCandidate(models, dir, catalog || undefined, i).catch((err) => failed(i, dir.name, err)))));

  // Adversarial verification: critique + read-only dry-run probes, in parallel per candidate. A
  // candidate whose review fails closed (critique unavailable, repair failed, risks remain) is invalid.
  if (policy.critique || policy.dryRun) {
    await ctx.stage("critique", "adversarial verifier", () =>
      ctx.agent("adversarial-verifier", "adversarial-verifier", "Adversarial Verifier", { model: d.claude.modelFor("critic") }, async () => {
        await Promise.all(
          candidates
            .filter((c) => c.valid && c.compiled)
            .map(async (c) => {
              const directive = chosen.find((x) => c.candidateId.endsWith(x.name)) ?? chosen[0]!;
              const assess = async (plan: DslPlan, compiled: CompiledProgram): Promise<Assessment> => {
                const [crit, dry] = await Promise.all([
                  policy.critique ? critiquePlan(d.claude, { goal: d.config.goal, plan, models, issues: c.issues, signal: d.signal }).then((r) => r.result).catch(() => undefined) : Promise.resolve(undefined),
                  policy.dryRun ? dryRunCandidate({ compiled, browser: d.browser, storageState: d.exploreState, apps: d.config.applications, inputs: { records: d.config.records }, latency: d.latency, signal: d.signal }).catch(() => undefined) : Promise.resolve(undefined),
                ]);
                c.critique = crit;
                c.dryRun = dry;
                const high = crit?.risks.filter((r) => r.severity === "high") ?? [];
                d.saveArtifact("adversarial-verifier", "risk-report", `Risks: ${c.name}`, `${crit ? `${crit.risks.length} risk(s), ${high.length} high` : policy.critique ? "critique unavailable" : "no critique"}; dry run ${dry ? (dry.ok ? `passed (${dry.segments.filter((s) => s.ok && !s.skipped).length} segments, ${dry.ms} ms, ${dry.blockedMutations} mutations blocked)` : `failed: ${dry.failures.join("; ").slice(0, 200)}`) : "skipped"}`, { critique: crit, dryRun: dry }, { risks: crit?.risks.length ?? 0, high: high.length });
                return { available: !policy.critique || !!crit, problems: [...(crit ? blockingRisks(crit) : []), ...(dry && !dry.ok ? dry.failures.map((f) => `[dry run] ${f}`) : [])], critique: crit };
              };
              const review = await reviewPlan({
                subject: c.candidateId,
                plan: c.plan,
                compiled: c.compiled!,
                assess,
                repair: async (plan, problems) => {
                  const fixed = (await repairPlan(d.claude, { goal: d.config.goal, records: d.config.records, models, directive, catalog: catalog || undefined, previous: { plan, issues: problems.map((message) => ({ severity: "error", message })) }, signal: d.signal })).data;
                  const r = ctx.compile(fixed, models, c.candidateId);
                  if (!r.compiled) throw new Error(`the repaired plan does not compile: ${r.issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 2).join("; ")}`);
                  c.issues = r.issues;
                  return { plan: fixed, compiled: r.compiled };
                },
                maxRepairs: 1,
                emit: d.emit,
                now: d.now,
              });
              if (!review.ok) {
                c.valid = false;
                c.issues = [...c.issues, { severity: "error", code: "review-rejected", message: review.reason }];
                return;
              }
              c.plan = review.plan;
              c.compiled = review.compiled;
              c.repaired ||= review.repaired;
              c.review = policy.critique ? { status: "passed", rounds: review.rounds } : { status: "not-required", reason: policy.reason };
            }),
        );
      }),
    );
  }

  // Optimization Scout: cost estimates on measured latencies, worker recommendation, selection.
  const result = await ctx.agent("optimization-scout", "optimization-scout", "Optimization Scout", {}, async () => {
    for (const c of candidates) {
      if (c.dryRun && !c.dryRun.ok) c.valid = false;
      ctx.estimate(c);
      d.emit({ type: "candidate.evaluated", candidateId: c.candidateId, estimate: c.estimate, valid: c.valid, issues: [...c.issues.filter((i) => i.severity === "error").map((i) => i.message), ...(c.dryRun && !c.dryRun.ok ? c.dryRun.failures : [])].slice(0, 10) });
    }
    const sel = selectCandidate(candidates.map((c) => ({ id: c.candidateId, name: c.name, estimate: c.estimate, valid: c.valid })));
    d.saveArtifact(
      "optimization-scout",
      "cost-estimates",
      "Strategy cost estimates",
      sel.reason,
      candidates.map((c) => ({ candidateId: c.candidateId, name: c.name, valid: c.valid, workers: c.workers, estimate: c.estimate, latency: d.latency.snapshot() })),
      { candidates: candidates.length },
    );
    return sel;
  });
  const selected = candidates.find((c) => c.candidateId === result.winner?.id);
  if (!selected || !selected.compiled) {
    throw new Error(`No valid strategy: ${candidates.flatMap((c) => c.issues.filter((i) => i.severity === "error").map((i) => i.message)).slice(0, 5).join(" | ") || "planner produced no candidate"}`);
  }
  d.emit({ type: "candidate.selected", candidateId: selected.candidateId, reason: result.reason, ranking: result.ranking });
  const review: PlanReview = selected.review ?? { status: "not-required", reason: policy.reason };
  return { selected, candidates, models, policy, workers: selected.workers, reason: result.reason, review };
}
