"use client";

import type { BenchmarkResultFile, BenchmarkRunRecord } from "@overclock/contracts";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { engine, errorMessage } from "@/lib/api";
import { buildSections, shown, type Aggregate, type Measure, type Section } from "@/lib/benchmarks";
import { fmtDate, fmtInt, fmtMs, fmtNum, fmtPct, fmtUsd } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import { Badge, Empty, Panel, cx } from "../ui/primitives";

/** One benchmark result file: per-section aggregates, speedups, charts, and the raw runs. */
export function BenchmarkDetail({ name }: { name: string }) {
  const { data, error, loading } = usePolling((signal) => engine.benchmark(name, signal), 0, [name]);
  if (loading && !data) return <p className="text-xs text-dim">Loading {name}…</p>;
  if (error && !data) return <p className="text-xs text-bad">Could not load {name}: {errorMessage(error)}</p>;
  if (!data) return null;
  return <Detail file={data} name={name} />;
}

function Detail({ file, name }: { file: BenchmarkResultFile; name: string }) {
  const sections = useMemo(() => buildSections(file.runs), [file]);
  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/benchmarks" className="text-xs text-muted hover:text-fg">
            Benchmarks
          </Link>
          <span className="text-dim">/</span>
          <h1 className="font-mono text-sm font-semibold text-fg">{name}</h1>
          <Badge tone="accent">{file.suite}</Badge>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
          <span>{fmtDate(file.createdAt)}</span>
          <span>{fmtInt(file.runs.length)} runs</span>
          <span>
            {file.machine.platform} · {file.machine.cpus} CPUs · {file.machine.memoryGb} GB · Node {file.machine.node}
          </span>
          <span>
            spent {fmtUsd(file.spentUsd)} of {fmtUsd(file.budgetUsd)} budget
          </span>
        </div>
        {file.notes.length > 0 && (
          <ul className="mt-2 list-disc pl-4 text-xs text-muted">
            {file.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[11px] text-dim">Medians need at least 2 runs and p95 at least 5. A single run shows its own value, marked n=1. Accuracy comes from the arena checker.</p>
      </section>
      {sections.length === 0 ? <Empty>This file has no runs.</Empty> : sections.map((s) => <SectionView key={s.key} section={s} />)}
      <RawRuns runs={file.runs} />
    </div>
  );
}

function MeasureCell({ m, fmt }: { m: Measure; fmt: (n: number | null) => string }) {
  const v = shown(m);
  return (
    <span className="tnum font-mono">
      {fmt(v)}
      {m.single !== null && <sup className="ml-0.5 text-[9px] text-dim">n=1</sup>}
    </span>
  );
}

function SectionView({ section }: { section: Section }) {
  const title = `${section.condition} · ${section.cache}${section.holdout ? " · holdout" : ""}`;
  return (
    <Panel id={`bench-${section.key}`} title={title} subtitle={`${section.rows.length} configurations`} bodyClassName="flex flex-col gap-3 p-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-xs">
          <thead className="text-[11px] text-muted">
            <tr className="border-b border-line">
              {["Label", "Records", "n", "Wall median", "Wall p95", "First verified", "Accuracy", "Correct / min", "Cost", "Model calls", "Verified but wrong", "Dup writes", "Collateral", "Failed"].map((h, i) => (
                <th key={h} scope="col" className={cx("py-1.5 pr-3 font-medium whitespace-nowrap", i > 1 && "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((r) => (
              <AggregateRow key={`${r.label}|${r.records}`} r={r} />
            ))}
          </tbody>
        </table>
      </div>
      {section.speedups.length > 0 && <Speedups section={section} />}
      <div className="grid gap-3 md:grid-cols-2">
        <BarPanel title="Wall time (median)" rows={section.rows} value={(r) => shown(r.wall)} format={(v) => fmtMs(v)} color="#3d8bff" />
        <BarPanel title="Correct records / min (median)" rows={section.rows} value={(r) => shown(r.correctPerMin)} format={(v) => fmtNum(v)} color="#2fd27a" />
      </div>
    </Panel>
  );
}

function AggregateRow({ r }: { r: Aggregate }) {
  const bad = (n: number) => (n > 0 ? "text-bad" : "text-muted");
  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-1.5 pr-3 font-mono text-fg">{r.label}</td>
      <td className="tnum py-1.5 pr-3 font-mono text-muted">{fmtInt(r.records)}</td>
      <td className="tnum py-1.5 pr-3 text-right font-mono text-muted">{r.n}</td>
      <td className="py-1.5 pr-3 text-right text-fg">
        <MeasureCell m={r.wall} fmt={fmtMs} />
      </td>
      <td className="tnum py-1.5 pr-3 text-right font-mono text-muted">{fmtMs(r.wall.p95)}</td>
      <td className="py-1.5 pr-3 text-right text-fg">
        <MeasureCell m={r.firstVerified} fmt={fmtMs} />
      </td>
      <td className="py-1.5 pr-3 text-right text-fg" title={r.accuracy.checked ? `${r.accuracy.checked} checked, min ${fmtPct(r.accuracy.min, 1)}` : "no checker results"}>
        <MeasureCell m={r.accuracy} fmt={(v) => fmtPct(v, 1)} />
      </td>
      <td className="py-1.5 pr-3 text-right text-fg">
        <MeasureCell m={r.correctPerMin} fmt={(v) => fmtNum(v)} />
      </td>
      <td className="py-1.5 pr-3 text-right text-muted">
        <MeasureCell m={r.cost} fmt={fmtUsd} />
      </td>
      <td className="py-1.5 pr-3 text-right text-muted">
        <MeasureCell m={r.modelCalls} fmt={fmtInt} />
      </td>
      <td className={cx("tnum py-1.5 pr-3 text-right font-mono", bad(r.verifiedButWrong))}>{fmtInt(r.verifiedButWrong)}</td>
      <td className={cx("tnum py-1.5 pr-3 text-right font-mono", bad(r.duplicateWrites))}>{fmtInt(r.duplicateWrites)}</td>
      <td className={cx("tnum py-1.5 pr-3 text-right font-mono", bad(r.collateralWrites))}>{fmtInt(r.collateralWrites)}</td>
      <td className={cx("tnum py-1.5 pr-3 text-right font-mono", bad(r.failedRuns))}>{fmtInt(r.failedRuns)}</td>
    </tr>
  );
}

function Speedups({ section }: { section: Section }) {
  const fmtX = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}×`);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted">Speedups from medians (baseline ÷ Overclock)</div>
      <table className="text-left text-xs">
        <thead className="text-[11px] text-muted">
          <tr>
            {["Comparison", "Records", "n (E / baseline)", "Wall time", "First verified"].map((h, i) => (
              <th key={h} scope="col" className={cx("py-1 pr-5 font-medium", i > 1 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.speedups.map((s) => (
            <tr key={`${s.comparison}|${s.records}`} className="border-t border-line">
              <td className="py-1 pr-5 text-fg">
                {s.comparison} <span className="font-mono text-dim">({s.baselineLabel})</span>
              </td>
              <td className="tnum py-1 pr-5 font-mono text-muted">{fmtInt(s.records)}</td>
              <td className="tnum py-1 pr-5 text-right font-mono text-muted">
                {s.nE} / {s.nBase}
              </td>
              <td className="tnum py-1 pr-5 text-right font-mono text-accent-soft" title={s.wall === null ? "needs n ≥ 2 on both sides" : undefined}>
                {fmtX(s.wall)}
              </td>
              <td className="tnum py-1 pr-5 text-right font-mono text-ok" title={s.firstVerified === null ? "needs n ≥ 2 on both sides" : undefined}>
                {fmtX(s.firstVerified)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarPanel({ title, rows, value, format, color }: { title: string; rows: Aggregate[]; value: (r: Aggregate) => number | null; format: (v: number) => string; color: string }) {
  const data = rows.map((r) => ({ name: rows.some((x) => x.records !== r.records) ? `${r.label} (${r.records})` : r.label, v: value(r) })).filter((d): d is { name: string; v: number } => d.v !== null);
  return (
    <div className="rounded-md border border-line p-2">
      <div className="mb-1 text-[11px] text-muted">{title}</div>
      {data.length === 0 ? (
        <div className="py-6 text-center text-xs text-dim">No values.</div>
      ) : (
        <div style={{ height: Math.max(80, data.length * 28 + 24) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#161c23" horizontal={false} />
              <XAxis type="number" stroke="#3a4554" fontSize={10} tickLine={false} tickFormatter={(v: number) => format(v)} />
              <YAxis type="category" dataKey="name" width={150} stroke="#3a4554" fontSize={10.5} tickLine={false} tick={{ fill: "#9aa6b4" }} />
              <Tooltip cursor={{ fill: "#ffffff08" }} contentStyle={{ background: "#141a21", border: "1px solid #2a3440", borderRadius: 6, fontSize: 11 }} formatter={(v) => [format(Number(v)), title]} />
              <Bar dataKey="v" fill={color} radius={[0, 3, 3, 0]} isAnimationActive={false} label={{ position: "right", fill: "#e6ebf1", fontSize: 10, formatter: (v: unknown) => format(Number(v)) }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

const RAW_PAGE = 200;

function RawRuns({ runs }: { runs: BenchmarkRunRecord[] }) {
  const [limit, setLimit] = useState(RAW_PAGE);
  return (
    <Panel id="raw-runs" title="Raw runs" subtitle={`${runs.length} runs`} bodyClassName="p-0">
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[1200px] text-left text-[11.5px]">
          <thead className="sticky top-0 bg-raised text-[11px] text-muted">
            <tr>
              {["Label", "Condition", "Cache", "Holdout", "Records", "Trial", "Wall", "First verified", "Overlap", "Accuracy", "Correct/min", "Cost", "Calls", "VBW", "Dup", "Coll.", "Run", "Error"].map((h) => (
                <th key={h} scope="col" className="px-2 py-1.5 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, limit).map((r, i) => (
              <tr key={`${r.runId ?? "none"}-${i}`} className="border-t border-line font-mono">
                <td className="px-2 py-1 text-fg">{r.label}</td>
                <td className="px-2 py-1 text-muted">{r.condition}</td>
                <td className="px-2 py-1 text-muted">{r.cache}</td>
                <td className="px-2 py-1 text-muted">{r.holdout ? "yes" : "no"}</td>
                <td className="tnum px-2 py-1 text-muted">{r.records}</td>
                <td className="tnum px-2 py-1 text-muted">{r.trial}</td>
                <td className="tnum px-2 py-1 text-fg">{fmtMs(r.wallMs)}</td>
                <td className="tnum px-2 py-1 text-fg">{fmtMs(r.firstVerifiedMs)}</td>
                <td className="tnum px-2 py-1 text-muted">{fmtMs(r.overlapMs)}</td>
                <td className="tnum px-2 py-1 text-fg">{fmtPct(r.check?.accuracy, 1)}</td>
                <td className="tnum px-2 py-1 text-muted">{fmtNum(r.correctPerMin)}</td>
                <td className="tnum px-2 py-1 text-muted">{fmtUsd(r.costUsd)}</td>
                <td className="tnum px-2 py-1 text-muted">{fmtInt(r.modelCalls)}</td>
                <td className={cx("tnum px-2 py-1", r.verifiedButWrong ? "text-bad" : "text-muted")}>{r.verifiedButWrong}</td>
                <td className={cx("tnum px-2 py-1", r.duplicateWrites ? "text-bad" : "text-muted")}>{r.duplicateWrites}</td>
                <td className={cx("tnum px-2 py-1", r.collateralWrites ? "text-bad" : "text-muted")}>{r.collateralWrites}</td>
                <td className="px-2 py-1">
                  {r.runId ? (
                    <Link href={`/runs/${encodeURIComponent(r.runId)}`} className="text-accent-soft hover:underline">
                      {r.runId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="max-w-[240px] truncate px-2 py-1 text-bad" title={r.error}>
                  {r.error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {runs.length > limit && (
        <button type="button" className="w-full border-t border-line py-2 text-xs text-accent-soft hover:bg-raised" onClick={() => setLimit((l) => l + RAW_PAGE)}>
          Show {Math.min(RAW_PAGE, runs.length - limit)} more
        </button>
      )}
    </Panel>
  );
}
