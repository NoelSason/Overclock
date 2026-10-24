import type { CompiledProgram, CompiledSegment } from "@overclock/compiler";
import { bottomLevels } from "@overclock/compiler";

export interface SimulationInput {
  compiled: CompiledProgram;
  /** Number of records the per-record phases iterate over. */
  records: number;
  workers: number;
  /** Max concurrent tasks per app (application limits / adaptive caps). */
  perAppCap?: Record<string, number>;
  segmentMs: (seg: CompiledSegment) => number;
  /** Items in foreach phases that do not iterate the input records (aggregates); default ~15% of records. */
  derivedPhaseItems?: (phaseId: string) => number;
  /** Per-task orchestration overhead (lease, events, locator cache), ms. */
  overheadMs?: number;
}

export interface SimulationResult {
  makespanMs: number;
  phases: { id: string; items: number; ms: number; tasks: number }[];
  tasks: number;
  busyMs: number;
  utilization: number;
}

interface SimTask {
  id: string;
  seg: CompiledSegment;
  ms: number;
  deps: number;
  dependents: SimTask[];
  prio: number;
}

/**
 * Event-driven list-scheduling simulation of the expanded task DAG: W identical workers,
 * per-app concurrency caps, phase barriers, critical-path priority, and serialized
 * per-run-constant locks. This is how candidate strategies are compared before execution.
 */
export function simulate(input: SimulationInput): SimulationResult {
  const { compiled, workers } = input;
  const overhead = input.overheadMs ?? 4;
  let clock = 0;
  let busy = 0;
  let totalTasks = 0;
  const phaseResults: SimulationResult["phases"] = [];
  const contended = new Set(compiled.stats.contendedLocks);

  for (const phase of compiled.phases) {
    const segs = phase.segmentIds.map((id) => compiled.segments.get(id)!);
    const items = phase.kind === "once" ? 1 : /\$input\.records/.test(phase.over ?? "") ? input.records : (input.derivedPhaseItems?.(phase.id) ?? Math.max(1, Math.round(input.records * 0.15)));
    const bl = bottomLevels(
      segs.map((s) => ({ id: s.id, deps: s.dependsOn })),
      (n) => input.segmentMs(compiled.segments.get(n.id)!),
    );
    const tasks: SimTask[] = [];
    for (let r = 0; r < items; r++) {
      const local = new Map<string, SimTask>();
      for (const s of segs) {
        const t: SimTask = { id: `${s.id}@${r}`, seg: s, ms: input.segmentMs(s) + (s.app ? overhead : 0), deps: s.dependsOn.length, dependents: [], prio: (bl.get(s.id) ?? 0) * 1000 - r };
        local.set(s.id, t);
        tasks.push(t);
      }
      for (const s of segs) for (const d of s.dependsOn) local.get(d)!.dependents.push(local.get(s.id)!);
    }
    totalTasks += tasks.length;
    const start = clock;
    const ready: SimTask[] = tasks.filter((t) => t.deps === 0);
    const running: { end: number; t: SimTask }[] = [];
    const appRunning = new Map<string, number>();
    let lockBusy = false;
    let done = 0;
    const finish = (t: SimTask) => {
      done++;
      for (const d of t.dependents) if (--d.deps === 0) ready.push(d);
    };
    while (done < tasks.length) {
      ready.sort((a, b) => b.prio - a.prio);
      // Browser-free compute tasks complete instantly.
      for (let i = ready.length - 1; i >= 0; i--) if (!ready[i]!.seg.app) finish(ready.splice(i, 1)[0]!);
      let assigned = true;
      while (assigned && running.length < workers) {
        assigned = false;
        for (let i = 0; i < ready.length; i++) {
          const t = ready[i]!;
          if (!t.seg.app) continue;
          const cap = input.perAppCap?.[t.seg.app] ?? Infinity;
          if ((appRunning.get(t.seg.app) ?? 0) >= cap) continue;
          const locked = t.seg.writes.some((w) => contended.has(w));
          if (locked && lockBusy) continue;
          ready.splice(i, 1);
          appRunning.set(t.seg.app, (appRunning.get(t.seg.app) ?? 0) + 1);
          if (locked) lockBusy = true;
          running.push({ end: clock + t.ms, t });
          busy += t.ms;
          assigned = true;
          break;
        }
      }
      if (running.length === 0) {
        if (ready.some((t) => !t.seg.app)) continue;
        break; // nothing runnable (would only happen with a zero cap); avoid spinning
      }
      running.sort((a, b) => a.end - b.end);
      const next = running.shift();
      if (!next) break;
      clock = next.end;
      appRunning.set(next.t.seg.app!, appRunning.get(next.t.seg.app!)! - 1);
      if (next.t.seg.writes.some((w) => contended.has(w))) lockBusy = false;
      finish(next.t);
    }
    phaseResults.push({ id: phase.id, items, ms: Math.round(clock - start), tasks: tasks.length });
  }
  return { makespanMs: Math.round(clock), phases: phaseResults, tasks: totalTasks, busyMs: Math.round(busy), utilization: clock > 0 ? busy / (clock * workers) : 0 };
}
