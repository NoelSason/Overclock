"use client";

import { useEffect, useState } from "react";
import { SURPRISE_KINDS, arena, engine, errorMessage, type ArenaApp, type SurpriseKind } from "@/lib/api";
import { Drawer } from "../ui/drawer";
import { Select } from "../ui/form";
import { JsonView } from "../ui/json-view";
import { Badge, Button, KeyValue } from "../ui/primitives";
import type { ArtifactRef } from "./swarm-map";

type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "error"; error: string };

function useFetch<T>(load: ((signal: AbortSignal) => Promise<T>) | null, key: string | null): Load<T> | null {
  const [result, setResult] = useState<{ key: string; value: Load<T> } | null>(null);
  useEffect(() => {
    if (!load || key === null) return;
    const ctrl = new AbortController();
    load(ctrl.signal)
      .then((data) => !ctrl.signal.aborted && setResult({ key, value: { state: "ok", data } }))
      .catch((e: unknown) => !ctrl.signal.aborted && setResult({ key, value: { state: "error", error: errorMessage(e) } }));
    return () => ctrl.abort();
    // `key` identifies the request; `load` is recreated each render.
  }, [key]);
  if (key === null) return null;
  return result?.key === key ? result.value : { state: "loading" };
}

/** Full artifact JSON for an `agent.artifact` summary. */
export function ArtifactDrawer({ runId, artifact, onClose }: { runId: string; artifact: ArtifactRef | null; onClose: () => void }) {
  const res = useFetch<unknown>(artifact ? (signal) => engine.artifact(runId, artifact.artifact.artifactId, signal) : null, artifact ? `${runId}/${artifact.artifact.artifactId}` : null);
  const a = artifact?.artifact;
  return (
    <Drawer open={artifact !== null} onClose={onClose} title={a?.title ?? "Artifact"} subtitle={artifact ? `${a?.kind} · from ${artifact.agentLabel}` : undefined}>
      {a && (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] text-fg">{a.summary}</p>
          {a.stats && <KeyValue items={Object.entries(a.stats).map(([k, v]) => [k, String(v)])} />}
          {res?.state === "loading" && <p className="text-xs text-dim">Loading artifact…</p>}
          {res?.state === "error" && <p className="text-xs text-bad">Could not load artifact: {res.error}</p>}
          {res?.state === "ok" && <JsonView value={res.data} />}
        </div>
      )}
    </Drawer>
  );
}

/** Compiled program (template graph + IR) as returned by `/program`. */
export function ProgramDrawer({ runId, open, onClose }: { runId: string; open: boolean; onClose: () => void }) {
  const res = useFetch<unknown>(open ? (signal) => engine.program(runId, signal) : null, open ? runId : null);
  return (
    <Drawer open={open} onClose={onClose} title="Compiled program" subtitle="template graph and execution IR">
      {res?.state === "loading" && <p className="text-xs text-dim">Loading program…</p>}
      {res?.state === "error" && <p className="text-xs text-bad">{res.error}</p>}
      {res?.state === "ok" && <JsonView value={res.data} />}
    </Drawer>
  );
}

const SURPRISE_LABEL: Record<SurpriseKind, { label: string; detail: string }> = {
  "rename-save": { label: "Rename Save button", detail: "Changes the save button's text" },
  "confirm-modal": { label: "Confirm modal", detail: "Adds a confirmation dialog before saving" },
  announcement: { label: "Announcement modal", detail: "Interstitial on first page view" },
  latency: { label: "Inject latency", detail: "Slower responses with jitter" },
  "partial-failure": { label: "Partial failures", detail: "Some writes fail before or after commit" },
  "fields-in-tab": { label: "Fields in tab", detail: "Moves the edit form behind a tab" },
  "shuffle-fields": { label: "Shuffle fields", detail: "Reorders form fields" },
  "concurrency-limit": { label: "Concurrency limit", detail: "429s above a request cap" },
  clear: { label: "Clear all", detail: "Removes every surprise" },
};

/** Live-demo interference: arena judge surprises and edits, with the raw response shown. */
export function InterferenceDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [app, setApp] = useState<ArenaApp>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<{ action: string; ok: boolean; body: unknown } | null>(null);

  const run = async (action: string, call: () => Promise<unknown>) => {
    setBusy(action);
    try {
      setLast({ action, ok: true, body: await call() });
    } catch (e) {
      setLast({ action, ok: false, body: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Interference" subtitle="Judge controls: change the arena apps while the run executes" width="min(520px, 100vw)">
      <div className="flex flex-col gap-4">
        <div className="flex items-end gap-2">
          <label htmlFor="interference-app" className="flex flex-col gap-1 text-[11px] font-medium text-muted">
            Target app
            <Select id="interference-app" value={app} onChange={(e) => setApp(e.target.value as ArenaApp)} className="w-40">
              <option value="all">All apps</option>
              <option value="CRM">CRM</option>
              <option value="Orders">Orders</option>
              <option value="Support">Support</option>
            </Select>
          </label>
        </div>
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {SURPRISE_KINDS.map((k) => (
            <li key={k}>
              <button type="button" disabled={busy !== null} onClick={() => void run(`${k} · ${app}`, () => arena.surprise(k, app))} className="w-full rounded-md border border-line bg-raised px-2.5 py-2 text-left hover:border-accent/50 disabled:opacity-50">
                <div className="text-xs font-medium text-fg">{SURPRISE_LABEL[k].label}</div>
                <div className="text-[11px] text-dim">{SURPRISE_LABEL[k].detail}</div>
              </button>
            </li>
          ))}
        </ul>
        <Button onClick={() => void run("edit unprocessed record", () => arena.editUnprocessed())} disabled={busy !== null}>
          Edit an unprocessed record
        </Button>
        {busy && <p className="text-xs text-dim">Sending {busy}…</p>}
        {last && (
          <div className="rounded-md border border-line p-2.5">
            <div className="mb-2 flex items-center gap-2 text-xs">
              <Badge tone={last.ok ? "ok" : "bad"}>{last.ok ? "applied" : "error"}</Badge>
              <span className="text-muted">{last.action}</span>
            </div>
            {typeof last.body === "string" ? <p className="text-xs text-bad">{last.body}</p> : <JsonView value={last.body} />}
          </div>
        )}
      </div>
    </Drawer>
  );
}
