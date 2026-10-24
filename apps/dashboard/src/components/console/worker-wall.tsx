"use client";

import type { WorkerView } from "@overclock/contracts";
import { engineAsset } from "@/lib/config";
import { fmtInt, fmtMs, shortId } from "@/lib/format";
import { programGraph } from "@/lib/graph";
import { useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { WORKER_COLOR } from "@/lib/states";
import { Empty, Panel, cx } from "../ui/primitives";

const BUSY = new Set(["LEASED", "PRECONDITION_CHECK", "EXECUTING", "VERIFYING", "REPAIRING", "RECONCILING"]);

/** Browser worker pool. Thumbnails load only when a new `worker.thumb` event changes the URL. */
export function WorkerWall({ store }: { store: RunStore }) {
  useSlicesThrottled(store, ["workers", "tasks", "program"], 200);
  const view = store.view;
  const workers = Object.values(view.workers).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const critical = view.program ? programGraph(view.program).critical.segmentIds : new Set<string>();
  const busy = workers.filter((w) => BUSY.has(w.state)).length;
  const onCritical = workers.filter((w) => BUSY.has(w.state) && w.taskId && critical.has(view.tasks[w.taskId]?.segmentId ?? "")).length;

  return (
    <Panel
      id="workers"
      title="Workers"
      subtitle={workers.length ? `${busy} busy of ${workers.length}` : undefined}
      actions={onCritical > 0 ? <span className="text-[11px] text-accent-soft">{onCritical} on critical path</span> : null}
      bodyClassName="p-3"
    >
      {workers.length === 0 ? (
        <Empty>No browser workers yet.</Empty>
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
          {workers.map((w) => {
            const task = w.taskId ? view.tasks[w.taskId] : undefined;
            const seg = task && view.program ? programGraph(view.program).byId.get(task.segmentId) : undefined;
            return <WorkerCard key={w.id} worker={w} inState={view.lastT - w.sinceT} recordKey={task?.recordKey} segmentLabel={seg?.label} critical={BUSY.has(w.state) && task !== undefined && critical.has(task.segmentId)} />;
          })}
        </ul>
      )}
    </Panel>
  );
}

function WorkerCard({ worker: w, inState, recordKey, segmentLabel, critical }: { worker: WorkerView; inState: number; recordKey: string | undefined; segmentLabel: string | undefined; critical: boolean }) {
  const color = WORKER_COLOR[w.state];
  return (
    <li data-testid={`worker-${w.id}`} className={cx("overflow-hidden rounded-md border bg-sunken/70", critical ? "border-accent/70 shadow-[0_0_0_1px_#3d8bff55]" : "border-line")}>
      <div className="relative aspect-[16/10] bg-[#05070a]">
        {w.thumbUrl ? (
          // Plain <img>: frames are engine-served JPEGs that change per event, not static assets.
          <img src={engineAsset(w.thumbUrl)} alt={`Latest frame from ${w.id}`} className="h-full w-full object-cover object-top" decoding="async" loading="lazy" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10.5px] text-dim">no frame yet</div>
        )}
        <span className="absolute top-1 left-1 rounded bg-black/70 px-1 font-mono text-[10px] text-fg">{w.id}</span>
        {critical && <span className="absolute top-1 right-1 rounded bg-accent/80 px-1 text-[9.5px] font-medium text-white">critical</span>}
      </div>
      <div className="px-2 py-1.5">
        <div className="flex items-center gap-1.5 text-[10.5px]">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full transition-colors duration-300" style={{ background: color }} />
          <span className="font-medium" style={{ color }}>
            {w.state.toLowerCase().replace("_", " ")}
          </span>
          <span className="tnum ml-auto font-mono text-dim" title="time in state">
            {fmtMs(inState)}
          </span>
        </div>
        <div className="mt-0.5 flex gap-1.5 text-[10.5px] text-muted">
          <span className="truncate">{w.app ?? "—"}</span>
          {recordKey && <span className="truncate font-mono text-fg">{recordKey}</span>}
        </div>
        <div className="truncate text-[10.5px] text-dim" title={w.op ?? w.label ?? segmentLabel}>
          {w.op ?? w.label ?? segmentLabel ?? (w.taskId ? shortId(w.taskId, 14) : "idle")}
        </div>
        <div className="tnum mt-0.5 text-[10.5px] text-dim">
          <span className="font-mono text-fg">{fmtInt(w.tasksDone)}</span> done · busy {fmtMs(w.busyMs)}
        </div>
      </div>
    </li>
  );
}
