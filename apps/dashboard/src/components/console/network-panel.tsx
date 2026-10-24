"use client";

import { fmtMs } from "@/lib/format";
import { useSlices } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Badge, Panel } from "../ui/primitives";

/**
 * Overclock Network activity (shared capability lookups, imports, publishes, repairs). Hidden
 * unless the run emitted `network.*` events, i.e. it used a network knowledge policy.
 */
export function NetworkPanel({ store }: { store: RunStore }) {
  useSlices(store, ["network"]);
  const n = store.view.network;
  if (!n) return null;
  const total = n.lookups.length + n.imports.length + n.publishes.length + n.repairs.length + n.updates.length;
  if (total === 0) return null;
  const feed = [
    ...n.lookups.map((x) => ({ t: x.t, kind: "lookup", text: `${x.outcome} via ${x.source} · ${x.candidates} candidate${x.candidates === 1 ? "" : "s"}${x.capabilityId ? ` · ${x.capabilityId} v${x.version ?? "?"}` : ""}`, ms: x.ms })),
    ...n.imports.map((x) => ({ t: x.t, kind: "import", text: `${x.capabilityId} v${x.version} ${x.outcome} · ${x.bound} bound, ${x.unbound} unbound · fetch ${fmtMs(x.fetchMs)}, rebind ${fmtMs(x.rebindMs)}${x.avoided ? ` · avoided ≈${x.avoided.modelCalls} model calls, ≈${fmtMs(x.avoided.discoveryMs)} discovery (estimated)` : ""}`, ms: undefined })),
    ...n.publishes.map((x) => ({ t: x.t, kind: "publish", text: `${x.capabilityId} v${x.version} ${x.state} · ${x.redactions} redactions · ${x.bytes} bytes${x.rejected ? ` · rejected: ${x.rejected}` : ""}`, ms: x.ms })),
    ...n.repairs.map((x) => ({ t: x.t, kind: "repair", text: `${x.capabilityId} job ${x.jobId} ${x.phase}${x.detail ? ` · ${x.detail}` : ""}`, ms: x.ms })),
    ...n.updates.map((x) => ({ t: x.t, kind: "update", text: `${x.capabilityId} v${x.version} ${x.state}${x.propagationMs !== undefined ? ` · propagated in ${fmtMs(x.propagationMs)}` : ""}`, ms: undefined })),
  ].sort((a, b) => b.t - a.t);
  return (
    <Panel id="network" title="Knowledge network" subtitle={`${n.lookups.length} lookups · ${n.imports.length} imports · ${n.publishes.length} publishes`}>
      <ol className="max-h-[220px] divide-y divide-line overflow-auto rounded border border-line">
        {feed.slice(0, 80).map((x, i) => (
          <li key={i} className="grid grid-cols-[52px_auto_minmax(0,1fr)] items-start gap-2 px-2 py-1 text-[11px]">
            <span className="tnum font-mono text-dim">{fmtMs(x.t)}</span>
            <Badge tone={x.kind === "import" ? "ok" : x.kind === "repair" ? "warn" : x.kind === "publish" ? "violet" : "accent"}>{x.kind}</Badge>
            <span className="text-fg">
              {x.text}
              {x.ms !== undefined && <span className="text-dim"> · {fmtMs(x.ms)}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
