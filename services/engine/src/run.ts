import { randomUUID } from "node:crypto";
import type { ArtifactSummary, EventPayload, RecordOutcome, RunConfig, RunEvent, RunResultResponse, RunStatus, RunSummary, RunView } from "@overclock/contracts";
import { applyEvent, countInputRecordsVerified, createRunView, deriveMetrics, RunSummary as RunSummarySchema } from "@overclock/contracts";
import { ClaudeProvider, JevProvider, ModelLedger } from "@overclock/models";
import { LatencyModel } from "@overclock/optimizer";
import { RecoveryEngine } from "@overclock/recovery";
import { runStagedSwarm, cacheKey, type SwarmResult } from "@overclock/swarm";
import { EventBus, Tracer } from "@overclock/telemetry";
import { runSequentialAgent } from "@overclock/benchmarks/baselines";
import { Executor } from "./executor";
import type { EngineRuntime } from "./runtime";
import type { EngineStore } from "./store";
import type { RunHandle } from "./types";
import { runStreamingPipeline } from "./streaming";
import { importCapability, publishCapability, type ImportedCapability } from "./network";
import { decidePublication, stateChecker } from "./publication";

const VERIFICATION_SEMANTICS =
  "VERIFIED means every state-changing step for that record was read back from the application after a fresh navigation and matched the expected values (or the record needed no change). UNCONFIRMED means a write may or may not have committed and could not be confirmed. Sequential-agent runs never report VERIFIED: their completions are model claims.";

/** Network block of the run summary, from the run's own network events (absent when none happened). */
function networkSummary(v: RunView): RunSummary["network"] {
  const n = v.network;
  if (!n.lookups.length && !n.publishes.length && !n.repairs.length) return undefined;
  const imp = n.imports.at(-1);
  const look = n.lookups.at(-1);
  return {
    lookups: n.lookups.length,
    hits: n.lookups.filter((l) => l.candidates > 0).length,
    outcome: imp?.outcome ?? look?.outcome,
    capabilityId: imp?.capabilityId ?? look?.capabilityId,
    version: imp?.version ?? look?.version,
    lookupMs: Math.round(n.lookups.reduce((a, l) => a + l.ms, 0)),
    fetchMs: Math.round(n.imports.reduce((a, i) => a + i.fetchMs, 0)),
    rebindMs: Math.round(n.imports.reduce((a, i) => a + i.rebindMs, 0)),
    published: n.publishes.some((p) => !p.rejected),
    repairs: n.repairs.length,
  };
}

export function knowledgePolicy(config: RunConfig): string {
  return config.knowledge ?? (config.cache === "warm" ? "local-only" : "strict-cold");
}

/**
 * One run: owns its event stream (persisted before broadcast), model ledger, latency model,
 * recovery engine, and executor. Implements the RunHandle contract served over HTTP/SSE.
 */
export class RunController implements RunHandle {
  readonly runId: string;
  readonly createdAt = Date.now();
  readonly bus: EventBus;
  readonly tracer = new Tracer();
  readonly ledger: ModelLedger;
  readonly latency = new LatencyModel();
  private readonly viewState: RunView;
  private readonly artifacts = new Map<string, unknown>();
  private readonly thumbs = new Map<string, Buffer>();
  private readonly abort = new AbortController();
  private executor: Executor | null = null;
  private programSummary: unknown;
  private outcomesList: RecordOutcome[] = [];
  private summary: RunSummary | null = null;
  private done = false;
  private artifactSeq = 0;
  /** App-model controls seen by this run (for recovery's structural matching). */
  readonly controlIndex = new Map<string, import("@overclock/contracts").AppControl>();
  readonly claude: ClaudeProvider;
  readonly jev: JevProvider;
  private recoveryStats?: () => unknown;
  /** Plan and models the run executed (staged, streamed, or imported), for publication. */
  private finalPlan: import("@overclock/swarm").CachedProgram | null = null;

