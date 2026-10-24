"use client";

import Link from "next/link";
import { engine, errorMessage } from "@/lib/api";
import { fmtDate, fmtInt, fmtMs, fmtUsd } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import { ACTIVE_STATUSES, STATUS_TONE } from "@/lib/states";
import { Badge, Empty, Panel } from "../ui/primitives";

/** `/runs`: every run the engine knows about, newest first. Polls while any run is active. */
export function RunList() {
  const { data, error, loading } = usePolling((signal) => engine.listRuns(signal), 4000, []);
  const runs = [...(data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const active = runs.filter((r) => ACTIVE_STATUSES.has(r.status)).length;

  return (
    <Panel id="runs" title="Runs" subtitle={data ? `${runs.length} total${active ? ` · ${active} active` : ""}` : undefined} bodyClassName="p-0">
      {loading && !data ? (
        <p className="p-4 text-xs text-dim">Loading runs…</p>
      ) : error && !data ? (
        <p className="p-4 text-xs text-bad">Engine: {errorMessage(error)}</p>
      ) : runs.length === 0 ? (
        <div className="p-3">
          <Empty>No runs yet.</Empty>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-xs">
            <thead className="border-b border-line text-[11px] text-muted">
              <tr>
                {["Run", "Status", "Mode", "Goal", "Verified", "Wall time", "First verified", "Cost", "Created"].map((h) => (
                  <th key={h} scope="col" className={`px-3 py-2 font-medium ${["Verified", "Wall time", "First verified", "Cost"].includes(h) ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.runId} className="border-b border-line last:border-0 hover:bg-raised/60">
                  <td className="px-3 py-2 font-mono">
                    <Link href={`/runs/${encodeURIComponent(r.runId)}`} className="text-accent-soft hover:underline">
                      {r.runId}
                    </Link>
                    {r.label && <div className="text-[10.5px] text-dim">{r.label}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>
                  </td>
                  <td className="px-3 py-2 font-mono text-muted">{r.mode}</td>
                  <td className="max-w-[360px] px-3 py-2">
                    <span className="line-clamp-2 text-fg" title={r.goal}>
                      {r.goal}
                    </span>
                  </td>
                  <td className="tnum px-3 py-2 text-right font-mono text-fg">{r.summary ? `${fmtInt(r.summary.recordsVerified)} / ${fmtInt(r.summary.records)}` : "—"}</td>
                  <td className="tnum px-3 py-2 text-right font-mono text-fg">{fmtMs(r.summary?.wallMs)}</td>
                  <td className="tnum px-3 py-2 text-right font-mono text-muted">{fmtMs(r.summary?.firstVerifiedMs)}</td>
                  <td className="tnum px-3 py-2 text-right font-mono text-muted">{fmtUsd(r.summary?.modelCostUsd)}</td>
                  <td className="tnum px-3 py-2 whitespace-nowrap text-muted">{fmtDate(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
