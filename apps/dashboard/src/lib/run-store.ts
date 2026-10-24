import { applyEvent, createRunView } from "@overclock/contracts";
import type { EventType, RunEvent, RunView } from "@overclock/contracts";
import { engine, errorMessage } from "./api";

/**
 * Client-side run state.
 *
 * The store owns one mutable `RunView` and feeds it every event through the shared reducer
 * (`applyEvent`), exactly like the engine does. Loading is two-phase: page through
 * `/events` from seq 0, then follow `/stream` from the last applied seq. Because the reducer
 * ignores seq numbers it has already applied, a reload or reconnect rebuilds identical state.
 *
 * Rendering is decoupled from event arrival: incoming events are queued and applied once per
 * animation frame, and each panel subscribes to the "slices" of the view it reads. A slice's
 * version bumps only when an event that touches it is applied, so a burst of worker events
 * does not re-render the swarm map, and so on.
 */

export type Slice = "meta" | "stages" | "swarm" | "candidates" | "program" | "fragments" | "tasks" | "workers" | "telemetry" | "approvals" | "network";

/**
 * Event type -> slice. Partial on purpose: an event type added to the contracts later still
 * flows through the reducer and lands in "meta" until a panel claims it.
 */
const SLICE_OF: Partial<Record<EventType, Slice>> = {
  "run.created": "meta",
  "run.status": "meta",
  "run.completed": "meta",
  "policy.decision": "swarm",
  "agent.started": "swarm",
  "agent.artifact": "swarm",
  "agent.finished": "swarm",
  "candidate.proposed": "candidates",
  "candidate.evaluated": "candidates",
  "candidate.selected": "candidates",
  "program.compiled": "program",
  "program.patched": "program",
  "tasks.created": "tasks",
  "task.state": "tasks",
  "worker.state": "workers",
  "worker.thumb": "workers",
  action: "telemetry",
  receipt: "telemetry",
  "lock.conflict": "telemetry",
  recovery: "telemetry",
  invalidation: "telemetry",
  "model.call": "telemetry",
  concurrency: "telemetry",
  "reopt.decision": "candidates",
  "approval.requested": "approvals",
  "approval.resolved": "approvals",
  log: "meta",
  stage: "stages",
  "scout.page": "swarm",
  fragment: "fragments",
  "network.lookup": "network",
  "network.import": "network",
  "network.publish": "network",
  "network.repair": "network",
  "network.update": "network",
};

export type ConnectionState = "loading" | "live" | "reconnecting" | "ended" | "error";

export interface ConnectionInfo {
  state: ConnectionState;
  error?: string | undefined;
}

const PAGE_LIMIT = 1000;
const RECONNECT_MS = 1500;

export class RunStore {
  readonly runId: string;
  readonly view: RunView;
  connection: ConnectionInfo = { state: "loading" };

  private readonly versions: Record<Slice | "connection", number> = { meta: 0, stages: 0, swarm: 0, candidates: 0, program: 0, fragments: 0, tasks: 0, workers: 0, telemetry: 0, approvals: 0, network: 0, connection: 0 };
  private readonly listeners = new Set<() => void>();
  private queue: RunEvent[] = [];
  private frame: number | null = null;
  private source: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly abort = new AbortController();
  private backfilling = false;
  /** Highest seq we have confirmed (via /events) has no missing predecessors. */
  private gapCheckedUpTo = 0;
  private disposed = false;

  constructor(runId: string) {
    this.runId = runId;
    this.view = createRunView(runId);
  }

  start(): void {
    this.backfill()
      .then(() => this.openStream())
      .catch(() => this.scheduleReconnect());
  }

  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.closeStream();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.listeners.clear();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Sum of the requested slice versions: changes whenever any of them changes. */
  version(slices: readonly (Slice | "connection")[]): number {
    let v = 0;
    for (const s of slices) v += this.versions[s];
    return v;
  }

