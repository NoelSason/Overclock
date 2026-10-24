"use client";

import { deriveMetrics, type RunView } from "@overclock/contracts";
import { fmtInt, fmtMs, fmtNum, fmtPct, fmtTokens, fmtUsd } from "@/lib/format";
import { useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Badge, Empty, KeyValue, Panel, Stat } from "../ui/primitives";
import { APP_COLORS, ConcurrencyChart, ThroughputChart } from "./charts";
import { GroundTruth } from "./ground-truth";
import { NetworkPanel } from "./network-panel";

const RECOVERY_TONE = { started: "warn", succeeded: "ok", failed: "bad", escalated: "violet" } as const;

/** Bottom telemetry: throughput, model usage, recoveries, concurrency, run summary, ground truth. */
export function Telemetry({ store }: { store: RunStore }) {
  const version = useSlicesThrottled(store, ["telemetry", "workers", "meta", "tasks"], 500);
  const view = store.view;
  const m = deriveMetrics(view);
  const endT = view.summary?.wallMs ?? view.lastT;

  return (
    <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
      <Panel id="throughput" title="Throughput" subtitle="verified writes over wall time" className="lg:col-span-2 2xl:col-span-1">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Wall clock" testId="stat-wall" raw={m.elapsedMs} value={fmtMs(m.elapsedMs)} />
          <Stat label="Worker utilization" testId="stat-utilization" raw={m.utilization} value={Object.keys(view.workers).length ? fmtPct(m.utilization) : "—"} sub={`${m.activeWorkers} active`} />
          <Stat label="Model-free actions" testId="stat-model-free" raw={m.modelFreeActionRatio} value={fmtPct(m.modelFreeActionRatio, 1)} sub={`${fmtInt(view.actions.count)} actions`} />
          <Stat label="Cost / verified" raw={m.costPerVerifiedUsd} value={fmtUsd(m.costPerVerifiedUsd)} sub={`${fmtUsd(view.modelCalls.costUsd)} total`} />
        </div>
        <div className="mt-3 h-[180px]">
          <ThroughputChart timeline={view.verifiedTimeline} endT={endT} version={version} />
        </div>
      </Panel>

      <ModelUsage view={view} />
      <Recoveries view={view} />

      <Panel id="concurrency" title="Concurrency" subtitle="adaptive limit per app">
        <div className="mb-2 flex flex-wrap gap-2">
          {Object.entries(view.concurrency)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([app, c], i) => (
              <span key={app} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                <span aria-hidden className="h-0.5 w-3" style={{ background: APP_COLORS[i % APP_COLORS.length] }} />
                {app} <span className="tnum font-mono text-fg">{c.limit}</span>
                <span className="text-dim">({c.history.length} changes)</span>
              </span>
            ))}
        </div>
        <div className="h-[150px]">
          <ConcurrencyChart concurrency={view.concurrency} endT={endT} version={version} />
        </div>
        <LatestConcurrencyReasons view={view} />
      </Panel>

      <Panel id="coordination" title="Coordination" subtitle="scheduler and verifier signals">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Lock conflicts" testId="stat-lock-conflicts" raw={view.lockConflicts} value={fmtInt(view.lockConflicts)} />
          <Stat label="Invalidations" testId="stat-invalidations" raw={view.invalidations} value={fmtInt(view.invalidations)} />
          <Stat label="Unconfirmed" raw={view.receipts.UNCONFIRMED} value={fmtInt(view.receipts.UNCONFIRMED)} tone={view.receipts.UNCONFIRMED ? "warn" : undefined} />
          <Stat label="Failed receipts" raw={view.receipts.FAILED} value={fmtInt(view.receipts.FAILED)} tone={view.receipts.FAILED ? "bad" : undefined} />
          <Stat label="Skipped" raw={view.receipts.SKIPPED} value={fmtInt(view.receipts.SKIPPED)} />
          <Stat label="Needs approval" raw={view.receipts.NEEDS_APPROVAL} value={fmtInt(view.receipts.NEEDS_APPROVAL)} />
        </div>
        <ActionMix view={view} />
      </Panel>

      <GroundTruth />
      <NetworkPanel store={store} />

      <Panel id="summary" title="Run summary" subtitle={view.summary ? "reported by the engine" : undefined} className="lg:col-span-2 2xl:col-span-3">
        <RunSummaryBlock view={view} />
      </Panel>
    </div>
  );
}

