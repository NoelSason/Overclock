import type { DatabaseSync } from "node:sqlite";

/**
 * Numbered, forward-only schema migrations for the engine store.
 *
 * The append-only `events` table is the source of truth. Every other run table is a projection
 * written in the same transaction as the event that produced it (see store.ts), except
 * observations / metrics / spans / full artifacts, which come from explicit save calls.
 * Never edit a migration that has shipped; add a new one.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
CREATE TABLE runs (
  run_id       TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  status       TEXT NOT NULL,
  mode         TEXT NOT NULL,
  goal         TEXT NOT NULL,
  label        TEXT,
  config_json  TEXT NOT NULL,
  summary_json TEXT,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX runs_created_at ON runs (created_at DESC);

CREATE TABLE events (
  run_id       TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  t            REAL NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE programs (
  run_id      TEXT NOT NULL,
  program_id  TEXT NOT NULL,
  strategy    TEXT NOT NULL,
  json        TEXT NOT NULL,
  compiled_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, program_id)
);

CREATE TABLE tasks (
  run_id     TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  phase_id   TEXT NOT NULL,
  record_key TEXT NOT NULL,
  state      TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  worker_id  TEXT,
  last_error TEXT,
  updated_t  REAL NOT NULL,
  PRIMARY KEY (run_id, task_id)
) WITHOUT ROWID;
CREATE INDEX tasks_record ON tasks (run_id, record_key);

CREATE TABLE task_transitions (
  run_id  TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  state   TEXT NOT NULL,
  t       REAL NOT NULL,
  PRIMARY KEY (run_id, task_id, seq)
) WITHOUT ROWID;
CREATE TRIGGER task_transitions_no_update BEFORE UPDATE ON task_transitions BEGIN SELECT RAISE(ABORT, 'task_transitions are append-only'); END;

CREATE TABLE artifacts (
  run_id       TEXT NOT NULL,
  artifact_id  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  summary_json TEXT,
  json         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (run_id, artifact_id)
);

CREATE TABLE candidates (
  run_id        TEXT NOT NULL,
  candidate_id  TEXT NOT NULL,
  agent_id      TEXT,
  name          TEXT NOT NULL,
  summary       TEXT NOT NULL,
  estimate_json TEXT,
  valid         INTEGER,
  issues_json   TEXT NOT NULL DEFAULT '[]',
  selected      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, candidate_id)
);

CREATE TABLE model_invocations (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  ms            REAL NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  ok            INTEGER NOT NULL,
  error         TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE worker_leases (
  run_id    TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  task_id   TEXT,
  state     TEXT NOT NULL,
  t         REAL NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX worker_leases_worker ON worker_leases (run_id, worker_id);

CREATE TABLE lock_conflicts (
  run_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  task_id  TEXT NOT NULL,
  resource TEXT NOT NULL,
  holder   TEXT NOT NULL,
  t        REAL NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE verification_receipts (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  task_id     TEXT NOT NULL,
  record_key  TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  status      TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  t           REAL NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX verification_receipts_record ON verification_receipts (run_id, record_key);

CREATE TABLE recovery_attempts (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  task_id       TEXT NOT NULL,
  level         INTEGER NOT NULL,
  phase         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  detail        TEXT,
  ms            REAL,
  propagated_to INTEGER,
  t             REAL NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE observations (
  run_id         TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  app            TEXT NOT NULL,
  url            TEXT NOT NULL,
  route          TEXT,
  fingerprint    TEXT,
  json           TEXT NOT NULL,
  PRIMARY KEY (run_id, observation_id)
);
CREATE INDEX observations_fingerprint ON observations (app, fingerprint);

CREATE TABLE metrics (
  run_id     TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);

CREATE TABLE spans (
  run_id TEXT PRIMARY KEY,
  json   TEXT NOT NULL
);
`,
  },
];

/**
 * Apply every migration newer than the database's current version, each in its own
 * transaction. Safe to call on every open: already-applied versions are skipped.
 * Returns the resulting schema version.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const current = (): number => {
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get();
    return typeof row?.v === "number" ? row.v : 0;
  };
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const m of sorted) {
    if (m.version <= current()) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check inside the write lock: another process may have migrated meanwhile.
      if (m.version > current()) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
  return current();
}
