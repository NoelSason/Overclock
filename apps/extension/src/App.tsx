import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyEvent, createRunView, type RunEvent, type RunView } from "@overclock/contracts";
import { ApiError, engineOrigin, OverclockApi, pair, type EngineStatus, type PreviewStep, type RunResult, type WorkflowApp, type WorkflowPreview, type WorkflowSummary } from "./api";
import { parseRecordsCsv, type ParsedRecords } from "./csv";
import { eventLine, fmtMs, fmtUsd, outcomeLabel, recordProgress, statusText, type Tone } from "./format";
import { clearConnection, loadConnection, saveConnection, savedOrigin, type Connection } from "./storage";

type Screen = "compose" | "preview" | "run";

export function App() {
  const [conn, setConn] = useState<Connection | null | undefined>(undefined);
  useEffect(() => {
    void loadConnection().then(setConn);
  }, []);
  const api = useMemo(() => (conn ? new OverclockApi(conn.origin, conn.token) : null), [conn]);
  if (conn === undefined) return <div className="boot" />;
  if (!conn || !api)
    return (
      <Connect
        onConnected={async (c) => {
          await saveConnection(c);
          setConn(c);
        }}
      />
    );
  return (
    <Main
      api={api}
      onDisconnect={async () => {
        await clearConnection();
        setConn(null);
      }}
    />
  );
}

// ------------------------------------------------------------------ connect

function Connect({ onConnected }: { onConnected: (c: Connection) => Promise<void> }) {
  const [origin, setOrigin] = useState("http://127.0.0.1:4000");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void savedOrigin().then(setOrigin);
  }, []);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = engineOrigin(origin);
      const s = await pair(o, code);
      await onConnected({ origin: o, token: s.token, expiresAt: s.expiresAt });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page connect">
      <Brand />
      <h1 className="hero">
        Describe it. Approve it.
        <br />
        Overclock runs it.
      </h1>
      <p className="lede">Teach your browser a task once, then run it again on new records at machine speed, with every change checked by re-reading the page.</p>
      <div className="card">
        <h2>Connect to your Overclock engine</h2>
        <p className="muted">The engine runs on this computer and prints a pairing code when it starts: “Chrome extension pairing code: XXXX-XXXX-XXXX”.</p>
        <label className="field">
          <span>Engine address</span>
          <input value={origin} onChange={(e) => setOrigin(e.target.value)} spellCheck={false} />
        </label>
        <label className="field">
          <span>Pairing code</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" spellCheck={false} autoFocus onKeyDown={(e) => e.key === "Enter" && code && void submit()} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={!code || busy} onClick={() => void submit()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <p className="fine">The extension keeps the session only in memory until Chrome closes. It never stores API keys or site passwords.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- main

