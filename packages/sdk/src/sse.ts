/**
 * Minimal Server-Sent Events parser (WHATWG "event stream interpretation"), written against
 * web streams so it works with any `fetch` implementation. Handles LF, CR, and CRLF line endings
 * (including a CRLF split across chunks), multi-line `data:`, comments, `id`, and `retry`.
 */

export interface SseMessage {
  /** Event type; "message" when the server sent no `event:` field. */
  event: string;
  /** Data lines joined with "\n". */
  data: string;
  /** The last event ID seen on the stream so far (persists across messages, per the spec). */
  id: string;
  /** Reconnection delay requested by the server, when this message carried a `retry:` field. */
  retry?: number | undefined;
}

export class SseParser {
  private buffer = "";
  private skipLeadingLf = false;
  private dataLines: string[] = [];
  private eventType = "";
  private lastEventId = "";
  private retry: number | undefined;

  /** Feeds decoded text; returns the messages completed by it. */
  feed(text: string): SseMessage[] {
    const out: SseMessage[] = [];
    let chunk = text;
    if (this.skipLeadingLf && chunk.length > 0) {
      if (chunk.charCodeAt(0) === 10) chunk = chunk.slice(1);
      this.skipLeadingLf = false;
    }
    const buf = this.buffer + chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.processLine(buf.slice(start, i), out);
      if (c === 13) {
        if (i + 1 < buf.length) {
          if (buf.charCodeAt(i + 1) === 10) i++;
        } else {
          // CR at the end of this chunk: a LF at the start of the next one belongs to it.
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
    }
    this.buffer = buf.slice(start);
    return out;
  }

  private processLine(line: string, out: SseMessage[]): void {
    if (line === "") {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(":")) return; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.dataLines.push(value);
        break;
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastEventId = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value);
        break;
      default:
        break; // unknown fields are ignored
    }
  }

  private dispatch(out: SseMessage[]): void {
    const retry = this.retry;
    this.retry = undefined;
    if (this.dataLines.length === 0) {
      this.eventType = "";
      return;
    }
    out.push({ event: this.eventType || "message", data: this.dataLines.join("\n"), id: this.lastEventId, retry });
    this.dataLines = [];
    this.eventType = "";
  }
}

/**
 * Yields SSE messages from a response body. `onChunk` fires for every chunk received (events and
 * heartbeats alike) so callers can detect a silent connection. A message left incomplete when the
 * stream ends is discarded, as the spec requires. Stopping iteration early cancels the body.
 */
export async function* readSseMessages(body: ReadableStream<Uint8Array>, onChunk?: () => void): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk?.();
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    yield* parser.feed(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