  constructor(
    readonly config: RunConfig,
    private readonly runtime: EngineRuntime,
    private readonly store: EngineStore | null,
  ) {
    this.runId = `run_${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}_${randomUUID().slice(0, 6)}`;
    this.viewState = createRunView(this.runId);
    this.bus = new EventBus(this.runId, (e) => this.store?.appendEvent(e));
    this.bus.subscribe((e) => applyEvent(this.viewState, e));
    const budget = config.budgetUsd;
    this.ledger = new ModelLedger(budget, runtime.ledger);
    this.ledger.onCall((c) => this.emit({ type: "model.call", provider: c.provider, model: c.model, purpose: c.purpose, ms: Math.round(c.ms), inputTokens: c.inputTokens, outputTokens: c.outputTokens, costUsd: c.costUsd, ok: c.ok, error: c.error, ...(c.speed ? { speed: c.speed } : {}), ...(c.ttftMs != null ? { ttftMs: Math.round(c.ttftMs) } : {}) }));
    this.claude = new ClaudeProvider(runtime.claudeConfig, this.ledger);
    this.jev = new JevProvider(runtime.jevConfig, this.ledger);
    this.jev.enabled = config.useJev;
    store?.createRun(this.runId, config, this.createdAt);
  }

  emit(e: EventPayload): RunEvent {
    return this.bus.emit(e);
  }

  now(): number {
    return this.bus.now();
  }

  saveArtifact(agentId: string, kind: ArtifactSummary["kind"], title: string, summary: string, data: unknown, stats?: Record<string, number | string>): string {
    const artifactId = `a${++this.artifactSeq}-${kind}`;
    if (kind === "app-model" && data && typeof data === "object" && "controls" in data) {
      for (const [id, c] of Object.entries((data as { controls: Record<string, import("@overclock/contracts").AppControl> }).controls)) this.controlIndex.set(id, c);
    }
    this.artifacts.set(artifactId, data);
    this.store?.saveArtifact(this.runId, artifactId, kind, title, data);
    this.emit({ type: "agent.artifact", agentId, artifact: { artifactId, kind, title, summary, stats } });
    return artifactId;
  }

  /* ---------------------------------------------------------------------------- lifecycle */

  start(): void {
    void this.execute().catch((err) => {
      this.emit({ type: "log", level: "error", message: `run failed: ${(err as Error).message}` });
      this.finish("failed", (err as Error).message);
    });
  }

  setStatus(s: RunStatus, reason?: string): void {
    this.emit({ type: "run.status", status: s, reason });
  }

