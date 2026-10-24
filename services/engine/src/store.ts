import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { FragmentState, RunConfig, RunEvent, RunListItem, RunStatus, StageName, TaskState, VerificationStatus } from "@overclock/contracts";
import { RunSummary } from "@overclock/contracts";
import { redact, repoRoot } from "@overclock/telemetry";
import { migrate } from "./migrations";

/**
 * Durable engine store over a single SQLite file (node:sqlite, WAL mode).
 *
 * The append-only `events` table is the source of truth. `appendEvent` writes the event and
 * every projection derived from it (runs, tasks, receipts, ...) in one transaction, so the
 * projections can never disagree with the log. Observations, metrics, spans, and full
 * artifacts/programs come from explicit save calls.
 *
 * Durability: WAL + synchronous=NORMAL. A committed event survives a process crash; the most
 * recent transactions can be lost on OS crash / power loss (SQLite's documented trade-off).
 */

export function defaultDbPath(): string {
  return join(repoRoot(), ".data", "engine", "engine.db");
}

/**
 * Fill fields that older summaries lack (firstActionMs, overlapMs, stageMs, ...) from the
 * RunSummary schema's own defaults. Stored values are kept as-is, so a summary that does not
 * fully validate is still returned rather than dropped.
 */
export function withSummaryDefaults(raw: unknown): RunSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const [key, schema] of Object.entries(RunSummary.shape)) {
    if (out[key] !== undefined) continue;
    const d = schema.safeParse(undefined);
    if (d.success && d.data !== undefined) out[key] = d.data;
  }
  return out as RunSummary;
}

export interface StoredRun {
  runId: string;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  mode: string;
  goal: string;
  label?: string | undefined;
  /** Redacted config. A placeholder `{}` if events arrived without run.created / createRun. */
  config: RunConfig;
  /** Present once run.completed was persisted. */
  summary?: RunSummary | undefined;
}

export interface StoredTask {
  taskId: string;
  segmentId: string;
  phaseId: string;
  recordKey: string;
  state: TaskState;
  attempts: number;
  workerId?: string | undefined;
  lastError?: string | undefined;
  updatedT: number;
}

export interface StoredTaskTransition {
  taskId: string;
  seq: number;
  state: TaskState;
  t: number;
}

export interface StoredReceipt {
  seq: number;
  taskId: string;
  recordKey: string;
  nodeId: string;
  status: VerificationStatus;
  fields: { name: string; expected: unknown; actual: unknown }[];
  t: number;
}

export interface StoredArtifactInfo {
  artifactId: string;
  kind: string;
  title: string;
  summary?: unknown;
  /** True once the full artifact was saved with saveArtifact. */
  hasContent: boolean;
  createdAt: number;
}

export interface StoredStageInterval {
  seq: number;
  stage: StageName;
  start: number;
  end?: number | undefined;
  detail?: string | undefined;
}

export interface StoredFragment {
  fragmentId: string;
  phaseId: string;
  segmentIds: string[];
  state: FragmentState;
  label: string;
  reason?: string | undefined;
  effect?: string | undefined;
  updatedT: number;
  history: { seq: number; t: number; state: FragmentState; reason?: string | undefined }[];
}

export interface StoredScoutPage {
  seq: number;
  t: number;
  agentId: string;
  app: string;
  url: string;
  routePattern: string;
  loadMs: number;
  controls: number;
}

export interface ObservationInput {
  observationId: string;
  app: string;
  url: string;
  route?: string | undefined;
  fingerprint?: string | undefined;
  json: unknown;
}

export interface StoredObservation extends ObservationInput {
  runId: string;
}

type Row = Record<string, unknown>;

const PROJECTION_TABLES = [
  "programs",
  "tasks",
  "task_transitions",
  "artifacts",
  "candidates",
  "model_invocations",
  "worker_leases",
  "lock_conflicts",
  "verification_receipts",
  "recovery_attempts",
  "observations",
  "metrics",
  "spans",
  "stage_intervals",
  "scout_pages",
  "fragments",
  "fragment_transitions",
] as const;
export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0);
/** Numeric column value, or null when the producer sent something else (e.g. a redaction marker). */
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const bool = (v: boolean | undefined): number | null => (v === undefined ? null : v ? 1 : 0);
const json = (v: unknown): string => JSON.stringify(v ?? null);
const parse = <T>(v: unknown): T | undefined => (typeof v === "string" ? (JSON.parse(v) as T) : undefined);

