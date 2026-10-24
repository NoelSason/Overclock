"use client";

import type { RunView } from "@overclock/contracts";
import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtMs } from "@/lib/format";

const AXIS = { stroke: "#3a4554", fontSize: 10, tickLine: false } as const;
const TOOLTIP = {
  contentStyle: { background: "#141a21", border: "1px solid #2a3440", borderRadius: 6, fontSize: 11, color: "#e6ebf1" },
  labelStyle: { color: "#9aa6b4" },
  itemStyle: { padding: 0 },
} as const;

const secLabel = (ms: number) => fmtMs(ms);

/** Verified receipts per bin (as a per-minute rate) plus the cumulative count. */
export function ThroughputChart({ timeline, endT, version }: { timeline: number[]; endT: number; version: number }) {
  const data = useMemo(() => {
    if (timeline.length === 0) return [];
    const span = Math.max(1000, endT);
    const binMs = Math.max(1000, Math.ceil(span / 90 / 1000) * 1000);
    const bins = Math.ceil(span / binMs) + 1;
    const counts = new Array<number>(bins).fill(0);
    for (const t of timeline) counts[Math.min(bins - 1, Math.floor(t / binMs))]!++;
    let cum = 0;
    return counts.map((c, i) => {
      cum += c;
      return { t: i * binMs, rate: (c / binMs) * 60_000, cumulative: cum };
    });
    // `version` changes when the (in-place mutated) timeline grows.
  }, [timeline, endT, version]);
  if (data.length === 0) return <div className="flex h-full items-center justify-center text-xs text-dim">No verified writes yet.</div>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="tp" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2fd27a" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#2fd27a" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#161c23" vertical={false} />
        <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tickFormatter={secLabel} {...AXIS} />
        <YAxis yAxisId="rate" {...AXIS} width={44} allowDecimals={false} />
        <YAxis yAxisId="cum" orientation="right" {...AXIS} width={40} allowDecimals={false} />
        <Tooltip {...TOOLTIP} labelFormatter={(v) => fmtMs(Number(v))} formatter={(value, name) => [name === "rate" ? `${Number(value).toFixed(1)} / min` : String(value), name === "rate" ? "throughput" : "verified total"]} />
        <Area yAxisId="rate" type="monotone" dataKey="rate" stroke="#2fd27a" strokeWidth={1.5} fill="url(#tp)" isAnimationActive={false} />
        <Line yAxisId="cum" type="monotone" dataKey="cumulative" stroke="#3d8bff" dot={false} strokeWidth={1.25} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

const APP_COLORS = ["#3d8bff", "#2fd27a", "#f2b13c", "#b28cff", "#38c6e8", "#ff8a3d"];

/** Concurrency limit per app over time (step chart from `concurrency` events). */
export function ConcurrencyChart({ concurrency, endT, version }: { concurrency: RunView["concurrency"]; endT: number; version: number }) {
  const { data, apps } = useMemo(() => {
    const apps = Object.keys(concurrency).sort();
    const times = new Set<number>([endT]);
    for (const a of apps) for (const h of concurrency[a]!.history) times.add(h.t);
    const sorted = [...times].sort((a, b) => a - b);
    const data = sorted.map((t) => {
      const row: Record<string, number | null> = { t };
      for (const a of apps) {
        const hist = concurrency[a]!.history;
        let v: number | null = null;
        for (const h of hist) if (h.t <= t) v = h.limit;
        row[a] = v;
      }
      return row;
    });
    return { data, apps };
    // `version` changes when the (in-place mutated) history grows.
  }, [concurrency, endT, version]);
  if (apps.length === 0) return <div className="flex h-full items-center justify-center text-xs text-dim">No concurrency decisions yet.</div>;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="#161c23" vertical={false} />
        <XAxis dataKey="t" type="number" domain={[0, "dataMax"]} tickFormatter={secLabel} {...AXIS} />
        <YAxis {...AXIS} width={40} allowDecimals={false} />
        <Tooltip {...TOOLTIP} labelFormatter={(v) => fmtMs(Number(v))} />
        {apps.map((a, i) => (
          <Line key={a} type="stepAfter" dataKey={a} stroke={APP_COLORS[i % APP_COLORS.length]} dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export { APP_COLORS };
