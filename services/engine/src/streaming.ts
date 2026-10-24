import { DslStep, normalizeModelOutput, type DslPlan, type EventPayload } from "@overclock/contracts";
import type { StorageState } from "@overclock/browser-runtime";
import { compileProgram, hasErrors, IncrementalCompiler, lowerPlan, validateProgram, type CompiledProgram } from "@overclock/compiler";
import { critiquePlan, generatePlan, PlanStreamWatcher, repairPlan, strategyDirectives } from "@overclock/discovery";
import type { RecoveryEngine } from "@overclock/recovery";
import { ReviewRejectedError, SwarmContext, blockingRisks, cacheKey, reviewPlan, type PlanReview, type SwarmDeps } from "@overclock/swarm";
import { Executor } from "./executor";
import { AccessPathController } from "./accessPaths";
import type { RunController } from "./run";

export interface StreamingArgs {
  run: RunController;
  swarmDeps: SwarmDeps;
  executeState: StorageState | undefined;
  recovery: RecoveryEngine;
  setExecutor(e: Executor): void;
  setProgram(p: unknown): void;
}

function emptyProgram(runId: string, d: SwarmDeps): CompiledProgram {
  return {
    program: { version: "1.0", id: `${runId}:stream`, goal: d.config.goal, strategy: { id: "stream", name: "streaming", summary: "" }, allowedOrigins: d.config.applications.map((a) => new URL(a.origin).origin), apps: d.config.applications, inputs: { records: d.config.records }, nodes: [], expectedOutcomes: [], approvalPolicy: { requireApprovalFor: ["irreversible"], approvedNodes: [] } },
    phases: [],
    segments: new Map(),
    graph: { phases: [], segments: [] },
    passes: [],
    stats: { segments: 0, writeSegments: 0, perRecordCriticalMs: {}, perRecordWorkMs: {}, maxParallelismPerRecord: 1, contendedLocks: [] },
    priority: new Map(),
    compileMs: 0,
  };
}

/**
 * Mode E: streaming discovery, incremental compilation, and execution that starts while the
 * plan is still being written.
 *
 * Gates (never relaxed for speed):
 *  - a read fragment runs only once it is closed and validated (known controls, valid
 *    expressions, read-only effects), first for one record (canary), then for every record;
 *    its pages are read-only at the network layer while it runs;
 *  - a write fragment is deferred until its phase is sealed, the whole plan validates, side
 *    effects are classified, and the critique (when enabled) passed for that exact plan; a
 *    repaired plan is critiqued again, and an unavailable critique rejects the plan (fail-closed);
 *    then one record writes and verifies by read-back before the template fans out;
 *  - phases that depend on other phases (cross-record aggregates) wait for those phases to finish.
 */
