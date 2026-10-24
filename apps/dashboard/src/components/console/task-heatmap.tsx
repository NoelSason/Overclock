"use client";

import type { RunView, SegmentTemplate, TaskState, TaskView } from "@overclock/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt } from "@/lib/format";
import { programGraph } from "@/lib/graph";
import { useElementWidth, useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { CATEGORY, TASK_CATEGORY, TASK_STATES, taskColor } from "@/lib/states";
import { Empty, Panel } from "../ui/primitives";

const LABEL_W = 104;
const MAX_VIEW_H = 340;
const EMPTY_CELL = "#12171d";

interface Index {
  rows: string[];
  cols: { id: string; segment?: SegmentTemplate | undefined }[];
  /** rows × cols; tasks are mutated in place by the reducer, so cells stay current. */
  cells: (TaskView | undefined)[][];
}

function buildIndex(view: RunView, ordered: SegmentTemplate[]): Index {
  const rowOf = new Map<string, number>();
  const rows: string[] = [];
  const usedSegs = new Set<string>();
  for (const t of Object.values(view.tasks)) {
    if (!rowOf.has(t.recordKey)) {
      rowOf.set(t.recordKey, rows.length);
      rows.push(t.recordKey);
    }
    usedSegs.add(t.segmentId);
  }
  const cols: Index["cols"] = ordered.filter((s) => usedSegs.has(s.id)).map((s) => ({ id: s.id, segment: s }));
  for (const id of usedSegs) if (!cols.some((c) => c.id === id)) cols.push({ id });
  const colOf = new Map(cols.map((c, i) => [c.id, i]));
  const cells: (TaskView | undefined)[][] = rows.map(() => new Array<TaskView | undefined>(cols.length));
  for (const t of Object.values(view.tasks)) cells[rowOf.get(t.recordKey)!]![colOf.get(t.segmentId)!] = t;
  return { rows, cols, cells };
}

/** Record × segment grid of task states, drawn on a canvas and virtualized by scroll position. */
export function TaskHeatmap({ store }: { store: RunStore }) {
  const version = useSlicesThrottled(store, ["tasks", "program"], 150);
  const view = store.view;
  const taskCount = Object.keys(view.tasks).length;
  const ordered = useMemo(() => (view.program ? programGraph(view.program).ordered : []), [view.program]);
  // Rebuild only when the task set or program changes; state changes are read through the cells.
  const index = useMemo(() => buildIndex(store.view, ordered), [store, ordered, taskCount]);

  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<{ row: number; col: number; x: number; y: number } | null>(null);

  const nRows = index.rows.length;
  const nCols = Math.max(1, index.cols.length);
  const cellH = nRows > 160 ? 6 : nRows > 60 ? 9 : 14;
  const cellW = Math.max(6, Math.min(64, Math.floor((width - LABEL_W - 4) / nCols)));
  const totalH = nRows * cellH;
  const viewH = Math.min(totalH, MAX_VIEW_H);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0 || viewH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = LABEL_W + cellW * nCols;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(viewH * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(viewH * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, viewH);
    const first = Math.floor(scrollTop / cellH);
    const offset = scrollTop - first * cellH;
    const visible = Math.ceil(viewH / cellH) + 1;
    const gap = cellW > 10 ? 1 : 0.5;
    ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i < visible; i++) {
      const r = first + i;
      if (r >= nRows) break;
      const y = i * cellH - offset;
      const row = index.cells[r]!;
      if (cellH >= 9) {
        ctx.fillStyle = "#9aa6b4";
        const key = index.rows[r]!;
        ctx.fillText(key.length > 14 ? `${key.slice(0, 13)}…` : key, 4, y + cellH / 2);
      }
      for (let c = 0; c < index.cols.length; c++) {
        const t = row[c];
        ctx.fillStyle = t ? taskColor(t.state) : EMPTY_CELL;
        ctx.fillRect(LABEL_W + c * cellW, y, cellW - gap, cellH - gap);
      }
    }
  }, [version, index, width, scrollTop, cellH, cellW, nCols, nRows, viewH]);

  const hovered = hover ? index.cells[hover.row]?.[hover.col] : undefined;

  return (
    <Panel
      id="heatmap"
      title="Tasks"
      subtitle={nRows ? `${fmtInt(nRows)} records × ${index.cols.length} segments` : undefined}
      actions={<TaskStateCounts counts={view.taskCounts} />}
      bodyClassName="p-3"
    >
      <div ref={wrapRef} className="relative w-full">
        {nRows === 0 ? (
          <Empty>Tasks appear once the program is compiled and records are fanned out.</Empty>
        ) : (
          <>
            <div className="mb-1 flex text-[10px] text-dim" style={{ paddingLeft: LABEL_W }} aria-hidden>
              {index.cols.map((c, i) => (
                <span key={c.id} title={c.segment?.label ?? c.id} className="truncate text-center" style={{ width: cellW, color: c.segment?.kind === "write" ? "#f2b13c" : undefined }}>
                  {cellW >= 28 ? `s${i + 1}` : ""}
                </span>
              ))}
            </div>
            <div
              className="relative overflow-y-auto overscroll-contain rounded border border-line bg-sunken"
              style={{ height: viewH + 2 }}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const col = Math.floor((x - LABEL_W) / cellW);
                const row = Math.floor((y + e.currentTarget.scrollTop) / cellH);
                if (x < LABEL_W || col < 0 || col >= index.cols.length || row < 0 || row >= nRows) setHover(null);
                else setHover({ row, col, x, y });
              }}
              onMouseLeave={() => setHover(null)}
              role="img"
              aria-label={`Task state grid: ${nRows} records by ${index.cols.length} segments`}
            >
              <div style={{ height: totalH }}>
                <canvas ref={canvas} className="sticky top-0 block" style={{ width: LABEL_W + cellW * nCols, height: viewH }} />
              </div>
            </div>
            {hover && (
              <div className="pointer-events-none absolute z-10 max-w-[280px] rounded-md border border-line-strong bg-raised px-2 py-1.5 text-[11px] shadow-lg" style={{ left: Math.min(hover.x + 14, Math.max(0, width - 290)), top: hover.y + 34 }}>
                <div className="font-mono text-fg">{index.rows[hover.row]}</div>
                <div className="truncate text-muted">{index.cols[hover.col]?.segment?.label ?? index.cols[hover.col]?.id}</div>
                {hovered ? (
                  <div className="mt-0.5 flex flex-wrap gap-x-2">
                    <span style={{ color: taskColor(hovered.state) }}>{hovered.state}</span>
                    {hovered.attempts > 0 && <span className="text-dim">attempt {hovered.attempts}</span>}
                    {hovered.workerId && <span className="text-dim">{hovered.workerId}</span>}
                  </div>
                ) : (
                  <div className="text-dim">no task</div>
                )}
                {hovered?.lastError && <div className="mt-0.5 text-bad">{hovered.lastError}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

function TaskStateCounts({ counts }: { counts: Partial<Record<TaskState, number>> }) {
  const present = TASK_STATES.filter((s) => (counts[s] ?? 0) > 0);
  if (present.length === 0) return null;
  return (
    <ul aria-label="Tasks by state" className="flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
      {present.map((s) => (
        <li key={s} className="inline-flex items-center gap-1 text-[11px] text-muted" title={CATEGORY[TASK_CATEGORY[s]].label}>
          <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: taskColor(s) }} />
          {s.toLowerCase().replace("_", " ")}
          <span data-testid={`task-count-${s}`} data-value={counts[s]} className="tnum font-mono text-fg">
            {fmtInt(counts[s])}
          </span>
        </li>
      ))}
    </ul>
  );
}
