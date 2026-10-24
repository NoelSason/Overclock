import type { FragmentState, RunView, SegmentTemplate } from "@overclock/contracts";

/** View-derived values the dashboard needs beyond `deriveMetrics`. All pure functions of the view. */

export function segmentMap(view: RunView): Map<string, SegmentTemplate> {
  return new Map((view.program?.segments ?? []).map((s) => [s.id, s]));
}

/**
 * Write tasks (segment kind "write") that will actually write: SKIPPED/CANCELLED ones are
 * excluded so a guard that legitimately skips a write does not count against "verified".
 * Null until the program (and so segment kinds) is known.
 */
export function writeTaskCount(view: RunView): { active: number; skipped: number } | null {
  if (!view.program) return null;
  const segs = segmentMap(view);
  let active = 0;
  let skipped = 0;
  for (const t of Object.values(view.tasks)) {
    if (segs.get(t.segmentId)?.kind !== "write") continue;
    if (t.state === "SKIPPED" || t.state === "CANCELLED") skipped++;
    else active++;
  }
  return { active, skipped };
}

export interface Interval {
  start: number;
  end: number;
}

function merge(xs: Interval[]): Interval[] {
  const sorted = [...xs].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out.at(-1);
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/**
 * Intervals where a thinking stage and execution were both active (for drawing). Uses the same
 * rule as the contracts' `stageOverlapMs`, whose total is what the dashboard labels.
 */
export function overlapIntervals(stages: RunView["stages"], now: number): Interval[] {
  const thinking = merge(stages.filter((s) => s.stage !== "execution" && s.stage !== "optimization").map((s) => ({ start: s.start, end: s.end ?? now })));
  const exec = merge(stages.filter((s) => s.stage === "execution").map((s) => ({ start: s.start, end: s.end ?? now })));
  const out: Interval[] = [];
  for (const a of thinking)
    for (const b of exec) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (end > start) out.push({ start, end });
    }
  return merge(out);
}

/** Latest live fragment state per segment id (a "revised" fragment yields to its replacement). */
export function segmentFragmentStates(view: RunView): Map<string, { state: FragmentState; fragmentId: string; reason?: string | undefined }> {
  const best = new Map<string, { state: FragmentState; fragmentId: string; reason?: string | undefined; t: number; revised: boolean }>();
  for (const f of Object.values(view.fragments)) {
    const t = f.history.at(-1)?.t ?? 0;
    const revised = f.state === "revised";
    for (const seg of f.segmentIds) {
      const cur = best.get(seg);
      if (!cur || (cur.revised && !revised) || (cur.revised === revised && t >= cur.t)) best.set(seg, { state: f.state, fragmentId: f.fragmentId, reason: f.reason, t, revised });
    }
  }
  return new Map([...best].map(([k, v]) => [k, { state: v.state, fragmentId: v.fragmentId, reason: v.reason }]));
}

export const FRAGMENT_STYLE: Record<FragmentState, { label: string; color: string; dashed: boolean }> = {
  compiled: { label: "compiled", color: "#6c7889", dashed: true },
  validated: { label: "validated", color: "#8ab4ff", dashed: true },
  canary: { label: "canary", color: "#f2b13c", dashed: false },
  released: { label: "released", color: "#2fd27a", dashed: false },
  deferred: { label: "deferred", color: "#b28cff", dashed: true },
  revised: { label: "revised", color: "#4a5566", dashed: true },
  rejected: { label: "rejected", color: "#f0524f", dashed: false },
};

/** Segment ids that have at least one task currently held by a worker. */
export function runningSegments(view: RunView): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of Object.values(view.workers)) {
    if (!w.taskId || w.state === "IDLE" || w.state === "STOPPED" || w.state === "COMPLETED" || w.state === "FAILED") continue;
    const seg = view.tasks[w.taskId]?.segmentId;
    if (seg) out.set(seg, (out.get(seg) ?? 0) + 1);
  }
  return out;
}