export async function runStreamingPipeline(a: StreamingArgs): Promise<void> {
  const { run, swarmDeps: d } = a;
  const ctx = new SwarmContext(d);
  const emit = (e: EventPayload) => d.emit(e);
  const n = d.config.records.length;

  // 1. First-pass discovery: one observation per route pattern, enough to start planning.
  const models = await ctx.stage("discovery", "UI scouts, first pass", () => ctx.discoverApps({ maxPerPattern: 1, maxPages: 12 }));
  const directives = strategyDirectives(models);
  const critique = n > 5 && d.claude.available;
  emit({
    type: "policy.decision",
    intelligence: "parallel-scout",
    candidates: 1,
    reason: `streaming: plan with the "${directives[0]!.name}" strategy immediately and execute validated fragments as they arrive; deeper discovery, side-effect classification${critique ? ", and critique" : ""} continue in parallel; access paths are optimized online from measured latency`,
    features: { records: n, apps: models.length, strategyDirectives: directives.length, critique, streaming: true },
  });

  // 2. Discovery keeps going in the background (second samples, effect classification).
  const deepAbort = new AbortController();
  d.signal.addEventListener("abort", () => deepAbort.abort());
  const effectsP = ctx.classifyEffects(models).catch(() => undefined);
  const deepP = ctx
    .stage("discovery", "UI scouts, second pass", () => new SwarmContext({ ...d, signal: deepAbort.signal }).discoverApps({ maxPerPattern: 2, maxPages: 16, agentSuffix: ":deep" }))
    .then((deep) => {
      // Stability report: controls of the first pass that a second sample of the same page lacks.
      const unstable: string[] = [];
      for (const m of models) {
        const dm = deep.find((x) => x.app === m.app);
        if (!dm) continue;
        for (const id of Object.keys(m.controls)) if (!dm.controls[id] && m.controls[id]!.kind !== "fact") unstable.push(id);
      }
      d.saveArtifact("ui-scout:stability", "app-model", "Locator stability (second pass)", `${unstable.length} control(s) not seen on a second sample of their page`, { unstable }, { unstable: unstable.length });
    })
    .catch(() => undefined);

  // 3. Executor starts empty and grows as fragments are released.
  const compiled = emptyProgram(run.runId, d);
  const fragmentOf = new Map<string, string>();
  let executorRef: Executor | null = null;
  const access = new AccessPathController({ executor: () => executorRef!, models, latency: d.latency, emit, now: () => d.now(), enabled: d.config.ablation.accessPaths !== false && d.config.ablation.onlineReoptimization !== false });
  const executor = new Executor({
    runId: run.runId,
    config: d.config,
    emit,
    now: () => d.now(),
    tracer: run.tracer,
    browser: d.browser,
    storageState: a.executeState,
    apps: d.config.applications,
    compiled,
    latency: d.latency,
    signal: d.signal,
    recovery: a.recovery,
    workers: { initial: Math.min(4, d.config.maxWorkers), max: d.config.maxWorkers, adaptive: d.config.concurrency !== "fixed" },
    thumbnails: d.config.thumbnails,
    onThumbnail: (wid, jpeg) => run.storeThumb(wid, jpeg),
    onCanaryPassed: (segId) => {
      const seg = compiled.segments.get(segId);
      emit({ type: "fragment", fragmentId: fragmentOf.get(segId) ?? segId, phaseId: seg?.phaseId ?? "", segmentIds: [segId], state: "released", label: seg?.label ?? segId, reason: "canary record verified; fanned out to every record", effect: seg?.kind === "write" ? "write" : "read" });
    },
    onTaskFinished: (t) => access.onTaskFinished(t),
    substitute: (t) => access.substitute(t),
    onCanaryFailed: (segId, reason) => {
      const seg = compiled.segments.get(segId);
      emit({ type: "fragment", fragmentId: fragmentOf.get(segId) ?? segId, phaseId: seg?.phaseId ?? "", segmentIds: [segId], state: "rejected", label: seg?.label ?? segId, reason: `canary failed: ${reason.slice(0, 200)}`, effect: seg?.kind === "write" ? "write" : "read" });
    },
  });
  executorRef = executor;
  a.setExecutor(executor);
  const execP = executor.start({ incremental: true });

  // 4. Streaming planner -> incremental compiler -> scheduler.
  const ic = new IncrementalCompiler({ models, apps: d.config.applications, goal: d.config.goal, inputs: { records: d.config.records }, programId: `${run.runId}:stream`, strategyId: `stream-${directives[0]!.name}`, estimate: (x) => d.latency.nodeMs(x) });
  const phaseIds: string[] = [];
  const writes: { phaseId: string; segId: string }[] = [];
  let firstRelease = true;
  run.setStatus("compiling");
  const release = (phaseId: string, rel: ReturnType<IncrementalCompiler["addStep"]>["released"]) => {
    if (!rel.length) return;
    for (const r of rel) {
      const seg = r.segment;
      const fid = `frag-${seg.id}`;
      fragmentOf.set(seg.id, fid);
      emit({ type: "fragment", fragmentId: fid, phaseId, segmentIds: [seg.id], state: "compiled", label: seg.label, effect: r.write ? "write" : "read" });
      emit({ type: "fragment", fragmentId: fid, phaseId, segmentIds: [seg.id], state: "validated", label: seg.label, reason: "controls resolved against observed evidence; expressions and effects checked", effect: r.write ? "write" : "read" });
      if (r.write) {
        writes.push({ phaseId, segId: seg.id });
        emit({ type: "fragment", fragmentId: fid, phaseId, segmentIds: [seg.id], state: "deferred", label: seg.label, reason: "write deferred: waiting for phase seal, whole-plan validation, side-effect classification" + (critique ? ", critique" : ""), effect: "write" });
      } else emit({ type: "fragment", fragmentId: fid, phaseId, segmentIds: [seg.id], state: "canary", label: seg.label, reason: "running for one record before fan-out", effect: "read" });
      executor.scheduler.addSegments(phaseId, [seg], r.write ? "deferred" : "canary");
    }
    access.onReleased(rel.map((r) => r.segment));
    if (firstRelease) {
      firstRelease = false;
      run.setStatus("running");
    }
    // The compiled graph grows while the plan streams; re-publish it so viewers see it grow.
    emit({ type: "program.compiled", programId: compiled.program.id, strategy: "streaming", phases: compiled.phases.map((p) => ({ id: p.id, kind: p.kind, dependsOn: p.dependsOn, segmentIds: [...p.segmentIds] })), segments: [...compiled.segments.values()].map(({ nodes: _n, ...x }) => x), passes: [], nodeCount: [...compiled.segments.values()].reduce((k, x) => k + x.nodes.length, 0), compileMs: Math.round(ic.compileMs) });
    executor.wake();
  };
  const watcher = new PlanStreamWatcher({
    onPhaseHeader: (i, h) => {
      const info = ic.addPhase(h);
      if (!info) return;
      phaseIds[i] = info.id;
      executor.scheduler.addPhase(info);
      emit({ type: "log", level: "info", message: `phase ${info.id} (${info.kind}) registered while the plan streams` });
    },
    onStep: (pi, _si, raw) => {
      const phaseId = phaseIds[pi];
      if (!phaseId) return;
      let step: DslStep;
      try {
        step = normalizeModelOutput(DslStep, raw);
      } catch {
        emit({ type: "log", level: "warn", message: `streamed step in ${phaseId} failed schema validation; it will be checked again when the plan completes` });
        return;
      }
      const r = ic.addStep(phaseId, step);
      for (const i of r.issues.filter((x) => x.severity === "error" && x.stepId === step.id)) emit({ type: "log", level: "warn", message: `step ${step.id} held back: ${i.message}` });
      release(phaseId, r.released);
    },
    onPhaseEnd: (pi) => {
      const phaseId = phaseIds[pi];
      if (!phaseId) return;
      release(phaseId, ic.sealPhase(phaseId).released);
      executor.scheduler.sealPhase(phaseId);
    },
    onError: (err) => emit({ type: "log", level: "warn", message: `streamed step handling failed: ${err.message.slice(0, 200)}` }),
  });

  const directive = directives[0]!;
  let plan: DslPlan;
  let repaired = false;
  try {
    const r = await ctx.stage("planning", "streaming planner", () => ctx.agent(`workflow-scout:${directive.name}`, "planner", `Workflow Scout · ${directive.name} (streaming)`, { model: d.claude.modelFor("planner") }, () => generatePlan(d.claude, { goal: d.config.goal, records: d.config.records, models, directive, signal: d.signal, onText: (delta) => watcher.push(delta) })));
    plan = r.data;
    repaired = r.repaired;
    d.saveArtifact(`workflow-scout:${directive.name}`, "plan", "Raw planner stream", `${watcher.text.length} characters streamed`, { text: watcher.text.slice(0, 200_000) }, { chars: watcher.text.length });
    emit({ type: "candidate.proposed", candidateId: "stream-1", name: plan.strategy.name, summary: plan.strategy.summary, agentId: `workflow-scout:${directive.name}` });
    d.saveArtifact(`workflow-scout:${directive.name}`, "plan", `Plan: ${plan.strategy.name}`, `${plan.phases.length} phase(s), ${plan.phases.reduce((x, p) => x + p.steps.length, 0)} steps, streamed; first text after ${r.firstTextMs ? Math.round(r.firstTextMs) : "?"} ms; ${ic.releasedOrder.length} fragment(s) released during the stream`, { plan }, { phases: plan.phases.length, fragments: ic.releasedOrder.length });
  } catch (err) {
    executor.scheduler.cancelAll(`planner failed: ${(err as Error).message}`);
    executor.scheduler.sealProgram();
    executor.wake();
    await execP;
    throw err;
  }

  // 5. Whole-plan validation. Anything the stream missed (or a repaired plan) can't run as streamed:
  //    it is repaired and runs staged instead.
  const issues = ic.finalize(plan);
  const streamedSteps = new Set(ic.releasedOrder.flatMap((r) => r.segment.nodeIds));
  const allSteps = plan.phases.flatMap((p) => p.steps.map((s) => s.id));
  const missing = allSteps.filter((id) => !streamedSteps.has(id));
  let structural: string | null = null;
  if (repaired) structural = "the planner's first output needed a repair round, so the streamed fragments may not match the final plan";
  else if (hasErrors(issues)) structural = `whole-plan validation failed: ${issues.filter((i) => i.severity === "error").map((i) => i.message).slice(0, 3).join("; ")}`;
  else if (missing.length) structural = `${missing.length} step(s) did not arrive as valid fragments (${missing.slice(0, 5).join(", ")})`;

  type Lowered = ReturnType<typeof lowerPlan>;
  const repairOnce = async (previous: DslPlan, problems: string[], detail: string) => {
    const fixed = await ctx.stage("planning", detail, () => repairPlan(d.claude, { goal: d.config.goal, records: d.config.records, models, directive, previous: { plan: previous, issues: problems.map((message) => ({ severity: "error", message })) }, signal: d.signal }));
    const p = fixed.data;
    emit({ type: "log", level: "info", message: fixed.mode === "patch" ? `${detail}: ${fixed.edits} edit(s) to the streamed plan in ${Math.round(fixed.ms)} ms` : `${detail}: full re-plan in ${Math.round(fixed.ms)} ms${fixed.patchError ? ` (edits were not usable: ${fixed.patchError})` : ""}` });
    d.saveArtifact(`workflow-scout:${directive.name}`, "plan", `Plan: ${p.strategy.name} (${detail}, ${fixed.mode === "patch" ? `${fixed.edits} edits` : "full re-plan"})`, p.strategy.summary, { plan: p }, { phases: p.phases.length, steps: p.phases.reduce((n, x) => n + x.steps.length, 0) });
    const lowered = lowerPlan({ plan: p, models, apps: d.config.applications, goal: d.config.goal, inputs: { records: d.config.records }, programId: `${run.runId}:repaired`, strategyId: "repaired" });
    return { plan: p, lowered, errs: [...lowered.issues, ...validateProgram(lowered.program)].filter((i) => i.severity === "error") };
  };
  /** A repair plus, as on the staged path, one more round on the repaired plan's validation errors only. */
  const fix = async (previous: DslPlan, problems: string[], detail: string): Promise<{ plan: DslPlan; compiled: Lowered | null }> => {
    let fixed = await repairOnce(previous, problems, detail);
    if (fixed.errs.length) fixed = await repairOnce(fixed.plan, fixed.errs.map((e) => e.message), "repair: validation errors in the repaired plan");
    if (fixed.errs.length) throw new Error(`repaired plan invalid: ${fixed.errs.map((e) => e.message).slice(0, 3).join("; ")}`);
    return { plan: fixed.plan, compiled: fixed.lowered };
  };
  // Once the plan is replaced, no streamed write may run: reject them all and stop the streamed program.
  let superseded = false;
  const supersede = async (why: string) => {
    if (superseded) return;
    superseded = true;
    emit({ type: "log", level: "warn", message: `streaming fallback: ${why}` });
    for (const w of writes) emit({ type: "fragment", fragmentId: fragmentOf.get(w.segId) ?? w.segId, phaseId: w.phaseId, segmentIds: [w.segId], state: "rejected", label: compiled.segments.get(w.segId)?.label ?? w.segId, reason: `superseded: ${why.slice(0, 160)}`, effect: "write" });
    executor.scheduler.cancelAll("superseded by the repaired plan");
    executor.scheduler.sealProgram();
    executor.wake();
    await execP;
  };

  // 6. The review gate. Every write of this run, streamed or repaired, waits for a passed review of
  //    the exact plan it belongs to (when the policy requires one). Reads keep running meanwhile.
  //    It fails closed: an unavailable critique, a failed repair, or risks left after the repair
  //    reject the plan and no write runs.
  await effectsP;
  let staged: { plan: DslPlan; compiled: Lowered | null } | null = null;
  if (structural) {
    await supersede(structural);
    staged = await fix(plan, [structural, ...issues.filter((i) => i.severity === "error").map((i) => i.message)], "repair after streaming fallback");
  }
  let review: PlanReview = { status: "not-required", reason: d.claude.available ? `small task (${n} records): no critique by policy` : "no critique: the planner model is unavailable" };
  if (critique) {
    const subject = staged ? "repaired plan" : "streamed plan";
    const outcome = await ctx.stage("critique", `adversarial verifier on the ${subject}`, () =>
      ctx.agent("adversarial-verifier", "adversarial-verifier", "Adversarial Verifier", { model: d.claude.modelFor("critic") }, () =>
        reviewPlan<Lowered | null>({
          subject,
          plan: staged?.plan ?? plan,
          compiled: staged?.compiled ?? null,
          assess: async (p, lowered) => {
            const crit = await critiquePlan(d.claude, { goal: d.config.goal, plan: p, models, issues: lowered ? lowered.issues : issues, signal: d.signal })
              .then((r) => r.result)
              .catch(() => undefined);
            const high = crit?.risks.filter((r) => r.severity === "high") ?? [];
            d.saveArtifact("adversarial-verifier", "risk-report", `Risks: ${p.strategy.name}`, crit ? `${crit.risks.length} risk(s), ${high.length} high` : "critique unavailable", crit ?? null, { risks: crit?.risks.length ?? 0, high: high.length });
            return { available: !!crit, problems: crit ? blockingRisks(crit) : [], critique: crit };
          },
          repair: async (p, problems) => {
            await supersede(`critique found ${problems.length} blocking finding(s): ${problems.slice(0, 2).join("; ")}`);
            return fix(p, problems, "repair after critique");
          },
          maxRepairs: 1,
          emit,
          now: () => d.now(),
        }),
      ),
    );
    if (!outcome.ok) {
      for (const w of writes) emit({ type: "fragment", fragmentId: fragmentOf.get(w.segId) ?? w.segId, phaseId: w.phaseId, segmentIds: [w.segId], state: "rejected", label: compiled.segments.get(w.segId)?.label ?? w.segId, reason: `review rejected: ${outcome.reason.slice(0, 160)}`, effect: "write" });
      executor.scheduler.cancelAll(`review rejected: ${outcome.reason}`);
      executor.scheduler.sealProgram();
      executor.wake();
      await execP;
      deepAbort.abort();
      await deepP;
      emit({ type: "stage", stage: "execution", phase: "end" });
      throw new ReviewRejectedError(outcome.reason);
    }
    review = { status: "passed", rounds: outcome.rounds };
    if (staged || outcome.repaired) staged = { plan: outcome.plan, compiled: outcome.compiled };
  }

  if (staged) {
    // Reads were side-effect free and no streamed write ran. Run the reviewed, repaired plan staged.
    const lowered = staged.compiled ?? lowerPlan({ plan: staged.plan, models, apps: d.config.applications, goal: d.config.goal, inputs: { records: d.config.records }, programId: `${run.runId}:repaired`, strategyId: "repaired" });
    const program = compileProgram(lowered.program, (x) => d.latency.nodeMs(x));
    run.publishProgram(program);
    const second = new Executor({ ...executorOptions(run, d, a, program) });
    a.setExecutor(second);
    await second.start({ incremental: false });
    deepAbort.abort();
    await deepP;
    emit({ type: "stage", stage: "execution", phase: "end" });
    if (d.cache) d.cache.put(cacheKey(d.config), { plan: staged.plan, models, review });
    return;
  }

  // 7. Release the writes: canary first (one record writes and verifies), then fan-out.
  const irreversible = new Set(Object.values(Object.fromEntries(models.flatMap((m) => Object.values(m.controls)).filter((c) => c.effectGuess === "irreversible").map((c) => [c.id, c.id]))));
  for (const w of writes) {
    const seg = compiled.segments.get(w.segId)!;
    for (const node of seg.nodes) if (node.target?.controlId && irreversible.has(node.target.controlId) && !node.requiresApproval) node.requiresApproval = true;
    const gate = d.config.ablation.writeCanary === false ? "open" : "canary";
    executor.scheduler.setGate(w.segId, gate);
    emit({ type: "fragment", fragmentId: fragmentOf.get(w.segId) ?? w.segId, phaseId: w.phaseId, segmentIds: [w.segId], state: gate === "canary" ? "canary" : "released", label: seg.label, reason: gate === "canary" ? "all gates passed; one record writes and verifies before fan-out" : "all gates passed (write canary disabled)", effect: "write" });
  }
  for (const p of plan.phases) if (!executor.scheduler.isSealed(p.id)) executor.scheduler.sealPhase(p.id);
  executor.scheduler.sealProgram();
  executor.wake();
  run.publishProgram(finalProgramView(compiled, plan, ic));
  await execP;
  deepAbort.abort();
  await deepP;
  emit({ type: "stage", stage: "execution", phase: "end" });
  if (d.cache) d.cache.put(cacheKey(d.config), { plan, models, review });
}

