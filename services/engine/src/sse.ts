import type { ServerResponse } from "node:http";
import type { RunEvent } from "@overclock/contracts";
import type { RunHandle } from "./types";

/**
 * Server-Sent Events stream of one run's events.
 *
 * Ordering guarantee (no gaps, no duplicates across the replay -> live handoff and across
 * reconnects with Last-Event-ID): subscribe first and buffer live events, replay from
 * handle.events() in pages, then drain the buffer skipping anything with seq <= last sent.
 *
 * Backpressure: when the socket buffer is full we stop writing and resume on 'drain'. Live
 * events keep queueing in memory up to `maxQueue`; past that the queue is dropped and the
 * stream re-reads from handle.events() (the durable log) once the socket drains, so memory
 * stays bounded without losing events.
 */

export interface SseOptions {
  /** Replay events with seq > after. */
  after: number;
  /** Extra response headers (e.g. CORS). */
  headers?: Record<string, string> | undefined;
  heartbeatMs?: number | undefined;
  maxQueue?: number | undefined;
  /** Events per replay page / per socket write. */
  batchSize?: number | undefined;
}

export interface SseStream {
  /** Resolves when the stream is closed (finished, client gone, or closed by the server). */
  readonly done: Promise<void>;
  /** End the stream without the `end` event (e.g. server shutdown); clients reconnect and resume. */
  close(): void;
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

export const SSE_END = "event: end\ndata: {}\n\n";
export const SSE_PING = ": ping\n\n";

export function formatEvent(e: RunEvent): string {
  return `id: ${e.seq}\nevent: run-event\ndata: ${JSON.stringify(e)}\n\n`;
}

/** Parse a Last-Event-ID header; anything but a positive integer is ignored. */
export function parseLastEventId(header: string | string[] | undefined): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return 0;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function streamRun(res: ServerResponse, handle: RunHandle, opts: SseOptions): SseStream {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxQueue = opts.maxQueue ?? 50_000;
  const batchSize = opts.batchSize ?? 500;

  let cursor = Math.max(0, opts.after); // highest seq handed to the socket
  let live: RunEvent[] = [];
  let liveHead = 0;
  let caughtUp = false; // replay reached the end of handle.events()
  let waitingDrain = false;
  let scheduled = false;
  let closed = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  res.writeHead(200, { ...SSE_HEADERS, ...opts.headers });
  res.socket?.setNoDelay(true);
  res.flushHeaders();

  // Subscribe before the first replay read so nothing emitted in between can be missed.
  const unsubscribe = handle.subscribe((e) => {
    if (closed || e.seq <= cursor) return;
    live.push(e);
    if (live.length - liveHead > maxQueue) {
      // Slow client: drop the in-memory queue and re-read from the handle once drained.
      live = [];
      liveHead = 0;
      caughtUp = false;
    }
    schedule();
  });

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (!waitingDrain) res.write(SSE_PING);
    pump(); // also notices finished() if the final event raced the subscription
  }, heartbeatMs);

  const onDrain = (): void => {
    waitingDrain = false;
    pump();
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    live = [];
    res.off("drain", onDrain);
    resolveDone();
  };
  res.on("drain", onDrain);
  // ServerResponse 'close' fires on client disconnect (and after end); IncomingMessage 'close'
  // fires as soon as the request body is consumed, so it must not be used here.
  res.on("close", cleanup);
  res.on("error", cleanup);

  function schedule(): void {
    if (scheduled || closed) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      pump();
    });
  }

  /**
   * Write the events with seq > cursor as one chunk. Returns "blocked" when the socket asked
   * us to wait for 'drain', "empty" when nothing new was in `events`.
   */
  function write(events: readonly RunEvent[]): "ok" | "blocked" | "empty" {
    let chunk = "";
    for (const e of events) {
      if (e.seq <= cursor) continue;
      chunk += formatEvent(e);
      cursor = e.seq;
    }
    if (!chunk) return "empty";
    if (!res.write(chunk)) {
      waitingDrain = true;
      return "blocked";
    }
    return "ok";
  }

  function pump(): void {
    if (closed || waitingDrain) return;
    try {
      for (;;) {
        // 1) Replay (or re-read after an overflow) straight from the handle.
        while (!caughtUp) {
          const r = write(handle.events(cursor, batchSize));
          if (r === "blocked") return;
          if (r === "empty") caughtUp = true;
        }
        // 2) Drain live events, skipping what the replay already sent.
        while (liveHead < live.length) {
          const batch = live.slice(liveHead, liveHead + batchSize);
          liveHead += batch.length;
          if (liveHead >= live.length) {
            live = [];
            liveHead = 0;
          }
          if (write(batch) === "blocked") return;
        }
        // 3) Finish once the run is done and nothing is left to flush.
        if (!handle.finished()) return;
        const r = write(handle.events(cursor, batchSize));
        if (r === "blocked") return;
        if (r === "ok") continue;
        res.end(SSE_END);
        cleanup();
        return;
      }
    } catch {
      // A failing handle must not crash the server; the client reconnects with Last-Event-ID.
      if (!res.writableEnded) res.end();
      cleanup();
    }
  }

  pump();

  return {
    done,
    close(): void {
      if (closed) return;
      if (!res.writableEnded) res.end();
      cleanup();
    },
  };
}