  private async execute(): Promise<void> {
    this.emit({ type: "run.created", config: this.config });
    this.setStatus("discovering");
    const mode = this.config.mode;
    const apps = this.config.applications;
    if (mode === "sequential-agent") {
      this.setStatus("running");
      this.emit({ type: "stage", stage: "execution", phase: "start" });
      const r = await runSequentialAgent({
        config: this.config,
        browser: this.runtime.browser,
        sessions: this.runtime.executeSessions,
        claude: this.claude,
        bus: this.bus,
        signal: this.abort.signal,
        thumbnails: this.config.thumbnails ? (wid, jpeg) => this.storeThumb(wid, jpeg) : undefined,
      });
      this.emit({ type: "stage", stage: "execution", phase: "end" });
      this.outcomesList = r.outcomes;
      this.finish(this.abort.signal.aborted ? "cancelled" : "completed");
      return;
    }

    // Both sessions log in at once (sessions are memoized, so a viewer fallback shares the operator
    // login). Only discovery needs the explorer session, so a network import doesn't wait for it.
    const exploring = this.runtime.exploreState(apps);
    exploring.catch(() => undefined); // awaited below; this only keeps an early failure from being unhandled
    const executeState = await this.runtime.executeSessions.storageStateFor(apps);
    const knowledge = knowledgePolicy(this.config);
    const imported = knowledge.startsWith("network") ? await this.importFromNetwork(executeState) : null;
    const explore = await exploring;
    if (explore.role === "operator") this.emit({ type: "log", level: "warn", message: "no read-only explorer role available; exploring with the operator session (all mutations still blocked)" });
    // Every run stores its final plan, so a later warm run can reuse it. Only local-only and
    // network policies read the cache; a strict-cold run never does.
    const localCache = knowledge === "local-only" || knowledge.startsWith("network") ? this.runtime.cache : undefined;
    const cache = {
      get: (key: string) => localCache?.get(key),
      put: (key: string, value: import("@overclock/swarm").CachedProgram) => {
        this.finalPlan = value;
        const recordFields = [...new Set(this.config.records.flatMap((r) => Object.keys(r)))].sort();
        const applications = this.config.applications.map((a) => ({ name: a.name, origin: new URL(a.origin).origin }));
        const source = imported ? { kind: "network" as const, versionId: imported.versionId } : { kind: "local" as const };
        this.runtime.cache.put(key, { ...value, learned: { goal: this.config.goal, recordFields, applications, records: this.config.records.length, at: Date.now(), source } });
      },
    };
    const swarmDeps = {
      runId: this.runId,
      config: this.config,
      emit: (e: EventPayload) => this.emit(e),
      now: () => this.now(),
      browser: this.runtime.browser,
      exploreState: explore.state,
      claude: this.claude,
      jev: this.jev,
      latency: this.latency,
      signal: this.abort.signal,
      saveArtifact: (agentId: string, kind: ArtifactSummary["kind"], title: string, summary: string, data: unknown, stats?: Record<string, number | string>) => void this.saveArtifact(agentId, kind, title, summary, data, stats),
      cache,
      imported: imported ? { plan: imported.plan, models: imported.models, label: `network v${imported.version}`, reason: `imported ${imported.versionId} (${imported.outcome}) from the Overclock Network and rebound to this runtime's own observation; no planner call` } : undefined,
    };
    const recovery = new RecoveryEngine({
      jev: this.jev.usable ? this.jev : undefined,
      claude: this.claude.available ? this.claude : undefined,
      emit: (e) => this.emit(e),
      lookupControl: (id) => this.controlIndex.get(id),
      onRepairStart: (seg) => this.executor?.scheduler.suspendSegment(seg, "model-assisted repair in progress"),
      onRepairEnd: (seg) => {
        this.executor?.scheduler.resumeSegment(seg);
        this.executor?.wake();
      },
    });

    this.recoveryStats = () => recovery.stats();
    // Streaming only helps when a plan must be written; an imported or warm-cached plan runs staged.
    const warmHit = this.config.cache === "warm" && !!localCache?.get(cacheKey(this.config));
    if (mode === "overclock" && this.config.ablation.streaming !== false && !imported && !warmHit) {
      await runStreamingPipeline({ run: this, swarmDeps, executeState, recovery, setExecutor: (e) => (this.executor = e), setProgram: (p) => (this.programSummary = p) });
    } else {
      const swarm: SwarmResult = await runStagedSwarm(swarmDeps);
      const compiled = swarm.selected.compiled!;
      this.setStatus("compiling");
      this.publishProgram(compiled);
      this.setStatus("running");
      const fixed = this.config.concurrency === "fixed";
      const workers = mode === "compiled-single" ? 1 : fixed ? (this.config.initialWorkers ?? this.config.maxWorkers) : Math.max(1, swarm.workers);
      this.executor = new Executor({
        runId: this.runId,
        config: this.config,
        emit: (e) => this.emit(e),
        now: () => this.now(),
        tracer: this.tracer,
        browser: this.runtime.browser,
        storageState: executeState,
        apps,
        compiled,
        latency: this.latency,
        signal: this.abort.signal,
        recovery,
        workers: { initial: workers, max: mode === "compiled-single" ? 1 : fixed ? workers : this.config.maxWorkers, adaptive: !fixed && mode !== "compiled-single" },
        thumbnails: this.config.thumbnails,
        onThumbnail: (wid, jpeg) => this.storeThumb(wid, jpeg),
        onCanaryPassed: (segId) => this.emit({ type: "log", level: "info", message: `write canary passed for ${segId}: one record wrote and verified by fresh read-back; the other records may write` }),
        onCanaryFailed: (segId, reason) => this.emit({ type: "log", level: "error", message: `write canary failed for ${segId}; its writes stay blocked: ${reason.slice(0, 200)}` }),
      });
      if (imported?.writeCanary && swarm.policy.intelligence === "network-import") {
        // A submit button bound structurally (its label changed): no record writes until one has
        // written and verified through it.
        const writes = [...compiled.segments.values()].filter((seg) => seg.kind === "write");
        for (const seg of writes) this.executor.scheduler.setGate(seg.id, "canary");
        this.emit({ type: "log", level: "info", message: `write canary on ${writes.length} write segment(s) of the imported capability: a rebound submit button changed its label` });
      }
      await this.executor.start({ incremental: false });
      this.emit({ type: "stage", stage: "execution", phase: "end" });
      if (!this.abort.signal.aborted) cache.put(cacheKey(this.config), { plan: swarm.selected.plan, models: swarm.models, review: swarm.review });
    }
    this.outcomesList = this.executor?.outcomes() ?? [];
    if (knowledge.startsWith("network") && !this.abort.signal.aborted) await this.contributeToNetwork(knowledge, imported, executeState);
    this.finish(this.abort.signal.aborted ? "cancelled" : "completed");
  }