export class EngineStore {
  readonly path: string;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly s: ReturnType<typeof prepareStatements>;
  /** Runs that already have a `runs` row (avoids an INSERT OR IGNORE per event). */
  private readonly knownRuns = new Set<string>();
  private closed = false;

  constructor(path: string = defaultDbPath()) {
    this.path = path;
    if (path !== ":memory:" && !path.startsWith("file:")) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.schemaVersion = migrate(this.db);
    this.s = prepareStatements(this.db);
  }

  // ---------------------------------------------------------------- writes

  /**
   * Create (or re-register) a run row with a redacted config. Safe to call before or after the
   * run's `run.created` event; whichever comes last wins for config/mode/goal/label.
   */
  createRun(runId: string, config: RunConfig, createdAt: number = Date.now()): void {
    const clean = redact(config);
    this.s.upsertRun.run(runId, createdAt, "pending", clean.mode ?? "", clean.goal ?? "", clean.label ?? null, json(clean), createdAt);
    this.knownRuns.add(runId);
  }

  /**
   * Persist one event plus its projections atomically. Returns false (and writes nothing) if an
   * event with the same (runId, seq) is already stored, so replaying an event stream is safe.
   */
  appendEvent(e: RunEvent): boolean {
    const { runId, seq, ts, t, type, ...rest } = e;
    // Payloads normally arrive redacted from the EventBus; run configs are re-redacted here
    // because they are the one payload that carries user-supplied inputs wholesale.
    const payload: Row = type === "run.created" ? redact(rest as Row) : (rest as Row);
    const s = this.s;
    s.begin.run();
    try {
      if (!this.knownRuns.has(runId)) s.ensureRun.run(runId, ts, "pending", "", "", "{}", ts);
      const inserted = s.insertEvent.run(runId, seq, ts, t, type, JSON.stringify(payload)).changes;
      if (!inserted) {
        s.commit.run();
        return false;
      }
      this.project(e, payload);
      s.commit.run();
    } catch (err) {
      s.rollback.run();
      throw err;
    }
    this.knownRuns.add(runId);
    return true;
  }

  private project(e: RunEvent, payload: Row): void {
    const s = this.s;
    const { runId, seq, t } = e;
    switch (e.type) {
      case "run.created": {
        const config = payload.config as RunConfig;
        s.runCreated.run(runId, e.ts, "pending", config.mode ?? "", config.goal ?? "", config.label ?? null, json(config), e.ts);
        break;
      }
      case "run.status":
        s.runStatus.run(e.status, e.ts, runId);
        break;
      case "run.completed":
        s.runCompleted.run(e.summary.status, json(e.summary), e.ts, runId);
        break;
      case "agent.artifact":
        s.artifactSummary.run(runId, e.artifact.artifactId, e.artifact.kind, e.artifact.title, json(e.artifact), e.ts);
        break;
      case "candidate.proposed":
        s.candidateProposed.run(runId, e.candidateId, e.agentId, e.name, e.summary);
        break;
      case "candidate.evaluated":
        s.candidateEvaluated.run(e.estimate === null ? null : json(e.estimate), bool(e.valid), json(e.issues), runId, e.candidateId);
        break;
      case "candidate.selected":
        s.candidateSelected.run(e.candidateId, runId);
        break;
      case "program.compiled":
        s.programCompiled.run(runId, e.programId, e.strategy, json(payload), e.ts);
        break;
      case "tasks.created":
        for (const task of e.tasks) {
          // Task ids are stable: a duplicate tasks.created (e.g. a resumed run) must not add rows.
          if (s.taskCreated.run(runId, task.taskId, task.segmentId, task.phaseId, task.recordKey, "PENDING", t).changes) {
            s.taskTransition.run(runId, task.taskId, seq, "PENDING", t);
          }
        }
        break;
      case "task.state":
        // Mirrors the reducer: workerId/error only overwrite when present, attempt when defined.
        s.taskState.run(e.state, e.workerId || null, e.attempt ?? null, e.error || null, t, runId, e.taskId);
        s.taskTransition.run(runId, e.taskId, seq, e.state, t);
        break;
      case "worker.state":
        s.workerLease.run(runId, seq, e.workerId, e.taskId ?? null, e.state, t);
        break;
      case "receipt":
        s.receipt.run(runId, seq, e.taskId, e.recordKey, e.nodeId, e.status, json(e.fields), t);
        break;
      case "lock.conflict":
        s.lockConflict.run(runId, seq, e.taskId, e.resource, e.holder, t);
        break;
      case "recovery":
        s.recovery.run(runId, seq, e.taskId, e.level, e.phase, e.reason, e.detail ?? null, numOrNull(e.ms), numOrNull(e.propagatedTo), t);
        break;
      case "model.call":
        s.modelCall.run(runId, seq, e.provider, e.model, e.purpose, num(e.ms), numOrNull(e.inputTokens), numOrNull(e.outputTokens), numOrNull(e.costUsd), e.ok ? 1 : 0, strOrNull(e.error));
        break;
      case "stage":
        // Mirrors the reducer: `end` closes the most recent open interval for that stage.
        if (e.phase === "start") s.stageStart.run(runId, seq, e.stage, t, e.detail ?? null);
        else s.stageEnd.run(t, e.detail ?? null, runId, e.stage);
        break;
      case "scout.page":
        s.scoutPage.run(runId, seq, e.agentId, e.app, e.url, e.routePattern, num(e.loadMs), num(e.controls), t);
        break;
      case "fragment":
        s.fragment.run(runId, e.fragmentId, e.phaseId, json(e.segmentIds), e.state, e.label, e.reason ?? null, e.effect || null, t);
        s.fragmentTransition.run(runId, seq, e.fragmentId, e.state, e.reason ?? null, t);
        break;
      default:
        break;
    }
  }

