"use client";

import type { CandidateView, CostEstimate, RunView } from "@overclock/contracts";
import { fmtMs, fmtUsd } from "@/lib/format";
import { useSlices } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Badge, Empty, Panel, cx } from "../ui/primitives";

const PARTS: { key: keyof Pick<CostEstimate, "modelMs" | "browserCriticalPathMs" | "recoveryMs" | "coordinationMs" | "verificationMs">; label: string; color: string }[] = [
  { key: "modelMs", label: "model", color: "#b28cff" },
  { key: "browserCriticalPathMs", label: "browser critical path", color: "#3d8bff" },
  { key: "recoveryMs", label: "recovery", color: "#f2b13c" },
  { key: "coordinationMs", label: "coordination", color: "#6c7889" },
  { key: "verificationMs", label: "verification", color: "#2fd27a" },
];

/** Strategy candidates with their simulated cost, the selection and why, and online re-optimization. */
export function StrategyPanel({ store }: { store: RunStore }) {
  useSlices(store, ["candidates", "program"]);
  const view = store.view;
  const ranking = new Map((view.selection?.ranking ?? []).map((r, i) => [r.candidateId, i + 1]));
  const candidates = Object.values(view.candidates).sort((a, b) => (ranking.get(a.id) ?? 99) - (ranking.get(b.id) ?? 99));
  const maxTotal = Math.max(1, ...candidates.map((c) => c.estimate?.totalMs ?? 0));
  const selected = view.selection ? view.candidates[view.selection.candidateId] : undefined;

  return (
    <Panel id="strategy" title="Strategy" subtitle={candidates.length ? `${candidates.length} candidates` : undefined} bodyClassName="flex flex-col gap-3 p-3">
      <div className="rounded-md border border-line bg-raised/60 p-2.5">
        <div className="text-[11px] text-muted">Current strategy</div>
        <div className="mt-0.5 text-[13px] font-medium text-fg">{selected?.name ?? view.program?.strategy ?? "—"}</div>
        {view.selection ? <p className="mt-1 text-xs text-muted">{view.selection.reason}</p> : <p className="mt-1 text-xs text-dim">No strategy selected yet.</p>}
      </div>
      <ReoptTimeline view={view} />
      {candidates.length === 0 ? <Empty>No strategy candidates proposed yet.</Empty> : <ul className="flex flex-col gap-2">{candidates.map((c) => <Candidate key={c.id} c={c} rank={ranking.get(c.id)} maxTotal={maxTotal} />)}</ul>}
    </Panel>
  );
}

function ReoptTimeline({ view }: { view: RunView }) {
  if (view.reopt.length === 0) return <div className="text-xs text-dim">Online re-optimization: no decisions yet.</div>;
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted">Re-optimization decisions</div>
      <ol className="relative flex flex-col gap-1.5 border-l border-line pl-3">
        {[...view.reopt].reverse().map((d, i) => (
          <li key={`${d.t}:${i}`} className="relative">
            <span aria-hidden className={cx("absolute top-1.5 -left-[16.5px] h-2 w-2 rounded-full border", d.switched ? "border-accent bg-accent" : "border-line-strong bg-panel")} />
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="tnum font-mono text-dim">{fmtMs(d.t)}</span>
              <Badge tone={d.switched ? "accent" : "neutral"}>{d.switched ? "switched" : "kept"}</Badge>
              {d.alternative && <span className="truncate text-muted">{d.switched ? "→" : "vs"} {d.alternative}</span>}
            </div>
            <p className="text-xs text-fg">{d.reason}</p>
            <div className="tnum font-mono text-[10.5px] text-dim">
              remaining {fmtMs(d.remainingMs)} · alternative {fmtMs(d.alternativeMs)}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Candidate({ c, rank, maxTotal }: { c: CandidateView; rank: number | undefined; maxTotal: number }) {
  const e = c.estimate;
  return (
    <li className={cx("rounded-md border p-2.5", c.selected ? "border-accent/60 bg-accent/5" : "border-line bg-sunken/60")} aria-current={c.selected ? "true" : undefined}>
      <div className="flex items-center gap-1.5">
        {rank !== undefined && <span className="tnum font-mono text-[11px] text-dim">#{rank}</span>}
        <span className="truncate text-[13px] font-medium text-fg">{c.name}</span>
        <span className="ml-auto flex gap-1">
          {c.selected && <Badge tone="accent">selected</Badge>}
          {c.valid === true && <Badge tone="ok">valid</Badge>}
          {c.valid === false && <Badge tone="bad">invalid</Badge>}
          {c.valid === null && <Badge>evaluating</Badge>}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">{c.summary}</p>
      {e && (
        <div className="mt-2">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-muted">Estimated total</span>
            <span className="tnum font-mono text-fg">
              {fmtMs(e.totalMs)} · {e.workers} workers · {fmtUsd(e.modelCostUsd)}
            </span>
          </div>
          <div className="mt-1 flex h-2 overflow-hidden rounded-sm bg-sunken" style={{ width: `${Math.max(4, (e.totalMs / maxTotal) * 100)}%` }} role="img" aria-label={`Estimate breakdown for ${c.name}`}>
            {PARTS.map((p) => (e[p.key] > 0 ? <span key={p.key} style={{ width: `${(e[p.key] / Math.max(1, e.totalMs)) * 100}%`, background: p.color }} title={`${p.label} ${fmtMs(e[p.key])}`} /> : null))}
          </div>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
            {PARTS.map((p) => (
              <div key={p.key} className="flex items-center gap-1.5">
                <span aria-hidden className="h-1.5 w-1.5 rounded-sm" style={{ background: p.color }} />
                <dt className="truncate text-muted">{p.label}</dt>
                <dd className="tnum ml-auto font-mono text-fg">{fmtMs(e[p.key])}</dd>
              </div>
            ))}
          </dl>
          {e.basis.length > 0 && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[11px] text-muted hover:text-fg">
                Basis: {e.basis.filter((b) => b.source === "measured").length} measured, {e.basis.filter((b) => b.source !== "measured").length} estimated/default
              </summary>
              <table className="mt-1 w-full text-[11px]">
                <tbody>
                  {e.basis.map((b) => (
                    <tr key={b.input} className="border-t border-line">
                      <td className="py-0.5 text-muted">{b.input}</td>
                      <td className="py-0.5">
                        <Badge tone={b.source === "measured" ? "ok" : b.source === "estimated" ? "warn" : "neutral"}>{b.source}</Badge>
                      </td>
                      <td className="tnum py-0.5 text-right font-mono text-fg">{Number.isInteger(b.value) ? b.value : b.value.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
      {c.issues.length > 0 && (
        <ul className="mt-1.5 list-disc pl-4 text-[11px] text-warn">
          {c.issues.map((i, k) => (
            <li key={k}>{i}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
