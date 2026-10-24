import type { ActionNode, AppBinding, AppModel, DslPhase, DslPlan, DslStep } from "@overclock/contracts";
import { dependencyAnalysis, verificationPlacement } from "./passes";
import { formSegments, PURE_TYPES, type CompiledSegment, type PhaseInfo } from "./segments";
import { lowerPlan, type Issue } from "./lower";
import { validateProgram } from "./validate";
import type { NodeEstimator } from "./compile";

export interface IncrementalOptions {
  models: AppModel[];
  apps: AppBinding[];
  goal: string;
  inputs: Record<string, unknown>;
  programId: string;
  strategyId: string;
  estimate: NodeEstimator;
}

export interface ReleasedFragment {
  phaseId: string;
  segment: CompiledSegment;
  /** Only navigation, extraction, and computation: safe to run before the plan is complete. */
  pure: boolean;
  write: boolean;
}

const isWrite = (n: ActionNode) => n.effect === "remote-write" || n.effect === "irreversible";

interface PhaseState {
  header: DslPhase;
  info: PhaseInfo;
  frozen: CompiledSegment[];
  nodeSeg: Map<string, string>;
  counter: number;
  sealed: boolean;
}

/**
 * Incremental compiler for streamed plans. Steps arrive one at a time; after each step the phase is
 * re-lowered and re-segmented, and every segment that is complete, valid, and safe to run is
 * released with a stable id. Released segments are immutable: a later step that continues a page a
 * released read segment loaded gets its own re-navigation, so earlier fragments never change.
 */
export class IncrementalCompiler {
  readonly plan: DslPlan = { strategy: { name: "streaming", summary: "plan arriving incrementally", rationale: "" }, phases: [], outcomes: [{ id: "streaming", description: "plan streaming" }], assumptions: [], risks: [] };
  private readonly phases = new Map<string, PhaseState>();
  readonly releasedOrder: ReleasedFragment[] = [];
  compileMs = 0;

  constructor(private readonly o: IncrementalOptions) {}

  /**
   * Register a phase from its streamed header. Returns the PhaseInfo for the scheduler, which owns
   * `segmentIds` from then on (released segments are added through scheduler.addSegments).
   */
  addPhase(raw: Record<string, unknown>): PhaseInfo | null {
    const id = String(raw.id ?? "");
    if (!id || this.phases.has(id)) return null;
    const header: DslPhase = {
      id,
      kind: raw.kind === "foreach" ? "foreach" : "once",
      over: typeof raw.over === "string" && raw.over ? raw.over : undefined,
      key: typeof raw.key === "string" && raw.key ? raw.key : undefined,
      maxIterations: typeof raw.maxIterations === "number" ? raw.maxIterations : undefined,
      dependsOn: Array.isArray(raw.dependsOn) ? (raw.dependsOn as unknown[]).map(String) : [],
      steps: [],
    };
    this.plan.phases.push(header);
    const records = Array.isArray(this.o.inputs.records) ? this.o.inputs.records.length : 0;
    const info: PhaseInfo = { id, kind: header.kind, dependsOn: header.dependsOn, segmentIds: [], over: header.over, key: header.key, maxIterations: header.kind === "foreach" ? Math.min(header.maxIterations ?? Math.max(records, 1) * 4, 5000) : undefined };
    this.phases.set(id, { header, info, frozen: [], nodeSeg: new Map(), counter: 0, sealed: false });
    return info;
  }

  addStep(phaseId: string, step: DslStep): { released: ReleasedFragment[]; issues: Issue[] } {
    const ps = this.phases.get(phaseId);
    if (!ps) return { released: [], issues: [{ severity: "error", code: "unknown-phase", message: `step ${step.id} for unknown phase ${phaseId}` }] };
    ps.header.steps.push(step);
    return this.compilePhase(ps);
  }

  sealPhase(phaseId: string): { released: ReleasedFragment[]; issues: Issue[] } {
    const ps = this.phases.get(phaseId);
    if (!ps) return { released: [], issues: [] };
    ps.sealed = true;
    return this.compilePhase(ps);
  }

  /** Whole-plan validation once the stream is complete (the same checks the staged path runs). */
  finalize(full: DslPlan): Issue[] {
    this.plan.strategy = full.strategy;
    this.plan.outcomes = full.outcomes.length ? full.outcomes : this.plan.outcomes;
    this.plan.assumptions = full.assumptions;
    this.plan.risks = full.risks;
    const lowered = lowerPlan({ plan: full, models: this.o.models, apps: this.o.apps, goal: this.o.goal, inputs: this.o.inputs, programId: this.o.programId, strategyId: this.o.strategyId });
    return [...lowered.issues, ...validateProgram(lowered.program)];
  }

  isFrozen(phaseId: string, nodeId: string): boolean {
    return this.phases.get(phaseId)?.nodeSeg.has(nodeId) ?? false;
  }

