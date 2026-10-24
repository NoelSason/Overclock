"use client";

import Link from "next/link";
import { engine, errorMessage } from "@/lib/api";
import { fmtDate, fmtInt } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import { Empty, Panel } from "../ui/primitives";

/** `/benchmarks`: result files written by the benchmark harness. */
export function BenchmarkList() {
  const { data, error, loading } = usePolling((signal) => engine.benchmarks(signal), 0, []);
  const files = [...(data ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Panel id="benchmarks" title="Benchmark results" subtitle={data ? `${files.length} files` : undefined} bodyClassName="p-0">
      {loading && !data ? (
        <p className="p-4 text-xs text-dim">Loading results…</p>
      ) : error && !data ? (
        <p className="p-4 text-xs text-bad">Engine: {errorMessage(error)}</p>
      ) : files.length === 0 ? (
        <div className="p-3">
          <Empty>No benchmark results yet. Run the benchmark suite to produce result files.</Empty>
        </div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-line text-[11px] text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                File
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Suite
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Runs
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.name} className="border-b border-line last:border-0 hover:bg-raised/60">
                <td className="px-3 py-2 font-mono">
                  <Link href={`/benchmarks/${encodeURIComponent(f.name)}`} className="text-accent-soft hover:underline">
                    {f.name}
                  </Link>
                </td>
                <td className="px-3 py-2 text-fg">{f.suite}</td>
                <td className="tnum px-3 py-2 text-right font-mono text-fg">{fmtInt(f.runs)}</td>
                <td className="px-3 py-2 text-muted">{fmtDate(f.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