  /** Store the full artifact body (the event only carries a summary). Redacted before storage. */
  saveArtifact(runId: string, artifactId: string, kind: string, title: string, body: unknown): void {
    this.s.saveArtifact.run(runId, artifactId, kind, title, json(redact(body)), Date.now());
  }

  /** Store the full compiled program (template graph + IR). Redacted before storage. */
  saveProgram(runId: string, programId: string, strategy: string, body: unknown, compiledAt: number = Date.now()): void {
    this.s.saveProgram.run(runId, programId, strategy, json(redact(body)), compiledAt);
  }

  saveObservation(runId: string, obs: ObservationInput): void {
    this.s.saveObservation.run(runId, obs.observationId, obs.app, obs.url, obs.route ?? null, obs.fingerprint ?? null, json(redact(obs.json)));
  }

  saveSpans(runId: string, otlpJson: unknown): void {
    this.s.saveSpans.run(runId, json(otlpJson));
  }

  saveMetrics(runId: string, key: string, value: unknown): void {
    this.s.saveMetrics.run(runId, key, json(value));
  }

  // ---------------------------------------------------------------- reads

  listRuns(): RunListItem[] {
    return this.s.listRuns.all().map((r) => {
      const run = toRun(r);
      return { runId: run.runId, status: run.status, mode: run.mode, goal: run.goal, createdAt: run.createdAt, label: run.label, summary: run.summary };
    });
  }

  getRun(runId: string): StoredRun | undefined {
    const r = this.s.getRun.get(runId);
    return r ? toRun(r) : undefined;
  }

  /** Events with seq > after, in seq order. `limit <= 0` or Infinity means no limit. */
  events(runId: string, after = 0, limit = 1000): RunEvent[] {
    const lim = !Number.isFinite(limit) || limit <= 0 ? -1 : Math.floor(limit);
    return this.s.events.all(runId, after, lim).map(toEvent);
  }

  /** Iterate every event with seq > after without materializing the whole log. */
  *iterateEvents(runId: string, after = 0): Generator<RunEvent> {
    for (const r of this.s.events.iterate(runId, after, -1)) yield toEvent(r);
  }

  lastSeq(runId: string): number {
    return num(this.s.lastSeq.get(runId)?.s);
  }

  getArtifact(runId: string, artifactId: string): unknown | undefined {
    return parse(this.s.getArtifact.get(runId, artifactId)?.json);
  }