function executorOptions(run: RunController, d: SwarmDeps, a: StreamingArgs, compiled: CompiledProgram): ConstructorParameters<typeof Executor>[0] {
  return {
    runId: run.runId,
    config: d.config,
    emit: (e) => d.emit(e),
    now: () => d.now(),
    tracer: run.tracer,
    browser: d.browser,
    storageState: a.executeState,
    apps: d.config.applications,
    compiled,
    latency: d.latency,
    signal: d.signal,
    recovery: a.recovery,
    workers: { initial: Math.min(4, d.config.maxWorkers), max: d.config.maxWorkers, adaptive: d.config.concurrency !== "fixed" },
    thumbnails: d.config.thumbnails,
    onThumbnail: (wid, jpeg) => run.storeThumb(wid, jpeg),
  };
}

/** Program view for the dashboard after streaming: the segments actually released, in order. */
function finalProgramView(compiled: CompiledProgram, plan: DslPlan, ic: IncrementalCompiler): CompiledProgram {
  compiled.program.strategy = { id: "stream", name: plan.strategy.name, summary: plan.strategy.summary };
  compiled.graph = { phases: compiled.phases.map((p) => ({ id: p.id, kind: p.kind, dependsOn: p.dependsOn, segmentIds: p.segmentIds })), segments: [...compiled.segments.values()].map(({ nodes: _n, ...s }) => s) };
  compiled.passes = [{ name: "incremental-compilation", ms: Math.round(ic.compileMs * 100) / 100, changes: ic.releasedOrder.length, detail: `${ic.releasedOrder.length} fragment(s) released while the plan streamed (${ic.releasedOrder.filter((r) => r.write).length} write)` }];
  compiled.stats.segments = compiled.segments.size;
  compiled.stats.writeSegments = [...compiled.segments.values()].filter((s) => s.kind === "write").length;
  return compiled;
}