  private compilePhase(ps: PhaseState): { released: ReleasedFragment[]; issues: Issue[] } {
    const t0 = performance.now();
    const lowered = lowerPlan({ plan: this.plan, models: this.o.models, apps: this.o.apps, goal: this.o.goal, inputs: this.o.inputs, programId: this.o.programId, strategyId: this.o.strategyId });
    const stepIds = new Set(ps.header.steps.map((s) => s.id));
    const issues = lowered.issues.filter((i) => (i.stepId && stepIds.has(i.stepId)) || i.phaseId === ps.header.id);
    let nodes: ActionNode[];
    if (ps.header.kind === "foreach") nodes = lowered.program.nodes.find((n) => n.id === ps.header.id)?.body ?? [];
    else nodes = lowered.program.nodes.filter((n) => stepIds.has(n.id)).map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => stepIds.has(d)) }));
    const badSteps = new Set(issues.filter((i) => i.severity === "error" && i.stepId).map((i) => i.stepId!));

    // Nodes not yet released; insert re-navigation where a page chain continues past a frozen segment.
    const order = new Map(nodes.map((n, i) => [n.id, i]));
    const pending: ActionNode[] = [];
    for (const n of nodes) {
      if (ps.nodeSeg.has(n.id)) continue;
      const copy: ActionNode = { ...n, dependsOn: [...n.dependsOn] };
      if (n.app && n.type !== "navigate") {
        const sameApp = n.dependsOn.filter((d) => nodes.find((x) => x.id === d)?.app === n.app).sort((a, b) => order.get(b)! - order.get(a)!);
        const pageDep = sameApp[0];
        if (pageDep && ps.nodeSeg.has(pageDep)) {
          const seg = ps.frozen.find((s) => s.id === ps.nodeSeg.get(pageDep))!;
          const nav = seg.nodes.find((x) => x.type === "navigate");
          const pure = seg.nodes.every((x) => PURE_TYPES.has(x.type));
          if (nav && pure) {
            const renavId = `${n.id}__renav`;
            if (!pending.some((p) => p.id === renavId)) pending.push({ ...nav, id: renavId, dependsOn: [...nav.dependsOn], description: `re-open page for ${n.id} (earlier read fragment already ran)` });
            copy.dependsOn = copy.dependsOn.map((d) => (d === pageDep ? renavId : d));
            if (!copy.dependsOn.includes(renavId)) copy.dependsOn.push(renavId);
          } else {
            issues.push({ severity: "error", code: "stream-continuation", message: `step ${n.id} continues a page whose fragment already ran and cannot be re-opened`, stepId: n.id });
            badSteps.add(n.id);
          }
        }
      }
      pending.push(copy);
    }
    if (pending.length === 0) {
      this.compileMs += performance.now() - t0;
      return { released: [], issues };
    }
    // Safe passes only: ordering edges and verification placement (no elimination across released work).
    const ids = new Set(pending.map((n) => n.id));
    const scoped = pending.map((n) => ({ ...n, dependsOn: n.dependsOn.filter((d) => ids.has(d) || ps.nodeSeg.has(d)) }));
    const analyzed = verificationPlacement(dependencyAnalysis(scoped).nodes).nodes;
    let segs: CompiledSegment[];
    try {
      segs = formSegments(`${ps.header.id}.tmp`, analyzed, this.o.estimate, ps.nodeSeg);
    } catch (err) {
      issues.push({ severity: "error", code: "segments", message: (err as Error).message });
      this.compileMs += performance.now() - t0;
      return { released: [], issues };
    }
    const lastStepIndex = ps.header.steps.length - 1;
    const stepIndex = new Map(ps.header.steps.map((s, i) => [s.id, i]));
    const released: ReleasedFragment[] = [];
    const tmpToStable = new Map<string, string>();
    for (const s of segs) {
      const stepNodes = s.nodes.map((n) => n.id.replace(/__renav$/, ""));
      if (stepNodes.some((id) => badSteps.has(id))) continue;
      const deps = s.dependsOn.map((d) => (d.startsWith(`${ps.header.id}.tmp.`) ? tmpToStable.get(d) : d));
      if (deps.some((d) => d === undefined)) continue; // depends on an unreleased segment
      const write = s.nodes.some(isWrite);
      const pure = s.nodes.every((n) => PURE_TYPES.has(n.type));
      const maxIdx = Math.max(...stepNodes.map((id) => stepIndex.get(id) ?? -1));
      // A page chain is complete once a later step exists that is not part of it (the stream
      // moved on), or at a write, or when the phase is sealed. Releasing earlier would force a
      // re-navigation for the steps that continue the page.
      const closed = ps.sealed || write || maxIdx < lastStepIndex;
      if (!closed) continue;
      const stableId = `${ps.header.id}.f${++ps.counter}`;
      tmpToStable.set(s.id, stableId);
      const seg: CompiledSegment = { ...s, id: stableId, dependsOn: deps as string[], phaseId: ps.header.id };
      ps.frozen.push(seg);
      for (const n of seg.nodes) ps.nodeSeg.set(n.id, stableId);
      const rel: ReleasedFragment = { phaseId: ps.header.id, segment: seg, pure, write };
      released.push(rel);
      this.releasedOrder.push(rel);
    }
    this.compileMs += performance.now() - t0;
    return { released, issues };
  }

  phaseInfo(phaseId: string): PhaseInfo | undefined {
    return this.phases.get(phaseId)?.info;
  }

  /** Steps of a phase that never made it into a released fragment (e.g. invalid). */
  unreleasedSteps(phaseId: string): string[] {
    const ps = this.phases.get(phaseId);
    if (!ps) return [];
    return ps.header.steps.map((s) => s.id).filter((id) => !ps.nodeSeg.has(id));
  }
}