function Main({ api, onDisconnect }: { api: OverclockApi; onDisconnect: () => Promise<void> }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [library, setLibrary] = useState<WorkflowSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [screen, setScreen] = useState<Screen>("compose");
  const [selected, setSelected] = useState<WorkflowSummary | null>(null);
  const [instructions, setInstructions] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [records, setRecords] = useState<{ name: string; parsed: ParsedRecords } | null>(null);
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, w] = await Promise.all([api.status(), api.workflows()]);
      setStatus(s);
      setLibrary(w.workflows);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onDisconnect();
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [api, onDisconnect]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = (w: WorkflowSummary | null) => {
    setSelected(w);
    setInstructions(w?.instructions ?? "");
    setApps(w ? w.applications.map((a) => a.name) : []);
    setRecords(null);
  };

  return (
    <div className="page">
      <header className="top">
        <Brand />
        <span className={`dot ${status ? "ok" : loadError ? "bad" : ""}`} title={status ? "Connected" : (loadError ?? "Connecting")} />
        <button className="ghost small" onClick={() => void onDisconnect()}>
          Disconnect
        </button>
      </header>
      {loadError && (
        <div className="banner bad">
          {loadError}{" "}
          <button className="link" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      )}
      {screen === "compose" && (
        <Compose
          api={api}
          status={status}
          library={library}
          selected={selected}
          onChoose={choose}
          instructions={instructions}
          setInstructions={setInstructions}
          apps={apps}
          setApps={setApps}
          records={records}
          setRecords={setRecords}
          onPreview={(p) => {
            setPreview(p);
            setScreen("preview");
          }}
        />
      )}
      {screen === "preview" && preview && records && (
        <PreviewScreen
          api={api}
          preview={preview}
          request={{ ...(selected ? { workflowId: selected.id } : { instructions, applications: apps }), records: records.parsed.records }}
          onBack={() => setScreen("compose")}
          onStarted={(id) => {
            setRunId(id);
            setScreen("run");
          }}
        />
      )}
      {screen === "run" && runId && preview && records && (
        <RunScreen
          api={api}
          runId={runId}
          preview={preview}
          records={records.parsed.records}
          visibleBrowser={status?.browser.visible ?? false}
          onDone={() => void refresh()}
          onAgain={() => {
            setRecords(null);
            setRunId(null);
            setScreen("compose");
            void refresh().then(() => undefined);
          }}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#7aa2ff" />
            <stop offset="1" stopColor="#38d39f" />
          </linearGradient>
        </defs>
        <rect x="1" y="1" width="22" height="22" rx="6" fill="url(#g)" />
        <path d="M7 8l4 4-4 4M12.5 8l4 4-4 4" stroke="#0b0d12" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Overclock</span>
    </div>
  );
}

// ---------------------------------------------------------------- compose

function Compose(p: {
  api: OverclockApi;
  status: EngineStatus | null;
  library: WorkflowSummary[] | null;
  selected: WorkflowSummary | null;
  onChoose: (w: WorkflowSummary | null) => void;
  instructions: string;
  setInstructions: (s: string) => void;
  apps: string[];
  setApps: (a: string[]) => void;
  records: { name: string; parsed: ParsedRecords } | null;
  setRecords: (r: { name: string; parsed: ParsedRecords } | null) => void;
  onPreview: (p: WorkflowPreview) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const expected = p.selected?.recordFields;
  const runnable = (p.library ?? []).filter((w) => w.runnable);
  const other = (p.library ?? []).filter((w) => !w.runnable);
  const loadFile = async (f: File) => {
    const text = await f.text();
    p.setRecords({ name: f.name, parsed: parseRecordsCsv(text, expected && expected.length ? expected : undefined) });
  };
  const countIssue = p.selected?.requiredRecords && p.records && !p.records.parsed.errors.length && p.records.parsed.records.length !== p.selected.requiredRecords ? `This workflow's instructions are for ${p.selected.requiredRecords} records; the file has ${p.records.parsed.records.length}.` : null;
  const ready = !!p.records && !p.records.parsed.errors.length && !countIssue && (p.selected ? true : p.instructions.trim().length > 0 && p.apps.length > 0);
  const doPreview = async () => {
    if (!p.records) return;
    setBusy(true);
    setError(null);
    try {
      const pr = await p.api.preview({ ...(p.selected ? { workflowId: p.selected.id } : { instructions: p.instructions, applications: p.apps }), records: p.records.parsed.records });
      p.onPreview(pr);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h1 className="hero">
        Describe it. Approve it.
        <br />
        Overclock runs it.
      </h1>
      <Environment status={p.status} />

      <section className="card">
        <h2>What would you like Overclock to do?</h2>
        {p.selected ? (
          <div className="chosen">
            <div className="chosen-head">
              <WorkflowBadges w={p.selected} />
              <button className="link" onClick={() => p.onChoose(null)}>
                Describe a different task
              </button>
            </div>
            <p className="instructions">{p.selected.instructions}</p>
            <p className="fine">These are the exact instructions this workflow was learned for. Reuse needs exactly the same task; a changed instruction is a new task.</p>
          </div>
        ) : (
          <>
            <textarea
              className="composer"
              rows={4}
              value={p.instructions}
              onChange={(e) => p.setInstructions(e.target.value)}
              placeholder={"For example:\n“For each order in this CSV, check its status and update the matching customer and support ticket.”"}
            />
            <div className="apps">
              <span className="label">Applications</span>
              {(p.status?.environment.applications ?? []).map((a) => (
                <label key={a.origin} className={`chip toggle ${p.apps.includes(a.name) ? "on" : ""}`}>
                  <input type="checkbox" checked={p.apps.includes(a.name)} onChange={(e) => p.setApps(e.target.checked ? [...p.apps, a.name] : p.apps.filter((x) => x !== a.name))} />
                  {a.name}
                </label>
              ))}
              {!p.status?.environment.applications.length && <span className="muted">This engine has no applications configured.</span>}
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="row">
          <h2>Records</h2>
          {expected && expected.length > 0 && <span className="muted small">Columns: {expected.join(", ")}</span>}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void loadFile(f);
            e.target.value = "";
          }}
        />
        <button
          className="drop"
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) void loadFile(f);
          }}
        >
          {p.records ? (
            <span>
              <strong>{p.records.name}</strong> · {p.records.parsed.records.length} record{p.records.parsed.records.length === 1 ? "" : "s"}
            </span>
          ) : (
            <span>Drop a CSV here, or click to choose a file</span>
          )}
        </button>
        {p.records && p.records.parsed.errors.length > 0 && (
          <ul className="errors">
            {p.records.parsed.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {countIssue && <p className="error">{countIssue}</p>}
        {p.records && !p.records.parsed.errors.length && <RecordSample parsed={p.records.parsed} />}
      </section>

      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={!ready || busy} onClick={() => void doPreview()}>
        {busy ? "Preparing the preview…" : "Preview the workflow"}
      </button>

      <section className="library">
        <div className="row">
          <h2>Learned workflows</h2>
          <span className="muted small">{p.library ? `${runnable.length} ready` : "Loading…"}</span>
        </div>
        {p.library && p.library.length === 0 && <div className="empty">Nothing learned yet. Describe a task above: the first run plans it with AI, and every rerun after that reuses it.</div>}
        {runnable.map((w) => (
          <button key={w.id} className={`workflow ${p.selected?.id === w.id ? "on" : ""}`} onClick={() => p.onChoose(w)}>
            <div className="wf-title">{w.title}</div>
            <WorkflowBadges w={w} />
            <div className="wf-meta">
              {w.steps} steps · {w.changingSteps} change data · {w.requiredRecords ? `${w.requiredRecords} records per run` : `fields: ${w.recordFields.join(", ")}`}
              {w.learnedAt ? ` · learned ${new Date(w.learnedAt).toLocaleDateString()}` : ""}
            </div>
          </button>
        ))}
        {other.length > 0 && (
          <details className="other">
            <summary>{other.length} more that can't be rerun from here</summary>
            {other.map((w) => (
              <div key={w.id} className="workflow disabled">
                <div className="wf-title">{w.title}</div>
                <div className="wf-meta">{w.whyNot}</div>
              </div>
            ))}
          </details>
        )}
      </section>
    </>
  );
}

function WorkflowBadges({ w }: { w: WorkflowSummary }) {
  return (
    <div className="badges">
      {w.source === "imported" ? <Badge tone="info">From your team</Badge> : <Badge tone="ok">Learned here</Badge>}
      {w.review?.status === "passed" && <Badge tone="muted">Reviewed</Badge>}
      {w.applications.map((a) => (
        <Badge key={a.origin} tone="muted">
          {a.name}
        </Badge>
      ))}
    </div>
  );
}

function RecordSample({ parsed }: { parsed: ParsedRecords }) {
  const rows = parsed.records.slice(0, 4);
  return (
    <div className="sample">
      <table>
        <thead>
          <tr>
            {parsed.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {parsed.columns.map((c) => (
                <td key={c}>{r[c]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {parsed.records.length > rows.length && <div className="fine">and {parsed.records.length - rows.length} more</div>}
    </div>
  );
}

function Environment({ status }: { status: EngineStatus | null }) {
  if (!status) return <div className="env skeleton" />;
  return (
    <section className="env">
      <div className="env-row">
        <span className="env-k">Runs in</span>
        <span>Overclock’s own browser on this computer{status.browser.visible ? " (windows visible)" : ""}, not your Chrome tabs</span>
      </div>
      <div className="env-row">
        <span className="env-k">Environment</span>
        <span>{status.environment.label}</span>
      </div>
      <div className="env-row">
        <span className="env-k">Apps</span>
        <span className="env-apps">
          {status.environment.applications.map((a: WorkflowApp) => (
            <span key={a.origin} title={a.origin}>
              {a.name}
            </span>
          ))}
        </span>
      </div>
      <div className="env-row">
        <span className="env-k">Team network</span>
        <span>{status.network.enabled ? (status.network.connected ? "Connected: your team's verified workflows can be reused" : "Unavailable right now") : "Off on this engine"}</span>
      </div>
      <div className="env-row">
        <span className="env-k">AI planning</span>
        <span>{status.planning.available ? "Available for new tasks" : "Off: learned workflows only"}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- preview

const ACTION_ICON: Record<PreviewStep["action"], string> = { open: "↗", read: "◎", "read-table": "▤", fill: "✎", choose: "▾", click: "●", submit: "✓", decide: "ƒ", check: "?", wait: "…" };
const RUNS_TEXT = { once: "Once", "per-record": "For each record", "per-derived-item": "Afterwards, for each item the records point to" } as const;

function PreviewScreen({ api, preview, request, onBack, onStarted }: { api: OverclockApi; preview: WorkflowPreview; request: { workflowId?: string; instructions?: string; applications?: string[]; records: Record<string, string>[] }; onBack: () => void; onStarted: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const needsConsent = preview.modelCalls === "planning";
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.startRun({ ...request, previewId: preview.previewId, ...(needsConsent ? { allowModelCalls: consent } : {}) });
      onStarted(r.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <>
      <button className="link back" onClick={onBack}>
        ← Back
      </button>
      <SourceBanner preview={preview} />
      <h2 className="title">{preview.title}</h2>
      <div className="tiles">
        <Tile label="Applications" value={String(preview.applications.length)} sub={preview.applications.map((a) => a.name).join(", ")} />
        <Tile label="Records" value={String(preview.records)} />
        <Tile label="Steps that change data" value={String(preview.writes.steps)} sub={preview.writes.maxWrites !== null ? `at most ${preview.writes.maxWrites} writes` : "plus follow-up items"} tone={preview.writes.steps ? "warn" : "muted"} />
        <Tile label="Need your approval" value={String(preview.approvals)} tone={preview.approvals ? "warn" : "muted"} />
      </div>
      {preview.phases.length > 0 ? (
        <section className="card steps">
          {preview.phases.map((ph) => (
            <div key={ph.id} className="phase">
              <div className="phase-head">{RUNS_TEXT[ph.runs]}</div>
              <ol>
                {ph.steps.map((s) => (
                  <li key={s.id} className={s.changesData ? "writes" : ""}>
                    <span className="icon">{ACTION_ICON[s.action]}</span>
                    <span className="step-text">
                      {s.app && <span className="app">{s.app}</span>}
                      {s.text}
                      {s.detail && <span className="step-detail">{s.detail}</span>}
                      <span className="step-tags">
                        {s.changesData && <Badge tone="warn">changes data</Badge>}
                        {s.verifiedBy && <Badge tone="ok">verified by re-reading {s.verifiedBy}</Badge>}
                        {s.needsApproval && <Badge tone="bad">needs your approval</Badge>}
                        {s.conditional && <Badge tone="muted">only when its rule applies</Badge>}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      ) : (
        <section className="card">
          <p className="muted">The steps don’t exist yet: Overclock writes them when it plans this task. You’ll see each one live, and no write happens before the plan passes its review.</p>
        </section>
      )}
      {preview.notes.map((n) => (
        <p key={n} className="note">
          {n}
        </p>
      ))}
      {preview.blocking.length > 0 && (
        <ul className="errors">
          {preview.blocking.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {needsConsent && preview.blocking.length === 0 && (
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>I understand planning this new task makes AI model calls, which cost money.</span>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary wide" disabled={busy || preview.blocking.length > 0 || (needsConsent && !consent)} onClick={() => void start()}>
        {busy ? "Starting…" : `Approve and run on ${preview.records} record${preview.records === 1 ? "" : "s"}`}
      </button>
    </>
  );
}

function SourceBanner({ preview }: { preview: WorkflowPreview }) {
  if (preview.source === "local")
    return (
      <div className="source local">
        <strong>Reusing a workflow learned on this computer</strong>
        <span>No AI planning, $0 in model calls{preview.review?.status === "passed" ? ", and its plan passed an adversarial review" : ""}.</span>
      </div>
    );
  if (preview.source === "network")
    return (
      <div className="source network">
        <strong>Someone on your team already taught Overclock this task</strong>
        <span>
          You can reuse their verified workflow: {preview.network?.state === "ACTIVE" ? "independently validated" : preview.network?.state}, {preview.network?.successfulReuses ?? 0} successful reuses. No AI planning.
        </span>
      </div>
    );
  return (
    <div className="source new">
      <strong>New task: Overclock will plan it with AI</strong>
      <span>The first run explores the apps and writes the steps; reruns of exactly this task reuse them for free.</span>
    </div>
  );
}

// -------------------------------------------------------------------- run

function RunScreen({ api, runId, preview, records, visibleBrowser, onDone, onAgain }: { api: OverclockApi; runId: string; preview: WorkflowPreview; records: Record<string, string>[]; visibleBrowser: boolean; onDone: () => void; onAgain: () => void }) {
  const [view, setView] = useState<RunView>(() => createRunView(runId));
  const [feed, setFeed] = useState<{ seq: number; text: string; tone: Tone }[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    const onEvent = (e: RunEvent) => {
      setView((v) => applyEvent(v, e));
      const line = eventLine(e);
      if (line) setFeed((f) => [{ seq: e.seq, ...line }, ...f].slice(0, 60));
    };
    void (async () => {
      for (let attempt = 0; attempt < 6 && !cancelled; attempt++) {
        try {
          const ended = await api.stream(runId, viewRef.current.lastSeq, onEvent, abort.signal);
          if (ended) break;
        } catch (err) {
          if (cancelled) return;
          if (attempt === 5) setError(err instanceof Error ? err.message : String(err));
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      if (cancelled) return;
      try {
        setResult(await api.result(runId));
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [api, runId, onDone]);

  const progress = recordProgress(view, records);
  const finished = !!result;
  const pending = Object.values(view.approvals).filter((a) => !a.resolved);
  return (
    <>
      <div className="run-head">
        <span className={`pill ${finished ? (result?.status === "completed" ? "ok" : "bad") : "live"}`}>{finished ? statusText(result!.status) : statusText(view.status)}</span>
        <span className="muted small">{fmtMs(finished ? result?.summary?.wallMs : view.lastT)}</span>
        {!finished && (
          <button className="ghost small" onClick={() => void api.cancel(runId)}>
            Stop
          </button>
        )}
      </div>
      <SourceBanner preview={preview} />
      <div className="progress">
        <div className="bar">
          <div style={{ width: `${progress.total ? (100 * progress.finished) / progress.total : 0}%` }} />
        </div>
        <div className="progress-text">
          {progress.finished} of {progress.total} records done
        </div>
      </div>
      <div className="tiles">
        <Tile label="Changes verified" value={String(view.receipts.VERIFIED)} tone="ok" />
        <Tile label="Browser actions" value={String(view.actions.count)} />
        <Tile label="AI calls" value={String(view.modelCalls.count)} sub={fmtUsd(view.modelCalls.costUsd)} tone={view.modelCalls.count ? "info" : "muted"} />
        <Tile label="Failures" value={String(view.receipts.FAILED + view.receipts.UNCONFIRMED)} tone={view.receipts.FAILED + view.receipts.UNCONFIRMED ? "bad" : "muted"} />
      </div>
      {pending.map((a) => (
        <div key={a.approvalId} className="approval">
          <strong>Approval needed</strong>
          <p>{a.description}</p>
          <div className="row">
            <button className="primary small" onClick={() => void api.approve(runId, a.approvalId, true)}>
              Approve
            </button>
            <button className="ghost small" onClick={() => void api.approve(runId, a.approvalId, false)}>
              Reject
            </button>
          </div>
        </div>
      ))}
      {!finished && <Browsers api={api} runId={runId} view={view} visible={visibleBrowser} />}
      {error && <p className="error">{error}</p>}
      {result && <Results result={result} records={records} onAgain={onAgain} />}
      <section className="feed">
        <h3>Activity</h3>
        {feed.length === 0 && <p className="muted small">Waiting for the engine…</p>}
        <ul>
          {feed.map((l) => (
            <li key={l.seq} className={l.tone}>
              {l.text}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Browsers({ api, runId, view, visible }: { api: OverclockApi; runId: string; view: RunView; visible: boolean }) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const workers = Object.values(view.workers)
    .filter((w) => w.thumbUrl)
    .slice(0, 6);
  const ids = workers.map((w) => w.id).join(",");
  useEffect(() => {
    if (!ids) return;
    let stop = false;
    const urls: Record<string, string> = {};
    const tick = async () => {
      for (const id of ids.split(",")) {
        const b = await api.thumbnail(runId, id);
        if (stop || !b) continue;
        const u = URL.createObjectURL(b);
        if (urls[id]) URL.revokeObjectURL(urls[id]!);
        urls[id] = u;
        setThumbs((t) => ({ ...t, [id]: u }));
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 1500);
    return () => {
      stop = true;
      clearInterval(t);
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
    };
  }, [api, runId, ids]);
  if (!workers.length) return null;
  return (
    <section className="browsers">
      <h3>Overclock’s browser{visible ? " (also open as windows)" : ""}</h3>
      <div className="thumbs">
        {workers.map((w) => (
          <figure key={w.id}>
            {thumbs[w.id] ? <img src={thumbs[w.id]} alt={`${w.app ?? "page"}: ${w.label ?? w.state}`} /> : <div className="thumb-wait" />}
            <figcaption>
              {w.app ?? "—"} · {w.label ?? w.state.toLowerCase()}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function Results({ result, records, onAgain }: { result: RunResult; records: Record<string, string>[]; onAgain: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const inputValues = new Set(records.flatMap((r) => Object.values(r)));
  const outcomes = result.outcomes.filter((o) => o.scope !== "derived" && inputValues.has(o.recordKey));
  const derived = result.outcomes.filter((o) => o.scope === "derived" || !inputValues.has(o.recordKey));
  const count = (pred: (o: (typeof outcomes)[number]) => boolean) => outcomes.filter(pred).length;
  const changed = count((o) => o.status === "VERIFIED" && o.writes > 0);
  const noChange = count((o) => o.status === "SKIPPED" || (o.status === "VERIFIED" && o.writes === 0));
  const problems = count((o) => o.status === "FAILED" || o.status === "UNCONFIRMED" || o.status === "NEEDS_APPROVAL");
  const s = result.summary;
  const download = (name: string, type: string, text: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const csv = () =>
    ["record,outcome,verified_writes,receipts", ...result.outcomes.map((o) => [o.recordKey, o.status, o.writes, o.receipts.join(" ")].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
  return (
    <section className="results">
      <div className={`result-hero ${problems ? "warn" : "ok"}`}>
        <div className="big">
          {outcomes.length - problems} of {outcomes.length}
        </div>
        <div>records done{problems ? `, ${problems} need attention` : ""}</div>
      </div>
      <div className="tiles">
        <Tile label="Changed and verified" value={String(changed)} tone="ok" />
        <Tile label="No change needed" value={String(noChange)} tone="muted" />
        <Tile label="Need attention" value={String(problems)} tone={problems ? "bad" : "muted"} />
        <Tile label="Time" value={fmtMs(s?.wallMs)} sub={`${s?.modelCalls ?? 0} AI calls · ${fmtUsd(s?.modelCostUsd)}`} />
      </div>
      <p className="fine">“Verified” means Overclock re-read the record’s page after each change and found exactly the intended values. “No change needed” means the workflow’s rules called for no change on that record.</p>
      <table className="records">
        <thead>
          <tr>
            <th>Record</th>
            <th>Outcome</th>
            <th>Writes</th>
          </tr>
        </thead>
        <tbody>
          {[...outcomes, ...derived].map((o) => {
            const l = outcomeLabel(o);
            const receipts = result.receipts.filter((r) => r.recordKey === o.recordKey);
            return (
              <RecordRow key={o.recordKey} label={l.label} tone={l.tone} outcome={o} receipts={receipts} derived={!outcomes.includes(o)} open={open === o.recordKey} onToggle={() => setOpen(open === o.recordKey ? null : o.recordKey)} />
            );
          })}
        </tbody>
      </table>
      <div className="row actions">
        <button className="ghost small" onClick={() => download(`overclock-${result.runId}.json`, "application/json", JSON.stringify(result, null, 2))}>
          Download report (JSON)
        </button>
        <button className="ghost small" onClick={() => download(`overclock-${result.runId}.csv`, "text/csv", csv())}>
          Download CSV
        </button>
        <button className="primary small" onClick={onAgain}>
          Run again on new records
        </button>
      </div>
    </section>
  );
}

function RecordRow({ label, tone, outcome, receipts, derived, open, onToggle }: { label: string; tone: Tone; outcome: RunResult["outcomes"][number]; receipts: RunResult["receipts"]; derived: boolean; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr className="rec" onClick={onToggle}>
        <td>
          <span className="mono">{outcome.recordKey}</span>
          {derived && <span className="muted small"> (follow-up)</span>}
        </td>
        <td>
          <Badge tone={tone}>{label}</Badge>
        </td>
        <td>{outcome.writes}</td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={3}>
            {receipts.length === 0 && <p className="muted small">No writes for this record.{outcome.notes.length ? ` ${outcome.notes.join("; ")}` : ""}</p>}
            {receipts.map((r) => (
              <div key={`${r.taskId}:${r.nodeId}`} className="receipt">
                <div>
                  <Badge tone={r.status === "VERIFIED" ? "ok" : "bad"}>{r.status === "VERIFIED" ? "Verified" : r.status}</Badge> <span className="mono small">{r.nodeId}</span>
                </div>
                <ul>
                  {r.fields.map((f) => (
                    <li key={f.name}>
                      <span className="muted">{f.name}</span>: {String(f.actual ?? "—")}
                      {JSON.stringify(f.actual) !== JSON.stringify(f.expected) ? <span className="bad"> (expected {String(f.expected)})</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

// ------------------------------------------------------------- primitives

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

function Tile({ label, value, sub, tone = "muted" }: { label: string; value: string; sub?: string | undefined; tone?: Tone }) {
  return (
    <div className={`tile ${tone}`}>
      <div className="tile-v">{value}</div>
      <div className="tile-l">{label}</div>
      {sub && <div className="tile-s">{sub}</div>}
    </div>
  );
}
