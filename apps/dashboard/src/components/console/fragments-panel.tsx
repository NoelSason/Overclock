"use client";

import type { FragmentState, RunView } from "@overclock/contracts";
import { FRAGMENT_STYLE } from "@/lib/derive";
import { fmtMs } from "@/lib/format";
import { useSlices } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Empty, Panel, cx } from "../ui/primitives";

const ORDER: FragmentState[] = ["canary", "deferred", "validated", "compiled", "released", "rejected", "revised"];

function FragmentChip({ state }: { state: FragmentState }) {
  const s = FRAGMENT_STYLE[state];
  return (
    <span className="inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10.5px] font-medium" style={{ color: s.color, borderColor: `${s.color}66`, background: `${s.color}14`, borderStyle: s.dashed ? "dashed" : "solid" }}>
      {s.label}
    </span>
  );
}

const isWriteEffect = (effect: string | undefined) => effect === "remote-write" || effect === "irreversible" || effect === "write";
const EFFECT_LABEL: Record<string, string> = { read: "read", "local-write": "local", "remote-write": "write", irreversible: "irreversible", write: "write" };

/** Gate text for a fragment that is not yet running everywhere. */
function gateText(f: RunView["fragments"][string]): string | null {
  const isWrite = isWriteEffect(f.effect);
  switch (f.state) {
    case "deferred":
      return `${isWrite ? "write" : "fragment"} deferred: ${f.reason ?? "waiting on a safety gate"}`;
    case "canary":
      return f.reason && /canary/i.test(f.reason) ? f.reason : `canary verifying${f.reason ? `: ${f.reason}` : ""}`;
    case "compiled":
      return f.reason ? `awaiting validation: ${f.reason}` : "awaiting validation";
    case "validated":
      return f.reason ? `awaiting release: ${f.reason}` : "awaiting release";
    default:
      return f.reason ?? null;
  }
}

/** Incrementally compiled fragments and the gate each one is waiting on. */
export function FragmentsPanel({ store }: { store: RunStore }) {
  useSlices(store, ["fragments"]);
  const view = store.view;
  const fragments = Object.values(view.fragments).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.history[0]?.t ?? 0) - (b.history[0]?.t ?? 0));
  const counts = new Map<FragmentState, number>();
  for (const f of fragments) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);

  return (
    <Panel
      id="fragments"
      title="Fragments"
      subtitle={fragments.length ? `${fragments.length} compiled incrementally` : undefined}
      actions={
        <div className="flex flex-wrap gap-1">
          {ORDER.filter((s) => counts.has(s)).map((s) => (
            <span key={s} className="inline-flex items-center gap-1 text-[11px] text-muted">
              <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: FRAGMENT_STYLE[s].color }} />
              <span data-testid={`fragments-${s}`} className="tnum font-mono text-fg">
                {counts.get(s)}
              </span>
              {s}
            </span>
          ))}
        </div>
      }
      bodyClassName="p-0"
    >
      {fragments.length === 0 ? (
        <div className="p-3">
          <Empty>No fragments yet. Streaming mode releases compiled fragments here as discovery continues.</Empty>
        </div>
      ) : (
        <ul className="max-h-[300px] divide-y divide-line overflow-auto">
          {fragments.map((f) => {
            const gate = gateText(f);
            const isWrite = isWriteEffect(f.effect);
            return (
              <li key={f.fragmentId} className={cx("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2.5 px-3 py-2", f.state === "revised" && "opacity-60")}>
                <FragmentChip state={f.state} />
                <div className="min-w-0">
                  <div className={cx("truncate text-xs text-fg", f.state === "revised" && "line-through")} title={f.label}>
                    {f.label}
                  </div>
                  {gate && <div className={cx("text-[11px]", f.state === "deferred" ? "text-violet" : f.state === "rejected" ? "text-bad" : "text-muted")}>{gate}</div>}
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1 font-mono text-[10px] text-dim" aria-label="State history">
                    {f.history.map((h, i) => (
                      <span key={i} title={h.reason}>
                        {i > 0 && "→ "}
                        <span style={{ color: FRAGMENT_STYLE[h.state].color }}>{h.state}</span> {fmtMs(h.t)}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-0.5 text-[10.5px]">
                  {f.effect && <span className={cx("font-medium uppercase", isWrite ? "text-warn" : "text-accent-soft")}>{EFFECT_LABEL[f.effect] ?? f.effect}</span>}
                  <span className="font-mono text-dim">
                    {f.phaseId} · {f.segmentIds.length} seg
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