function ModelUsage({ view }: { view: RunView }) {
  const mc = view.modelCalls;
  const purposes = Object.entries(mc.byPurpose).sort((a, b) => b[1].count - a[1].count);
  const maxCount = Math.max(1, ...purposes.map(([, p]) => p.count));
  return (
    <Panel id="models" title="Model calls" subtitle={mc.failures ? `${mc.failures} failed` : undefined}>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Calls" raw={mc.count} value={fmtInt(mc.count)} sub={Object.entries(mc.byProvider).map(([p, n]) => `${p} ${n}`).join(" · ") || "—"} />
        <Stat label="Tokens in / out" raw={mc.inputTokens + mc.outputTokens} value={mc.count ? `${fmtTokens(mc.inputTokens)} / ${fmtTokens(mc.outputTokens)}` : "—"} />
        <Stat label="Model time" raw={mc.ms} value={mc.count ? fmtMs(mc.ms) : "—"} sub="summed latency" />
      </div>
      {purposes.length === 0 ? (
        <Empty className="mt-3">No model calls yet.</Empty>
      ) : (
        <table className="mt-3 w-full text-xs">
          <thead className="text-[11px] text-muted">
            <tr>
              <th scope="col" className="py-1 text-left font-medium">
                Purpose
              </th>
              <th scope="col" className="w-[40%] py-1" />
              <th scope="col" className="py-1 text-right font-medium">
                Calls
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Time
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {purposes.map(([purpose, p]) => (
              <tr key={purpose} className="border-t border-line">
                <td className="max-w-[140px] truncate py-1 pr-2 font-mono text-fg" title={purpose}>
                  {purpose}
                </td>
                <td className="py-1 pr-2">
                  <div className="h-1.5 rounded-sm bg-violet/70" style={{ width: `${(p.count / maxCount) * 100}%` }} />
                </td>
                <td className="tnum py-1 text-right font-mono text-fg">{fmtInt(p.count)}</td>
                <td className="tnum py-1 pl-2 text-right font-mono whitespace-nowrap text-muted">{fmtMs(p.ms)}</td>
                <td className="tnum py-1 pl-2 text-right font-mono whitespace-nowrap text-muted">{fmtUsd(p.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Recoveries({ view }: { view: RunView }) {
  const r = view.recoveries;
  const by = { started: 0, succeeded: 0, failed: 0, escalated: 0 };
  for (const x of r) by[x.phase]++;
  const capped = r.length >= 500;
  return (
    <Panel id="recoveries" title="Recoveries" subtitle={capped ? "showing the latest 500 events" : undefined}>
      <div className="grid grid-cols-4 gap-3">
        <Stat label="Started" testId="stat-recoveries" raw={by.started} value={fmtInt(by.started)} tone={by.started ? "warn" : undefined} />
        <Stat label="Succeeded" raw={by.succeeded} value={fmtInt(by.succeeded)} tone={by.succeeded ? "ok" : undefined} />
        <Stat label="Failed" raw={by.failed} value={fmtInt(by.failed)} tone={by.failed ? "bad" : undefined} />
        <Stat label="Escalated" raw={by.escalated} value={fmtInt(by.escalated)} />
      </div>
      {r.length === 0 ? (
        <Empty className="mt-3">No recovery events yet.</Empty>
      ) : (
        <ol className="mt-3 max-h-[200px] divide-y divide-line overflow-auto rounded border border-line" aria-label="Recovery feed">
          {r
            .slice(-60)
            .reverse()
            .map((x, i) => (
              <li key={`${x.t}:${i}`} className="grid grid-cols-[52px_auto_minmax(0,1fr)] items-start gap-2 px-2 py-1 text-[11px]">
                <span className="tnum font-mono text-dim">{fmtMs(x.t)}</span>
                <span className="flex items-center gap-1">
                  <Badge tone="neutral">L{x.level}</Badge>
                  <Badge tone={RECOVERY_TONE[x.phase]}>{x.phase}</Badge>
                </span>
                <span className="min-w-0">
                  <span className="text-fg">{x.reason}</span>
                  {x.detail && <span className="block truncate text-dim">{x.detail}</span>}
                  <span className="block font-mono text-[10px] text-dim">
                    {x.taskId}
                    {x.ms !== undefined ? ` · ${fmtMs(x.ms)}` : ""}
                    {x.propagatedTo ? ` · propagated to ${x.propagatedTo} tasks` : ""}
                  </span>
                </span>
              </li>
            ))}
        </ol>
      )}
    </Panel>
  );
}

function LatestConcurrencyReasons({ view }: { view: RunView }) {
  const latest = Object.entries(view.concurrency)
    .flatMap(([app, c]) => c.history.map((h) => ({ app, ...h })))
    .sort((a, b) => b.t - a.t)
    .slice(0, 4);
  if (latest.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5 text-[11px]">
      {latest.map((h, i) => (
        <li key={i} className="truncate text-muted">
          <span className="tnum font-mono text-dim">{fmtMs(h.t)}</span> {h.app} → <span className="font-mono text-fg">{h.limit}</span> · {h.reason}
        </li>
      ))}
    </ul>
  );
}

function ActionMix({ view }: { view: RunView }) {
  const types = Object.entries(view.actions.byType).sort((a, b) => b[1].count - a[1].count);
  if (types.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] text-muted">Actions by type</div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {types.map(([t, a]) => (
          <span key={t} className="text-[11px] text-muted">
            <span className="font-mono text-fg">{t}</span> {fmtInt(a.count)} <span className="text-dim">· avg {fmtMs(a.ms / Math.max(1, a.count))}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function RunSummaryBlock({ view }: { view: RunView }) {
  const s = view.summary;
  if (!s) return <Empty>The summary appears when the run completes.</Empty>;
  const stageEntries = Object.entries(s.stageMs ?? {});
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Wall" raw={s.wallMs} value={fmtMs(s.wallMs)} />
        <Stat label="Records verified" raw={s.recordsVerified} value={`${fmtInt(s.recordsVerified)} / ${fmtInt(s.records)}`} tone="ok" />
        <Stat label="Max concurrency" raw={s.maxConcurrency} value={fmtInt(s.maxConcurrency)} />
        <Stat label="Utilization" raw={s.workerUtilization} value={fmtPct(s.workerUtilization)} />
      </div>
      <KeyValue
        items={[
          ["Status", s.status],
          ["Strategy", s.strategy ?? "—"],
          ["Discovery / compile / execution", `${fmtMs(s.discoveryMs)} / ${fmtMs(s.compileMs)} / ${fmtMs(s.executionMs)}`],
          ["First action / first verified", `${fmtMs(s.firstActionMs)} / ${fmtMs(s.firstVerifiedMs)}`],
          ["Overlap · recovery time", `${fmtMs(s.overlapMs)} · ${fmtMs(s.recoveryMs)}`],
          ["Tasks verified / failed / unconfirmed", `${fmtInt(s.verified)} / ${fmtInt(s.failed)} / ${fmtInt(s.unconfirmed)}`],
          ["Skipped / needs approval", `${fmtInt(s.skipped)} / ${fmtInt(s.needsApproval)}`],
          ["Recoveries", fmtInt(s.recoveries)],
          ["Model calls · tokens", `${fmtInt(s.modelCalls)} · ${fmtTokens(s.inputTokens)} in / ${fmtTokens(s.outputTokens)} out`],
          ["Model cost", `${fmtUsd(s.modelCostUsd)} (${fmtUsd(s.recordsVerified ? s.modelCostUsd / s.recordsVerified : null)} / verified record)`],
          ["Throughput", `${fmtNum(s.recordsVerified / Math.max(1e-9, s.wallMs / 60_000))} records / min`],
        ]}
      />
      {stageEntries.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
          {stageEntries.map(([k, ms]) => (
            <span key={k}>
              {k} <span className="tnum font-mono text-fg">{fmtMs(ms)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