  /** network-read: look up, fetch, and rebind a shared capability before any discovery. */
  private async importFromNetwork(executeState: import("@overclock/browser-runtime").StorageState | undefined): Promise<ImportedCapability | null> {
    const origins = this.config.applications.map((a) => new URL(a.origin).origin);
    const client = await this.runtime.network.client();
    if (!client) {
      const why = this.runtime.network.enabled ? (this.runtime.network.error ?? "not connected") : "disabled for this engine (OVERCLOCK_NETWORK_ENABLED=false)";
      this.emit({ type: "network.lookup", origins, outcome: "NETWORK_UNAVAILABLE", source: "none", candidates: 0, ms: 0 });
      this.emit({ type: "log", level: "warn", message: `network unavailable: ${why}; discovering cold` });
      return null;
    }
    this.emit({ type: "stage", stage: "discovery", phase: "start", detail: "network lookup and rebinding" });
    this.emit({ type: "agent.started", agentId: "network", role: "ui-scout", label: "Network import · rebinding" });
    const t0 = this.now();
    try {
      const imp = await importCapability({ client, config: this.config, browser: this.runtime.browser, storageState: executeState, signal: this.abort.signal, emit: (e) => this.emit(e) });
      // Rebinding observed these pages itself; register their controls for recovery's structural matching.
      if (imp) for (const m of imp.models) this.saveArtifact("network", "app-model", `${m.app} app model (rebinding)`, `${m.pages.length} pages observed while rebinding ${imp.versionId}`, m);
      this.emit({ type: "agent.finished", agentId: "network", ok: true, ms: Math.round(this.now() - t0) });
      return imp;
    } catch (err) {
      this.emit({ type: "agent.finished", agentId: "network", ok: false, ms: Math.round(this.now() - t0), error: (err as Error).message });
      this.emit({ type: "log", level: "warn", message: `network import failed: ${(err as Error).message}; discovering cold` });
      return null;
    } finally {
      this.emit({ type: "stage", stage: "discovery", phase: "end" });
    }
  }

