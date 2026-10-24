import type { EventPayload, EventSink, RunEvent } from "@overclock/contracts";
import { redact } from "./redact";

export type EventListener = (event: RunEvent) => void;

/**
 * Per-run append-only event stream. Assigns sequence numbers and monotonic timestamps,
 * persists through the optional `persist` hook before notifying listeners.
 */
export class EventBus implements EventSink {
  private seq = 0;
  private readonly t0 = performance.now();
  private readonly listeners = new Set<EventListener>();
  readonly events: RunEvent[] = [];

  constructor(
    readonly runId: string,
    private readonly persist?: (e: RunEvent) => void,
    private readonly keepInMemory = true,
  ) {}

  /** Monotonic ms since run start. */
  now(): number {
    return performance.now() - this.t0;
  }

  emit(payload: EventPayload): RunEvent {
    const event = { ...redact(payload), runId: this.runId, seq: ++this.seq, ts: Date.now(), t: Math.round(this.now() * 10) / 10 } as RunEvent;
    this.persist?.(event);
    if (this.keepInMemory) this.events.push(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // listeners must never break the run
      }
    }
    return event;
  }

  subscribe(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get lastSeq(): number {
    return this.seq;
  }
}