  // ---------------------------------------------------------------------------------------

  /** Page through `/events` until the server has nothing newer than what we applied. */
  private async backfill(): Promise<void> {
    if (this.backfilling || this.disposed) return;
    this.backfilling = true;
    try {
      for (;;) {
        const page = await engine.events(this.runId, this.view.lastSeq, PAGE_LIMIT, this.abort.signal);
        if (this.disposed) return;
        if (page.events.length === 0) break;
        const before = this.view.lastSeq;
        this.applyAll(page.events);
        this.gapCheckedUpTo = Math.max(this.gapCheckedUpTo, this.view.lastSeq);
        this.notify();
        if (this.view.lastSeq === before) break; // server returned only already-applied events
      }
    } catch (err) {
      if (this.disposed) return;
      this.setConnection({ state: "error", error: errorMessage(err) });
      throw err;
    } finally {
      this.backfilling = false;
    }
  }

  private openStream(): void {
    if (this.disposed) return;
    this.closeStream();
    const es = new EventSource(engine.streamUrl(this.runId, this.view.lastSeq));
    this.source = es;
    const onEvent = (msg: MessageEvent<string>) => {
      try {
        this.enqueue(JSON.parse(msg.data) as RunEvent);
      } catch {
        // Ignore malformed frames; the next backfill will recover anything missed.
      }
    };
    es.addEventListener("run-event", onEvent);
    es.onmessage = onEvent;
    es.addEventListener("end", () => {
      this.flush();
      this.closeStream();
      this.setConnection({ state: "ended" });
    });
    es.onopen = () => this.setConnection({ state: "live", error: undefined });
    es.onerror = () => {
      if (this.disposed || this.connection.state === "ended") return;
      // The browser retries on its own (sending Last-Event-ID) unless the connection is closed.
      if (es.readyState === EventSource.CLOSED) this.scheduleReconnect();
      else this.setConnection({ state: "reconnecting" });
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.closeStream();
    if (this.connection.state !== "error") this.setConnection({ state: "reconnecting" });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backfill()
        .then(() => this.openStream())
        .catch(() => this.scheduleReconnect());
    }, RECONNECT_MS);
  }

  private closeStream(): void {
    if (this.source) {
      this.source.onerror = null;
      this.source.close();
      this.source = null;
    }
  }

  private enqueue(ev: RunEvent): void {
    this.queue.push(ev);
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.flush());
  }

  /** Apply queued events in seq order. A seq gap pauses the queue until `/events` fills it. */
  private flush(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (this.disposed || this.backfilling || this.queue.length === 0) return;
    const pending = this.queue.sort((a, b) => a.seq - b.seq);
    this.queue = [];
    for (let i = 0; i < pending.length; i++) {
      const ev = pending[i]!;
      if (ev.seq <= this.view.lastSeq) continue;
      if (ev.seq > this.view.lastSeq + 1 && ev.seq > this.gapCheckedUpTo) {
        // Missing events between lastSeq and ev.seq: fetch them, then resume with the rest.
        this.queue = pending.slice(i);
        this.notify();
        this.gapCheckedUpTo = ev.seq;
        void this.backfill()
          .catch(() => undefined)
          .then(() => this.flush());
        return;
      }
      this.applyOne(ev);
    }
    this.notify();
  }

  private applyAll(events: RunEvent[]): void {
    for (const ev of events) this.applyOne(ev);
  }

  private applyOne(ev: RunEvent): void {
    if (ev.seq <= this.view.lastSeq) return;
    applyEvent(this.view, ev);
    this.versions[SLICE_OF[ev.type] ?? "meta"]++;
    this.dirty = true;
  }

  private dirty = false;

  private setConnection(patch: Partial<ConnectionInfo>): void {
    this.connection = { ...this.connection, ...patch };
    this.versions.connection++;
    this.dirty = true;
    this.notify();
  }

  private notify(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const l of this.listeners) l();
  }
}