  /**
   * After execution: report reuse of an imported capability, or publish a newly verified one. Both
   * need every record verified and evidence for every skipped write (see publication.ts).
   */
  private async contributeToNetwork(knowledge: string, imported: ImportedCapability | null, executeState: import("@overclock/browser-runtime").StorageState | undefined): Promise<void> {
    const client = await this.runtime.network.client();
    if (!client) return;
    if (!imported && knowledge !== "network-read-and-contribute") return;
    const states = stateChecker(this.runtime.browser, this.config.applications.map((a) => new URL(a.origin).origin), executeState);
    const decision = await decidePublication({ outcomes: this.outcomesList, executor: this.executor, checkState: states.check }).finally(() => states.close());
    const counts = { applied: decision.skips.filter((x) => x.evidence === "rule-applied").length, state: decision.skips.filter((x) => x.evidence === "state-verified").length, unproven: decision.skips.filter((x) => !x.evidence).length };
    if (decision.skips.length) this.emit({ type: "log", level: counts.unproven ? "warn" : "info", message: `network: ${decision.skips.length} skipped write(s): ${counts.applied} with the rule applied elsewhere in this run, ${counts.state} with the end state verified by a fresh read, ${counts.unproven} unproven` });
    if (imported) {
      await client.reportReuse(imported.versionId, decision.allowed).catch((err: unknown) => this.emit({ type: "log", level: "warn", message: `network: reuse report failed: ${(err as Error).message}` }));
      return;
    }
    if (!decision.allowed || !this.finalPlan) {
      this.emit({ type: "log", level: "info", message: `network: not publishing; ${decision.allowed ? "no final plan" : decision.reasons.join("; ")}` });
      return;
    }
    if (this.finalPlan.review?.status !== "passed") {
      // Importers run a capability without their own critique, so only reviewed plans enter the network.
      this.emit({ type: "log", level: "info", message: `network: not publishing; the plan did not pass an adversarial review (${this.finalPlan.review ? this.finalPlan.review.reason : "no review recorded"})` });
      return;
    }
    await publishCapability({ client, config: this.config, plan: this.finalPlan.plan, models: this.finalPlan.models, verifiedReceipts: this.viewState.receipts.VERIFIED, emit: (e) => this.emit(e) });
  }

  publishProgram(compiled: import("@overclock/compiler").CompiledProgram): void {
    const summary = { programId: compiled.program.id, strategy: compiled.program.strategy, graph: compiled.graph, passes: compiled.passes, stats: compiled.stats, ir: compiled.program };
    this.programSummary = summary;
    this.store?.saveProgram(this.runId, compiled.program.id, compiled.program.strategy.name, summary);
    this.emit({ type: "program.compiled", programId: compiled.program.id, strategy: compiled.program.strategy.name, phases: compiled.graph.phases, segments: compiled.graph.segments, passes: compiled.passes, nodeCount: compiled.program.nodes.reduce((n, x) => n + 1 + (x.body?.length ?? 0), 0), compileMs: Math.round(compiled.compileMs) });
  }

  storeThumb(workerId: string, jpeg: Buffer): void {
    this.thumbs.set(workerId, jpeg);
  }

