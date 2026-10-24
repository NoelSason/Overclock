/**
 * Incremental parser for the engine's Server-Sent Events. Chunks arrive in arbitrary pieces; a
 * message ends at a blank line. Comment lines (": ping") are heartbeats and are ignored.
 */
export interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

export class SseParser {
  private buffer = "";

  /** Feed a chunk; returns the complete messages it finished. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let id: string | null = null;
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "id") id = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length || event !== "message") out.push({ id, event, data: data.join("\n") });
    }
    return out;
  }
}
