import type { CostEstimate } from "@overclock/contracts";
import type { CompiledProgram } from "@overclock/compiler";
import type { LatencyModel } from "./latency";
import { simulate, type SimulationResult } from "./simulate";

export interface CostInputs {
  compiled: CompiledProgram;
  records: number;
  workers: number;
  perAppCap?: Record<string, number>;
  latency: LatencyModel;
  /** Model time still to be spent before execution can start (ms), e.g. remaining planning. */
  remainingModelMs: number;
  modelCostUsd: number;
  /** Probability that a task needs recovery (from dry-run probes or observed failure rate). */
  failureRate: { value: number; source: "measured" | "estimated" | "default" };
  /** Mean recovery cost when it happens (ms). */
  repairMs: { value: number; source: "measured" | "estimated" | "default" };
  coordinationPerTaskMs?: number;
}

/**
 * ExpectedCost = ModelInferenceLatency + BrowserCriticalPathLatency + ExpectedRecoveryLatency
 *              + CoordinationOverhead  (verification is part of the browser critical path; it is
 *              reported separately but not double counted).
 */
export function estimateCost(i: CostInputs): { estimate: CostEstimate; sim: SimulationResult } {
  const sim = simulate({ compiled: i.compiled, records: i.records, workers: i.workers, perAppCap: i.perAppCap, segmentMs: (s) => i.latency.segmentMs(s).ms });
  const writes = [...i.compiled.segments.values()].filter((s) => s.kind === "write");
  const verifyPerWrite = writes.length ? writes.reduce((sum, s) => sum + i.latency.navMs(s.app).ms, 0) / writes.length : 0;
  const writeTasks = sim.phases.reduce((n, p) => {
    const phase = i.compiled.phases.find((x) => x.id === p.id)!;
    return n + p.items * phase.segmentIds.filter((id) => i.compiled.segments.get(id)!.kind === "write").length;
  }, 0);
  const verificationMs = (writeTasks * verifyPerWrite) / Math.max(1, i.workers);
  const recoveryMs = (sim.tasks * i.failureRate.value * i.repairMs.value) / Math.max(1, i.workers);
  // The coordinator is a single event loop: its per-task bookkeeping does not parallelize.
  const coordinationMs = sim.tasks * (i.coordinationPerTaskMs ?? 1);
  const total = i.remainingModelMs + sim.makespanMs + recoveryMs + coordinationMs;
  const measuredApps = i.latency.measuredApps();
  return {
    sim,
    estimate: {
      modelMs: Math.round(i.remainingModelMs),
      browserCriticalPathMs: sim.makespanMs,
      recoveryMs: Math.round(recoveryMs),
      coordinationMs: Math.round(coordinationMs),
      verificationMs: Math.round(verificationMs),
      totalMs: Math.round(total),
      workers: i.workers,
      modelCostUsd: i.modelCostUsd,
      basis: [
        { input: "page load latency", source: measuredApps.length ? "measured" : "default", value: Math.round(measuredApps.reduce((s, a) => s + i.latency.navMs(a).ms, 0) / Math.max(1, measuredApps.length) || i.latency.defaults.navMs) },
        { input: "failure rate", source: i.failureRate.source, value: i.failureRate.value },
        { input: "repair cost ms", source: i.repairMs.source, value: i.repairMs.value },
        { input: "tasks", source: "estimated", value: sim.tasks },
        { input: "utilization", source: "estimated", value: Math.round(sim.utilization * 100) / 100 },
      ],
    },
  };
}

/** Smallest worker count whose simulated makespan is within `tolerance` of the best. */
export function recommendWorkers(base: Omit<CostInputs, "workers">, maxWorkers: number, tolerance = 0.06): { workers: number; curve: { workers: number; ms: number }[] } {
  const options = [1, 2, 4, 6, 8, 12, 16, 24, 32].filter((w) => w <= maxWorkers);
  if (!options.includes(maxWorkers)) options.push(maxWorkers);
  const curve = options.map((w) => ({ workers: w, ms: estimateCost({ ...base, workers: w }).estimate.totalMs }));
  const best = Math.min(...curve.map((c) => c.ms));
  const pick = curve.find((c) => c.ms <= best * (1 + tolerance)) ?? curve.at(-1)!;
  return { workers: pick.workers, curve };
}

export interface RankedCandidate {
  id: string;
  name: string;
  estimate: CostEstimate | null;
  valid: boolean;
}

export function selectCandidate(cands: RankedCandidate[]): { winner: RankedCandidate | null; reason: string; ranking: { candidateId: string; totalMs: number | null }[] } {
  const ranking = cands.map((c) => ({ candidateId: c.id, totalMs: c.valid ? (c.estimate?.totalMs ?? null) : null })).sort((a, b) => (a.totalMs ?? Infinity) - (b.totalMs ?? Infinity));
  const valid = cands.filter((c) => c.valid && c.estimate);
  if (!valid.length) return { winner: null, reason: "no candidate passed validation", ranking };
  valid.sort((a, b) => a.estimate!.totalMs - b.estimate!.totalMs);
  const w = valid[0]!;
  const runner = valid[1];
  const fmt = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const reason = runner
    ? `"${w.name}" has the lowest expected verified completion time: ${fmt(w.estimate!.totalMs)} vs ${fmt(runner.estimate!.totalMs)} for "${runner.name}" (${Math.round((1 - w.estimate!.totalMs / runner.estimate!.totalMs) * 100)}% faster; browser critical path ${fmt(w.estimate!.browserCriticalPathMs)} at ${w.estimate!.workers} workers)`
    : `"${w.name}" is the only valid candidate (${fmt(w.estimate!.totalMs)} expected at ${w.estimate!.workers} workers)`;
  return { winner: w, reason, ranking };
}
