import type { CompiledProgram, CompiledSegment } from "@overclock/compiler";
import { bottomLevels, recordFirstPriority } from "@overclock/compiler";

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
 * per-app concurrency caps, phase barriers, the executor's task priority, and serialized
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
    // Per segment, not per task: a segment's duration and whether it takes a contended lock.
    const segMs = new Map(segs.map((s) => [s.id, input.segmentMs(s) + (s.app ? overhead : 0)]));
    const takesLock = new Map(segs.map((s) => [s.id, s.writes.some((w) => contended.has(w))]));
    const tasks: SimTask[] = [];
    for (let r = 0; r < items; r++) {
      const local = new Map<string, SimTask>();
      for (const s of segs) {
        const t: SimTask = { id: `${s.id}@${r}`, seg: s, ms: segMs.get(s.id)!, deps: s.dependsOn.length, dependents: [], prio: recordFirstPriority(bl.get(s.id) ?? 0, r) };
        local.set(s.id, t);
        tasks.push(t);
      }
      for (const s of segs) for (const d of s.dependsOn) local.get(d)!.dependents.push(local.get(s.id)!);
    }
    totalTasks += tasks.length;
    const start = clock;
    const ready: SimTask[] = tasks.filter((t) => t.deps === 0);
    // ready[0, sorted) is in descending priority; tasks that became ready since are appended after
    // it. Inserting each of them after every task of equal or higher priority orders the list
    // exactly as a stable sort of the whole list would, without re-sorting it at every event.
    let sorted = 0;
    const order = () => {
      if (sorted === 0) {
        ready.sort((a, b) => b.prio - a.prio);
        sorted = ready.length;
        return;
      }
      const arrived = ready.splice(sorted);
      for (const t of arrived) {
        let lo = 0;
        let hi = ready.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ready[mid]!.prio >= t.prio) lo = mid + 1;
          else hi = mid;
        }
        ready.splice(lo, 0, t);
      }
      sorted = ready.length;
    };
    const take = (i: number): SimTask => {
      if (i < sorted) sorted--;
      return ready.splice(i, 1)[0]!;
    };
    const running: { end: number; t: SimTask }[] = [];
    const appRunning = new Map<string, number>();
    let lockBusy = false;
    let done = 0;
    const finish = (t: SimTask) => {
      done++;
      for (const d of t.dependents) if (--d.deps === 0) ready.push(d);
    };
    while (done < tasks.length) {
      order();
      // Browser-free compute tasks complete instantly.
      for (let i = ready.length - 1; i >= 0; i--) if (!ready[i]!.seg.app) finish(take(i));
      let assigned = true;
      while (assigned && running.length < workers) {
        assigned = false;
        for (let i = 0; i < ready.length; i++) {
          const t = ready[i]!;
          if (!t.seg.app) continue;
          const cap = input.perAppCap?.[t.seg.app] ?? Infinity;
          if ((appRunning.get(t.seg.app) ?? 0) >= cap) continue;
          const locked = takesLock.get(t.seg.id)!;
          if (locked && lockBusy) continue;
          take(i);
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
      if (takesLock.get(next.t.seg.id)) lockBusy = false;
      finish(next.t);
    }
    phaseResults.push({ id: phase.id, items, ms: Math.round(clock - start), tasks: tasks.length });
  }
  return { makespanMs: Math.round(clock), phases: phaseResults, tasks: totalTasks, busyMs: Math.round(busy), utilization: clock > 0 ? busy / (clock * workers) : 0 };
}
