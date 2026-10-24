"use client";

import { deriveMetrics, type StageName } from "@overclock/contracts";
import { overlapIntervals } from "@/lib/derive";
import { fmtMs } from "@/lib/format";
import { useElementWidth, useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Panel } from "../ui/primitives";

const STAGE_ORDER: StageName[] = ["discovery", "planning", "compilation", "critique", "probe", "optimization", "execution"];
const STAGE_COLOR: Record<StageName, string> = {
  discovery: "#8ab4ff",
  planning: "#7c9cff",
  compilation: "#5f86e8",
  critique: "#b28cff",
  probe: "#38c6e8",
  optimization: "#f2b13c",
  execution: "#2fd27a",
};

const LABEL_W = 92;
const PAD_R = 14;
const TOP = 50;
const ROW_H = 16;
const ROW_GAP = 6;
const AXIS_H = 20;

function niceStep(rangeMs: number, targetTicks: number): number {
  const raw = rangeMs / Math.max(1, targetTicks);
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
  return steps.find((s) => s >= raw) ?? 3_600_000;
}

function tickLabel(ms: number, step: number): string {
  if (step < 1000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m}m${String(s).padStart(2, "0")}` : `${m}m`;
}

/**
 * Gantt of pipeline stages against wall time since submission. Stages can overlap (streaming
 * mode); the band where thinking and execution coincide is shaded and labelled with the exact
 * overlap from `deriveMetrics`.
 */
export function PipelineTimeline({ store }: { store: RunStore }) {
  useSlicesThrottled(store, ["stages", "telemetry", "meta"], 200);
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const view = store.view;
  const m = deriveMetrics(view);
  const now = view.lastT;
  const complete = view.summary !== undefined;
  const end = Math.max(complete ? m.elapsedMs : now, now, 1000);

  const present = new Set(view.stages.map((s) => s.stage));
  const rows = STAGE_ORDER.filter((s) => present.has(s) || s === "execution");

  const plotW = Math.max(100, width - LABEL_W - PAD_R);
  const x = (t: number) => LABEL_W + (Math.min(Math.max(t, 0), end) / end) * plotW;
  const height = TOP + rows.length * (ROW_H + ROW_GAP) + AXIS_H;
  const rowY = (i: number) => TOP + i * (ROW_H + ROW_GAP);
  const overlaps = overlapIntervals(view.stages, now);
  const step = niceStep(end, Math.max(2, Math.floor(plotW / 90)));
  const ticks: number[] = [];
  for (let t = 0; t <= end; t += step) ticks.push(t);
  const execIndex = rows.indexOf("execution");
  const hasExecution = view.stages.some((s) => s.stage === "execution");

  return (
    <Panel
      id="pipeline"
      title="Pipeline"
      subtitle="stages against wall time since submission"
      actions={
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-muted">
            discovery <span className="font-mono">∥</span> execution:{" "}
            <span data-testid="timeline-overlap" data-value={hasExecution ? m.overlapMs : ""} className="tnum font-mono text-accent-soft">
              {hasExecution ? fmtMs(m.overlapMs) : "—"}
            </span>
          </span>
          <span className="text-muted">
            total:{" "}
            <span data-testid="timeline-total" className="tnum font-mono text-fg">
              {complete ? fmtMs(m.elapsedMs) : "—"}
            </span>
          </span>
        </div>
      }
      bodyClassName="px-1 py-2"
    >
      <div ref={ref} className="w-full">
        {view.stages.length === 0 ? (
          <div className="px-2 py-3 text-xs text-dim">No stage has started yet.</div>
        ) : (
          width > 0 && (
            <svg width={width} height={height} role="img" aria-label="Pipeline stage timeline" className="block">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={x(t)} x2={x(t)} y1={TOP - 4} y2={height - AXIS_H + 2} stroke="#1d242d" />
                  <text x={x(t)} y={height - 6} textAnchor="middle" className="fill-dim text-[10px]">
                    {tickLabel(t, step)}
                  </text>
                </g>
              ))}
              {overlaps.map((o, i) => (
                <g key={i}>
                  <rect x={x(o.start)} y={TOP - 6} width={Math.max(1, x(o.end) - x(o.start))} height={rows.length * (ROW_H + ROW_GAP) + 2} fill="#3d8bff" fillOpacity={0.14} stroke="#3d8bff" strokeOpacity={0.55} strokeDasharray="3 3">
                    <title>{`discovery ∥ execution ${fmtMs(o.end - o.start)}`}</title>
                  </rect>
                </g>
              ))}
              {rows.map((stage, i) => (
                <g key={stage}>
                  <text x={8} y={rowY(i) + ROW_H - 4} className={stage === "execution" ? "fill-fg text-[11px] font-medium" : "fill-muted text-[11px]"}>
                    {stage}
                  </text>
                  <rect x={LABEL_W} y={rowY(i)} width={plotW} height={ROW_H} rx={3} fill="#0a0d11" />
                  {view.stages
                    .filter((s) => s.stage === stage)
                    .map((s, j) => {
                      const open = s.end === undefined;
                      const w = Math.max(2, x(s.end ?? now) - x(s.start));
                      return (
                        <rect key={j} x={x(s.start)} y={rowY(i)} width={w} height={ROW_H} rx={3} fill={STAGE_COLOR[stage]} fillOpacity={open ? 0.55 : 0.85}>
                          <title>{`${stage}: ${fmtMs(s.start)} → ${open ? "running" : fmtMs(s.end)}${s.detail ? ` · ${s.detail}` : ""}`}</title>
                        </rect>
                      );
                    })}
                </g>
              ))}
              {execIndex >= 0 &&
                view.verifiedTimeline.map((t, i) => (i % Math.max(1, Math.ceil(view.verifiedTimeline.length / plotW)) === 0 ? <line key={i} x1={x(t)} x2={x(t)} y1={rowY(execIndex) + 3} y2={rowY(execIndex) + ROW_H - 3} stroke="#0e1217" strokeOpacity={0.55} /> : null))}
              <Marker x={m.firstActionMs === null ? null : x(m.firstActionMs)} y={2} label={`first action ${fmtMs(m.firstActionMs)}`} color="#8ab4ff" bottom={height - AXIS_H} width={width} />
              <Marker x={m.firstVerifiedMs === null ? null : x(m.firstVerifiedMs)} y={16} label={`time to first verified action ${fmtMs(m.firstVerifiedMs)}`} color="#2fd27a" bottom={height - AXIS_H} width={width} />
              {overlaps[0] && (
                <text x={x(overlaps[0].start) + 6} y={TOP - 10} className="text-[10.5px] font-medium" fill="#8ab4ff" stroke="#0e1217" strokeWidth={3} paintOrder="stroke">
                  {`discovery ‖ execution: ${fmtMs(m.overlapMs)}`}
                </text>
              )}
              {complete && <line x1={x(m.elapsedMs)} x2={x(m.elapsedMs)} y1={TOP - 4} y2={height - AXIS_H + 2} stroke="#e6ebf1" strokeOpacity={0.5} />}
            </svg>
          )
        )}
      </div>
    </Panel>
  );
}

function Marker({ x, y, label, color, bottom, width }: { x: number | null; y: number; label: string; color: string; bottom: number; width: number }) {
  if (x === null) return null;
  const anchorEnd = x > width - 220;
  return (
    <g>
      <line x1={x} x2={x} y1={y + 10} y2={bottom} stroke={color} strokeWidth={1.5} />
      <circle cx={x} cy={y + 10} r={2.5} fill={color} />
      <text x={anchorEnd ? x - 6 : x + 6} y={y + 9} textAnchor={anchorEnd ? "end" : "start"} className="text-[10.5px] font-medium" fill={color} stroke="#0e1217" strokeWidth={3} paintOrder="stroke">
        {label}
      </text>
    </g>
  );
}
