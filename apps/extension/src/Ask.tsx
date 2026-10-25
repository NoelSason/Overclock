import { useEffect, useRef, useState } from "react";
import type { AgentArtifact } from "@overclock/contracts";
import type { EngineStatus, OverclockApi } from "./api";
import { runAgentTask, type AgentOutcome } from "./agent/run";
import { fmtMs, fmtUsd } from "./format";

/**
 * "Ask": everyday tasks in the user's own browser. The user types what they want; Overclock works
 * in a tab in this window, where they're already signed in, and through their Google account
 * when it's connected. It asks before it uses a new site or clicks anything that sends, deletes,
 * shares, or pays.
 */

const EXAMPLES = ["Check my 10 most recent emails, summarize them, and put the summary in a new Google Doc.", "Find the newest email from my bank and tell me what it says."];

type Prompt = { kind: "approve"; text: string; resolve: (ok: boolean) => void } | { kind: "ask"; text: string; resolve: (reply: string | null) => void };
type FeedLine = { id: number; step?: number; text: string; detail?: string; tone: "info" | "bad" | "muted"; google?: boolean };

export function Ask({ api, status, onRefresh }: { api: OverclockApi; status: EngineStatus | null; onRefresh: () => Promise<void> }) {
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [outcome, setOutcome] = useState<(AgentOutcome & { ms: number }) | null>(null);
  const [progress, setProgress] = useState({ costUsd: 0, step: 0 });
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const seq = useRef(0);

  // Closing the panel stops the task and releases the tab.
  useEffect(() => {
    const stop = () => abort.current?.abort();
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);

  const add = (l: Omit<FeedLine, "id">) => setFeed((f) => [...f, { ...l, id: ++seq.current }]);

  const start = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRunning(true);
    setFeed([]);
    setOutcome(null);
    setError(null);
    setProgress({ costUsd: 0, step: 0 });
    const t0 = performance.now();
    try {
      const o = await runAgentTask(
        api,
        task,
        {
          step: (s) => add({ step: s.step, text: s.say, detail: s.detail, tone: "info", google: s.engine }),
          result: (text, failed) => add({ text, tone: failed ? "bad" : "muted" }),
          progress: setProgress,
          approve: (a) => new Promise<boolean>((resolve) => setPrompt({ kind: "approve", text: a.text, resolve })),
          ask: (text) => new Promise<string | null>((resolve) => setPrompt({ kind: "ask", text, resolve })),
        },
        ctrl.signal,
      );
      setOutcome({ ...o, ms: performance.now() - t0 });
      // Open what the task made, unless it's already showing in Overclock's tab.
      for (const a of o.artifacts) if (!o.tabUrl?.startsWith(a.url.replace(/\/edit$/, ""))) await chrome.tabs.create({ url: a.url, active: true }).catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrompt(null);
      setRunning(false);
      abort.current = null;
    }
  };

  const answer = (value: boolean | string | null) => {
    if (!prompt) return;
    if (prompt.kind === "approve") prompt.resolve(value === true);
    else prompt.resolve(typeof value === "string" ? value : null);
    setPrompt(null);
  };

  const ready = !!status?.agent.available;
  return (
    <>
      {!running && !outcome && (
        <>
          <h1 className="hero">
            Ask for it.
            <br />
            Overclock does it in your browser.
          </h1>
          <GoogleCard api={api} status={status} onRefresh={onRefresh} />
          <section className="card">
            <h2>What should Overclock do?</h2>
            <textarea className="composer" rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder={`For example:\n“${EXAMPLES[0]}”`} />
            <div className="apps">
              {EXAMPLES.map((x) => (
                <button key={x} className="chip" onClick={() => setTask(x)}>
                  {x.length > 52 ? `${x.slice(0, 50)}…` : x}
                </button>
              ))}
            </div>
            <p className="fine">Overclock works in a new tab in this window, where you’re already signed in. It asks before it clicks anything that sends, deletes, shares, or pays.</p>
            {!ready && status && <p className="error">Overclock can’t run tasks yet: the engine needs an Anthropic API key. Add it to the engine’s settings and restart it.</p>}
            <div className="actions">
              <button className="primary" disabled={!ready || !task.trim()} onClick={() => void start()}>
                Start
              </button>
            </div>
          </section>
        </>
      )}

      {(running || outcome) && (
        <>
          <div className="run-head">
            <span className={`pill ${running ? "live" : outcome?.status === "done" ? "ok" : "bad"}`}>{running ? "Working" : outcome?.status === "done" ? "Done" : outcome?.status === "stopped" ? "Stopped" : "Didn’t finish"}</span>
            <span className="muted small">
              {progress.step} {progress.step === 1 ? "step" : "steps"} · {fmtUsd(progress.costUsd)}
              {outcome ? ` · ${fmtMs(outcome.ms)}` : ""}
            </span>
            {running && (
              <button className="ghost small" onClick={() => abort.current?.abort()}>
                Stop
              </button>
            )}
          </div>
          <section className="card">
            <p className="instructions">{task}</p>
            {running && <p className="fine">While Overclock works in its tab, your browser shows a bar saying it’s being controlled. Cancel there, or Stop here, to stop it.</p>}
          </section>
          {prompt && <PromptCard prompt={prompt} onAnswer={answer} />}
          {outcome && <OutcomeCard outcome={outcome} onNew={() => setOutcome(null)} />}
          {error && <p className="error">{error}</p>}
          <section className="feed">
            <h3>Activity</h3>
            {feed.length === 0 && <p className="muted small">Starting…</p>}
            <ul>
              {feed.map((l) => (
                <li key={l.id} className={l.tone}>
                  {l.step !== undefined && <span className="muted">{l.step}. </span>}
                  {l.text}
                  {l.google && <span className="badge info"> Google</span>}
                  {l.detail && <span className="muted"> · {l.detail}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </>
  );
}

function GoogleCard({ api, status, onRefresh }: { api: OverclockApi; status: EngineStatus | null; onRefresh: () => Promise<void> }) {
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const g = status?.google;
  // While the sign-in tab is open, check every two seconds for up to five minutes.
  useEffect(() => {
    if (!waiting) return;
    if (g?.email) {
      setWaiting(false);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 5 * 60_000) setWaiting(false);
      void onRefresh();
    }, 2_000);
    return () => clearInterval(timer);
  }, [waiting, g?.email, onRefresh]);
  if (!g) return null;
  if (!g.configured)
    return (
      <section className="env">
        <div className="env-row">
          <span className="env-k">Google</span>
          <span>Not set up on this engine. Overclock uses your Gmail and Docs tabs instead.</span>
        </div>
      </section>
    );
  const connect = async () => {
    setError(null);
    try {
      const { url } = await api.googleConnect();
      await chrome.tabs.create({ url, active: true });
      setWaiting(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="env">
      <div className="env-row">
        <span className="env-k">Google</span>
        {g.email ? (
          <span>
            Connected as {g.email}. Overclock can read your email (never send, delete, or change it) and create Google Docs.{" "}
            <button className="link" onClick={() => void api.googleDisconnect().then(onRefresh)}>
              Disconnect
            </button>
          </span>
        ) : (
          <span>
            {waiting ? "Finish signing in in the new tab…" : "Connect your Google account so Overclock can read your email and create Docs directly."}{" "}
            {!waiting && (
              <button className="link" onClick={() => void connect()}>
                Connect Google
              </button>
            )}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function PromptCard({ prompt, onAnswer }: { prompt: Prompt; onAnswer: (v: boolean | string | null) => void }) {
  const [reply, setReply] = useState("");
  return (
    <div className="approval">
      <strong>{prompt.kind === "approve" ? "Your approval" : "Overclock needs you"}</strong>
      <p>{prompt.text}</p>
      {prompt.kind === "ask" && <textarea className="composer" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your answer (optional)" />}
      <div className="row">
        <button className="primary small" onClick={() => onAnswer(prompt.kind === "approve" ? true : reply.trim() || "Done.")}>
          {prompt.kind === "approve" ? "Allow" : "Continue"}
        </button>
        <button className="ghost small" onClick={() => onAnswer(prompt.kind === "approve" ? false : null)}>
          {prompt.kind === "approve" ? "Don’t allow" : "Stop task"}
        </button>
      </div>
    </div>
  );
}

function OutcomeCard({ outcome, onNew }: { outcome: AgentOutcome & { ms: number }; onNew: () => void }) {
  return (
    <section className="card">
      {outcome.artifacts.map((a: AgentArtifact) => (
        <div key={a.url} className="receipt">
          <div className="row">
            <strong>{a.title}</strong>
            <span className={`badge ${a.verified ? "ok" : "bad"}`}>{a.verified ? "Checked" : "Not confirmed"}</span>
          </div>
          <a className="mono small" href={a.url} target="_blank" rel="noreferrer">
            {a.url}
          </a>
          <p className="fine">{a.detail}</p>
        </div>
      ))}
      {outcome.message && <p style={{ whiteSpace: "pre-wrap" }}>{outcome.message}</p>}
      <div className="actions">
        <button className="primary" onClick={onNew}>
          New task
        </button>
      </div>
    </section>
  );
}