  private finish(status: RunStatus, reason?: string): void {
    if (this.done) return;
    this.done = true;
    const v = this.viewState;
    const m = deriveMetrics(v);
    const totals = this.ledger.totals();
    const stageMs: Record<string, number> = {};
    for (const s of v.stages) stageMs[s.stage] = (stageMs[s.stage] ?? 0) + ((s.end ?? v.lastT) - s.start);
    const execStart = v.stages.find((s) => s.stage === "execution")?.start ?? v.lastT;
    const thinkingStages = v.stages.filter((s) => s.stage === "discovery" || s.stage === "planning" || s.stage === "compilation" || s.stage === "critique" || s.stage === "probe");
    const discoveryMs = v.stages.filter((s) => s.stage === "discovery").reduce((a, s) => a + ((s.end ?? v.lastT) - s.start), 0);
    const compileMs = thinkingStages.filter((s) => s.stage !== "discovery").reduce((a, s) => a + ((s.end ?? v.lastT) - s.start), 0);
    const recoveryMs = v.recoveries.reduce((a, r) => a + (r.ms ?? 0), 0);
    const outcomes = this.outcomesList;
    const summary = RunSummarySchema.parse({
      runId: this.runId,
      mode: this.config.mode,
      status,
      wallMs: Math.round(this.now()),
      discoveryMs: Math.round(discoveryMs),
      compileMs: Math.round(compileMs),
      executionMs: Math.round(this.now() - execStart),
      records: this.config.records.length,
      tasks: Object.keys(v.tasks).length,
      verified: v.receipts.VERIFIED,
      failed: outcomes.filter((o) => o.status === "FAILED").length,
      unconfirmed: outcomes.filter((o) => o.status === "UNCONFIRMED").length,
      skipped: outcomes.filter((o) => o.status === "SKIPPED").length,
      needsApproval: outcomes.filter((o) => o.status === "NEEDS_APPROVAL").length,
      recordsVerified: countInputRecordsVerified(outcomes),
      recordsAccounting: "input-records",
      recoveries: v.recoveries.filter((r) => r.phase === "succeeded").length,
      modelCalls: totals.calls,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      modelCostUsd: Math.round(totals.costUsd * 1e6) / 1e6,
      workerUtilization: Math.round((this.executor?.utilization() ?? m.utilization) * 1000) / 1000,
      maxConcurrency: this.executor?.maxActive ?? 1,
      strategy: v.program?.strategy,
      firstActionMs: m.firstActionMs,
      firstVerifiedMs: m.firstVerifiedMs,
      overlapMs: m.overlapMs,
      recoveryMs: Math.round(recoveryMs),
      stageMs: Object.fromEntries(Object.entries(stageMs).map(([k, x]) => [k, Math.round(x)])),
      knowledge: knowledgePolicy(this.config),
      network: networkSummary(v),
    });
    this.summary = summary;
    if (reason) this.emit({ type: "log", level: status === "failed" ? "error" : "info", message: reason });
    this.emit({ type: "run.completed", summary });
    this.store?.saveSpans(this.runId, this.tracer.toOtlpJson());
    this.store?.saveMetrics(this.runId, "spans", this.tracer.summary());
    this.store?.saveMetrics(this.runId, "latency", this.latency.snapshot());
  }

  /* ------------------------------------------------------------------------ RunHandle */

  status(): RunStatus {
    return this.viewState.status;
  }

  view(): RunView {
    return this.viewState;
  }
  events(after: number, limit = 1000): RunEvent[] {
    return this.bus.events.filter((e) => e.seq > after).slice(0, limit);
  }
  subscribe(listener: (e: RunEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }
  finished(): boolean {
    return this.done;
  }
  result(): RunResultResponse {
    return { runId: this.runId, status: this.viewState.status, summary: this.summary, outcomes: this.outcomesList.length ? this.outcomesList : (this.executor?.outcomes() ?? []), verificationSemantics: VERIFICATION_SEMANTICS };
  }
  metrics(): unknown {
    return { summary: this.summary, derived: deriveMetrics(this.viewState), spans: this.tracer.summary(), latency: this.latency.snapshot(), ledger: this.ledger.totals(), recovery: this.recoveryStats?.() };
  }
  trace(): unknown {
    return this.tracer.toOtlpJson();
  }
  artifact(artifactId: string): unknown | undefined {
    return this.artifacts.get(artifactId) ?? this.store?.getArtifact(this.runId, artifactId);
  }
  thumbnail(workerId: string): Buffer | undefined {
    return this.thumbs.get(workerId);
  }
  program(): unknown | undefined {
    return this.programSummary;
  }
  cancel(reason = "cancelled by user"): void {
    if (this.done) return;
    this.abort.abort(reason);
    this.executor?.wake();
  }
  pause(): void {
    this.executor?.pause();
    if (!this.done) this.setStatus("paused");
  }
  resume(): void {
    this.executor?.resume();
    if (!this.done) this.setStatus("running");
  }
  approve(approvalId: string, approved: boolean): boolean {
    const a = this.viewState.approvals[approvalId];
    if (!a || a.resolved) return false;
    this.emit({ type: "approval.resolved", approvalId, approved });
    this.executor?.approve(a.taskId, approved);
    return true;
  }
}
