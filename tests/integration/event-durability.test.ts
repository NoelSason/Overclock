import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import type { RunEvent } from "@overclock/contracts";
import { EngineStore } from "../../services/engine/src/store";

/**
 * Which events are durable when appendEvent returns. Read through a second SQLite connection,
 * which sees only committed data and doesn't flush the store's queue.
 */

const dir = mkdtempSync(join(tmpdir(), "oc-durability-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ev = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent => ({ runId: "r1", seq, ts: Date.now(), t: seq, type, ...extra }) as unknown as RunEvent;
const committed = (path: string): { seq: number; type: string }[] => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT seq, type FROM events WHERE run_id = 'r1' ORDER BY seq").all() as { seq: number; type: string }[];
  } finally {
    db.close();
  }
};

describe("event durability", () => {
  const path = join(dir, "engine.db");
  const store = new EngineStore(path);

  it("commits a task state before appendEvent returns, and queued observability events ahead of it, in order", async () => {
    store.appendEvent(ev(1, "worker.state", { workerId: "w1", state: "LEASED", taskId: "t1" }));
    store.appendEvent(ev(2, "action", { taskId: "t1", nodeId: "n", actionType: "navigate", ms: 5, ok: true, modelCalls: 0 }));
    // Observability events wait for the group commit...
    expect(committed(path)).toEqual([]);
    // ...until a recovery-relevant event arrives: it commits them first, then itself.
    store.appendEvent(ev(3, "task.state", { taskId: "t1", state: "RUNNING" }));
    expect(committed(path).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("commits queued observability events by the next event-loop turn without any read", async () => {
    store.appendEvent(ev(4, "action", { taskId: "t1", nodeId: "n", actionType: "click", ms: 5, ok: true, modelCalls: 0 }));
    expect(committed(path).map((r) => r.seq)).toEqual([1, 2, 3]);
    await new Promise((r) => setImmediate(r));
    expect(committed(path).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("reads through the store see every event at once, and close commits the queue", () => {
    store.appendEvent(ev(5, "worker.state", { workerId: "w1", state: "IDLE" }));
    expect(store.events("r1", 0, 10).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    store.appendEvent(ev(6, "worker.state", { workerId: "w1", state: "LEASED", taskId: "t2" }));
    store.close();
    expect(committed(path).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
