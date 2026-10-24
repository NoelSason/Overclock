"use client";

import { useState } from "react";
import { engine, errorMessage } from "@/lib/api";
import { useSlices } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Badge, Button, Panel } from "../ui/primitives";

/** Pending human approvals (irreversible effects). Hidden until the run requests one. */
export function ApprovalsPanel({ store }: { store: RunStore }) {
  useSlices(store, ["approvals"]);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const all = Object.values(store.view.approvals);
  if (all.length === 0) return null;
  const pending = all.filter((a) => !a.resolved);
  const resolved = all.filter((a) => a.resolved);

  const decide = async (approvalId: string, approved: boolean) => {
    setSending((s) => ({ ...s, [approvalId]: true }));
    setError(null);
    try {
      await engine.approve(store.runId, { approvalId, approved });
    } catch (e) {
      setError(errorMessage(e));
      setSending((s) => ({ ...s, [approvalId]: false }));
    }
  };

  return (
    <Panel id="approvals" title="Approvals" subtitle={pending.length ? `${pending.length} waiting` : "none waiting"} className={pending.length ? "border-violet/50" : undefined}>
      <ul className="flex flex-col gap-2">
        {pending.map((a) => (
          <li key={a.approvalId} className="rounded-md border border-violet/40 bg-violet/5 p-2.5">
            <p className="text-xs text-fg">{a.description}</p>
            <div className="mt-1 font-mono text-[10.5px] text-dim">
              task {a.taskId} · node {a.nodeId}
            </div>
            <div className="mt-2 flex gap-1.5">
              <Button size="sm" variant="primary" disabled={sending[a.approvalId]} onClick={() => void decide(a.approvalId, true)}>
                Approve
              </Button>
              <Button size="sm" variant="danger" disabled={sending[a.approvalId]} onClick={() => void decide(a.approvalId, false)}>
                Deny
              </Button>
              {sending[a.approvalId] && <span className="self-center text-[11px] text-dim">Waiting for engine…</span>}
            </div>
          </li>
        ))}
        {resolved.map((a) => (
          <li key={a.approvalId} className="flex items-center gap-2 text-[11px] text-muted">
            <Badge tone={a.approved ? "ok" : "bad"}>{a.approved ? "approved" : "denied"}</Badge>
            <span className="truncate">{a.description}</span>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-xs text-bad">
          {error}
        </p>
      )}
    </Panel>
  );
}