  listArtifacts(runId: string): StoredArtifactInfo[] {
    return this.s.listArtifacts.all(runId).map((r) => ({
      artifactId: str(r.artifact_id),
      kind: str(r.kind),
      title: str(r.title),
      summary: parse(r.summary_json),
      hasContent: num(r.has_content) === 1,
      createdAt: num(r.created_at),
    }));
  }

  /** Latest program for the run: the full saved program if present, else the compiled-event summary. */
  getProgram(runId: string): unknown | undefined {
    return parse(this.s.getProgram.get(runId)?.json);
  }

  observations(runId: string): StoredObservation[] {
    return this.s.observations.all(runId).map((r) => ({
      runId,
      observationId: str(r.observation_id),
      app: str(r.app),
      url: str(r.url),
      route: optStr(r.route),
      fingerprint: optStr(r.fingerprint),
      json: parse(r.json),
    }));
  }

  getSpans(runId: string): unknown | undefined {
    return parse(this.s.getSpans.get(runId)?.json);
  }

  getMetrics(runId: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.s.getMetrics.all(runId)) out[str(r.key)] = parse(r.value_json);
    return out;
  }

  receipts(runId: string): StoredReceipt[] {
    return this.s.receipts.all(runId).map((r) => ({
      seq: num(r.seq),
      taskId: str(r.task_id),
      recordKey: str(r.record_key),
      nodeId: str(r.node_id),
      status: str(r.status) as VerificationStatus,
      fields: parse<StoredReceipt["fields"]>(r.fields_json) ?? [],
      t: num(r.t),
    }));
  }

  tasks(runId: string): StoredTask[] {
    return this.s.tasks.all(runId).map((r) => ({
      taskId: str(r.task_id),
      segmentId: str(r.segment_id),
      phaseId: str(r.phase_id),
      recordKey: str(r.record_key),
      state: str(r.state) as TaskState,
      attempts: num(r.attempts),
      workerId: optStr(r.worker_id),
      lastError: optStr(r.last_error),
      updatedT: num(r.updated_t),
    }));
  }

  taskTransitions(runId: string, taskId?: string): StoredTaskTransition[] {
    const rows = taskId === undefined ? this.s.transitions.all(runId) : this.s.transitionsForTask.all(runId, taskId);
    return rows.map((r) => ({ taskId: str(r.task_id), seq: num(r.seq), state: str(r.state) as TaskState, t: num(r.t) }));
  }

  stageIntervals(runId: string): StoredStageInterval[] {
    return this.s.stageIntervals.all(runId).map((r) => ({
      seq: num(r.seq),
      stage: str(r.stage) as StageName,
      start: num(r.start_t),
      end: typeof r.end_t === "number" ? r.end_t : undefined,
      detail: optStr(r.detail),
    }));
  }

  scoutPages(runId: string): StoredScoutPage[] {
    return this.s.scoutPages.all(runId).map((r) => ({
      seq: num(r.seq),
      t: num(r.t),
      agentId: str(r.agent_id),
      app: str(r.app),
      url: str(r.url),
      routePattern: str(r.route_pattern),
      loadMs: num(r.load_ms),
      controls: num(r.controls),
    }));
  }

  fragments(runId: string): StoredFragment[] {
    const history = new Map<string, StoredFragment["history"]>();
    for (const r of this.s.fragmentTransitions.all(runId)) {
      const id = str(r.fragment_id);
      let h = history.get(id);
      if (!h) history.set(id, (h = []));
      h.push({ seq: num(r.seq), t: num(r.t), state: str(r.state) as FragmentState, reason: optStr(r.reason) });
    }
    return this.s.fragments.all(runId).map((r) => ({
      fragmentId: str(r.fragment_id),
      phaseId: str(r.phase_id),
      segmentIds: parse<string[]>(r.segment_ids_json) ?? [],
      state: str(r.state) as FragmentState,
      label: str(r.label),
      reason: optStr(r.reason),
      effect: optStr(r.effect),
      updatedT: num(r.updated_t),
      history: history.get(str(r.fragment_id)) ?? [],
    }));
  }

  /** Row counts per projection table for one run (diagnostics and tests). */
  projectionCounts(runId: string): Record<ProjectionTable | "events", number> {
    const out = { events: num(this.s.countEvents.get(runId)?.n) } as Record<ProjectionTable | "events", number>;
    for (const table of PROJECTION_TABLES) out[table] = num(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(runId)?.n);
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function toRun(r: Row): StoredRun {
  return {
    runId: str(r.run_id),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    status: str(r.status) as RunStatus,
    mode: str(r.mode),
    goal: str(r.goal),
    label: optStr(r.label),
    config: parse<RunConfig>(r.config_json) ?? ({} as RunConfig),
    summary: withSummaryDefaults(parse(r.summary_json)),
  };
}

function toEvent(r: Row): RunEvent {
  // Same key order the EventBus produces: payload (type first), then the envelope.
  return { type: r.type, ...(JSON.parse(str(r.payload_json)) as Row), runId: r.run_id, seq: num(r.seq), ts: num(r.ts), t: num(r.t) } as RunEvent;
}

function prepareStatements(db: DatabaseSync) {
  const p = (sql: string): StatementSync => db.prepare(sql);
  return {
    begin: p("BEGIN"),
    commit: p("COMMIT"),
    rollback: p("ROLLBACK"),

    // runs
    ensureRun: p(`INSERT OR IGNORE INTO runs (run_id, created_at, status, mode, goal, config_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    upsertRun: p(`INSERT INTO runs (run_id, created_at, status, mode, goal, label, config_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET mode = excluded.mode, goal = excluded.goal, label = excluded.label, config_json = excluded.config_json`),
    runCreated: p(`INSERT INTO runs (run_id, created_at, status, mode, goal, label, config_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET mode = excluded.mode, goal = excluded.goal, label = excluded.label, config_json = excluded.config_json, updated_at = excluded.updated_at`),
    runStatus: p(`UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?`),
    runCompleted: p(`UPDATE runs SET status = ?, summary_json = ?, updated_at = ? WHERE run_id = ?`),
    listRuns: p(`SELECT * FROM runs ORDER BY created_at DESC, run_id DESC`),
    getRun: p(`SELECT * FROM runs WHERE run_id = ?`),

    // events
    insertEvent: p(`INSERT OR IGNORE INTO events (run_id, seq, ts, t, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)`),
    events: p(`SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?`),
    lastSeq: p(`SELECT MAX(seq) AS s FROM events WHERE run_id = ?`),
    countEvents: p(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?`),

    // projections
    artifactSummary: p(`INSERT INTO artifacts (run_id, artifact_id, kind, title, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, artifact_id) DO UPDATE SET summary_json = excluded.summary_json`),
    candidateProposed: p(`INSERT INTO candidates (run_id, candidate_id, agent_id, name, summary) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, candidate_id) DO UPDATE SET agent_id = excluded.agent_id, name = excluded.name, summary = excluded.summary`),
    candidateEvaluated: p(`UPDATE candidates SET estimate_json = ?, valid = ?, issues_json = ? WHERE run_id = ? AND candidate_id = ?`),
    candidateSelected: p(`UPDATE candidates SET selected = (candidate_id = ?) WHERE run_id = ?`),
    // A full program saved via saveProgram wins over the event summary, whichever arrives first.
    programCompiled: p(`INSERT INTO programs (run_id, program_id, strategy, json, compiled_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, program_id) DO NOTHING`),
    taskCreated: p(`INSERT OR IGNORE INTO tasks (run_id, task_id, segment_id, phase_id, record_key, state, attempts, updated_t) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`),
    taskState: p(`UPDATE tasks SET state = ?1, worker_id = COALESCE(?2, worker_id), attempts = COALESCE(?3, attempts), last_error = COALESCE(?4, last_error), updated_t = ?5
      WHERE run_id = ?6 AND task_id = ?7`),
    taskTransition: p(`INSERT OR IGNORE INTO task_transitions (run_id, task_id, seq, state, t) VALUES (?, ?, ?, ?, ?)`),
    workerLease: p(`INSERT OR IGNORE INTO worker_leases (run_id, seq, worker_id, task_id, state, t) VALUES (?, ?, ?, ?, ?, ?)`),
    receipt: p(`INSERT OR IGNORE INTO verification_receipts (run_id, seq, task_id, record_key, node_id, status, fields_json, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    lockConflict: p(`INSERT OR IGNORE INTO lock_conflicts (run_id, seq, task_id, resource, holder, t) VALUES (?, ?, ?, ?, ?, ?)`),
    recovery: p(`INSERT OR IGNORE INTO recovery_attempts (run_id, seq, task_id, level, phase, reason, detail, ms, propagated_to, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    modelCall: p(`INSERT OR IGNORE INTO model_invocations (run_id, seq, provider, model, purpose, ms, input_tokens, output_tokens, cost_usd, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    stageStart: p(`INSERT OR IGNORE INTO stage_intervals (run_id, seq, stage, start_t, detail) VALUES (?, ?, ?, ?, ?)`),
    stageEnd: p(`UPDATE stage_intervals SET end_t = ?1, end_detail = ?2
      WHERE run_id = ?3 AND seq = (SELECT seq FROM stage_intervals WHERE run_id = ?3 AND stage = ?4 AND end_t IS NULL ORDER BY seq DESC LIMIT 1)`),
    scoutPage: p(`INSERT OR IGNORE INTO scout_pages (run_id, seq, agent_id, app, url, route_pattern, load_ms, controls, t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    // Mirrors the reducer: segmentIds/state/label/reason replace; effect only overwrites when present.
    fragment: p(`INSERT INTO fragments (run_id, fragment_id, phase_id, segment_ids_json, state, label, reason, effect, updated_t) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, fragment_id) DO UPDATE SET segment_ids_json = excluded.segment_ids_json, state = excluded.state, label = excluded.label,
        reason = excluded.reason, effect = COALESCE(excluded.effect, fragments.effect), updated_t = excluded.updated_t`),
    fragmentTransition: p(`INSERT OR IGNORE INTO fragment_transitions (run_id, seq, fragment_id, state, reason, t) VALUES (?, ?, ?, ?, ?, ?)`),

    // explicit saves
    saveArtifact: p(`INSERT INTO artifacts (run_id, artifact_id, kind, title, json, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, artifact_id) DO UPDATE SET kind = excluded.kind, title = excluded.title, json = excluded.json`),
    saveProgram: p(`INSERT INTO programs (run_id, program_id, strategy, json, compiled_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, program_id) DO UPDATE SET strategy = excluded.strategy, json = excluded.json`),
    saveObservation: p(`INSERT INTO observations (run_id, observation_id, app, url, route, fingerprint, json) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, observation_id) DO UPDATE SET app = excluded.app, url = excluded.url, route = excluded.route, fingerprint = excluded.fingerprint, json = excluded.json`),
    saveSpans: p(`INSERT INTO spans (run_id, json) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET json = excluded.json`),
    saveMetrics: p(`INSERT INTO metrics (run_id, key, value_json) VALUES (?, ?, ?) ON CONFLICT(run_id, key) DO UPDATE SET value_json = excluded.value_json`),

    // reads
    getArtifact: p(`SELECT json FROM artifacts WHERE run_id = ? AND artifact_id = ?`),
    listArtifacts: p(`SELECT artifact_id, kind, title, summary_json, json IS NOT NULL AS has_content, created_at FROM artifacts WHERE run_id = ? ORDER BY created_at, artifact_id`),
    getProgram: p(`SELECT json FROM programs WHERE run_id = ? ORDER BY compiled_at DESC, rowid DESC LIMIT 1`),
    observations: p(`SELECT * FROM observations WHERE run_id = ? ORDER BY observation_id`),
    getSpans: p(`SELECT json FROM spans WHERE run_id = ?`),
    getMetrics: p(`SELECT key, value_json FROM metrics WHERE run_id = ? ORDER BY key`),
    receipts: p(`SELECT * FROM verification_receipts WHERE run_id = ? ORDER BY seq`),
    tasks: p(`SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id`),
    transitions: p(`SELECT task_id, seq, state, t FROM task_transitions WHERE run_id = ? ORDER BY seq, task_id`),
    transitionsForTask: p(`SELECT task_id, seq, state, t FROM task_transitions WHERE run_id = ? AND task_id = ? ORDER BY seq`),
    stageIntervals: p(`SELECT * FROM stage_intervals WHERE run_id = ? ORDER BY seq`),
    scoutPages: p(`SELECT * FROM scout_pages WHERE run_id = ? ORDER BY seq`),
    fragments: p(`SELECT * FROM fragments WHERE run_id = ? ORDER BY fragment_id`),
    fragmentTransitions: p(`SELECT * FROM fragment_transitions WHERE run_id = ? ORDER BY seq`),
  };
}

