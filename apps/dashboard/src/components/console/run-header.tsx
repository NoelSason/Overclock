"use client";

import { deriveMetrics } from "@overclock/contracts";
import { useState } from "react";
import { engine, errorMessage, type RunControl } from "@/lib/api";
import { writeTaskCount } from "@/lib/derive";
import { fmtClock, fmtInt, fmtMs, fmtNum, fmtPct, fmtTokens, fmtUsd } from "@/lib/format";
import { useSlices, useSlicesThrottled } from "@/lib/hooks";
import { ALL_SLICES, type RunStore } from "@/lib/run-store";
import { ACTIVE_STATUSES, STATUS_TONE } from "@/lib/states";
import { Badge, Button, Stat, cx } from "../ui/primitives";

const CONNECTION_LABEL = { loading: "Loading history", live: "Live", reconnecting: "Reconnecting", ended: "Stream ended", error: "Engine unreachable" } as const;

/** Run identity, status, controls, and the headline KPIs (including the cold-start tiles). */
export function RunHeader({ store, onOpenInterference }: { store: RunStore; onOpenInterference: () => void }) {
  useSlices(store, ["meta", "connection", "program"]);
  const view = store.view;
  const conn = store.connection;
  const [pending, setPending] = useState<RunControl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const control = async (action: RunControl) => {
    setPending(action);
    setError(null);
    try {
      await engine.control(store.runId, action);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(null);
    }
  };

  const status = view.status;
  const active = ACTIVE_STATUSES.has(status);
  const canPause = status === "running" || status === "discovering" || status === "compiling";

  return (
    <section aria-label="Run" className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="max-w-full truncate font-mono text-sm font-semibold text-fg" title={store.runId}>
            {store.runId}
          </h1>
          <Badge tone={STATUS_TONE[status]} className="uppercase" title={`Run status: ${status}`}>
            <span data-testid="run-status">{status}</span>
          </Badge>
          {view.mode && <Badge tone={view.mode === "overclock" ? "accent" : "neutral"}>{view.mode}</Badge>}
          {view.program?.strategy && (
            <Badge tone="neutral" title="Compiled strategy">
              {view.program.strategy}
            </Badge>
          )}
        </div>
        <span className={cx("text-[11px]", conn.state === "error" ? "text-bad" : conn.state === "reconnecting" ? "text-warn" : "text-dim")} title={conn.error}>
          {CONNECTION_LABEL[conn.state]}
          {conn.state === "error" && conn.error ? `: ${conn.error}` : ""} ·{" "}
          <EventCount store={store} />{" "}
          events
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => void control("pause")} disabled={!canPause || pending !== null}>
            {pending === "pause" ? "Pausing…" : "Pause"}
          </Button>
          <Button size="sm" onClick={() => void control("resume")} disabled={status !== "paused" || pending !== null}>
            {pending === "resume" ? "Resuming…" : "Resume"}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void control("cancel")} disabled={!active || pending !== null}>
            {pending === "cancel" ? "Stopping…" : "Stop"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onOpenInterference} aria-haspopup="dialog">
            Interference
          </Button>
        </div>
      </div>
      {view.goal && (
        <div className="border-t border-line px-3 py-2">
          <p className={cx("text-xs whitespace-pre-wrap text-muted", !expanded && "line-clamp-2")}>{view.goal}</p>
          {view.goal.split("\n").length > 2 || view.goal.length > 220 ? (
            <button type="button" className="mt-0.5 text-[11px] text-accent-soft hover:underline" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
              {expanded ? "Show less" : "Show full goal"}
            </button>
          ) : null}
        </div>
      )}
      {error && (
        <div role="alert" className="border-t border-line px-3 py-1.5 text-xs text-bad">
          {error}
        </div>
      )}
      <KpiStrip store={store} />
    </section>
  );
}

function EventCount({ store }: { store: RunStore }) {
  useSlicesThrottled(store, ALL_SLICES, 150);
  return (
    <span data-testid="event-count" data-value={store.view.lastSeq}>
      {fmtInt(store.view.lastSeq)}
    </span>
  );
}

function KpiStrip({ store }: { store: RunStore }) {
  useSlicesThrottled(store, ["meta", "stages", "telemetry", "tasks", "workers", "program"], 120);
  const view = store.view;
  const m = deriveMetrics(view);
  const complete = view.summary !== undefined;
  const writes = writeTaskCount(view);
  const hasExecution = view.stages.some((st) => st.stage === "execution");
  const verifiedShare = writes && writes.active > 0 ? view.receipts.VERIFIED / writes.active : null;

  return (
    <div className="grid gap-3 border-t border-line px-3 py-3 xl:grid-cols-2 xl:gap-0">
      <div className="xl:border-r xl:border-line xl:pr-4">
        <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-dim uppercase">Cold start</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
          <Stat label="First action" testId="stat-first-action" raw={m.firstActionMs} value={fmtMs(m.firstActionMs)} sub="first browser action" />
          <Stat label="First verified action" testId="stat-first-verified" raw={m.firstVerifiedMs} value={fmtMs(m.firstVerifiedMs)} sub="time to read-back" tone={m.firstVerifiedMs !== null ? "ok" : undefined} />
          <Stat label={<>Discovery <Par /> execution</>} testId="stat-overlap" raw={hasExecution ? m.overlapMs : null} value={hasExecution ? fmtMs(m.overlapMs) : "—"} sub="thinking during work" tone={hasExecution && m.overlapMs > 0 ? "accent" : undefined} />
          <Stat label="Total wall time" testId="stat-total-wall" raw={complete ? m.elapsedMs : null} value={complete ? fmtMs(m.elapsedMs) : "—"} sub={complete ? "complete" : `elapsed ${fmtClock(view.lastT)}`} />
          <Stat label="Verified" testId="stat-verified-share" raw={verifiedShare} value={fmtPct(verifiedShare, 1)} sub={writes === null ? "of write tasks" : `of ${fmtInt(writes.active)} writes${writes.skipped ? `, ${fmtInt(writes.skipped)} skipped` : ""}`} tone={verifiedShare !== null ? "ok" : undefined} />
        </div>
      </div>
      <div className="xl:pl-4">
        <div className="mb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-dim uppercase">Throughput</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
          <Stat label="Verified writes" testId="stat-verified" raw={m.verified} value={fmtInt(m.verified)} sub={`${fmtInt(Object.keys(view.tasks).length)} tasks`} tone="ok" />
          <Stat label="Now" testId="stat-throughput-now" raw={m.recentThroughputPerMin} value={view.verifiedTimeline.length ? fmtNum(m.recentThroughputPerMin) : "—"} sub="verified / min, 10 s" />
          <Stat label="Average" testId="stat-throughput-avg" raw={m.throughputPerMin} value={view.verifiedTimeline.length ? fmtNum(m.throughputPerMin) : "—"} sub="verified / min" />
          <Stat label="Model calls" testId="stat-model-calls" raw={view.modelCalls.count} value={fmtInt(view.modelCalls.count)} sub={`${fmtTokens(view.modelCalls.inputTokens + view.modelCalls.outputTokens)} tokens`} />
          <Stat label="Model cost" testId="stat-cost" raw={view.modelCalls.costUsd} value={fmtUsd(view.modelCalls.costUsd)} sub={`${fmtUsd(m.costPerVerifiedUsd)} / verified`} />
        </div>
      </div>
    </div>
  );
}

/** The "parallel" sign, set in the mono face so it reads as ∥ rather than a thin bar. */
export function Par() {
  return <span className="font-mono">∥</span>;
}
