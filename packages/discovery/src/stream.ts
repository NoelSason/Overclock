/**
 * Incremental JSON watcher for streamed plans. Feed it text deltas; it reports, as soon as they
 * are complete in the stream:
 *  - each phase header (every phase field that precedes its "steps" array),
 *  - each step object inside phases[i].steps,
 *  - each completed phase object.
 * It never re-parses the whole buffer: a single character-level pass tracks strings, escapes,
 * and the container stack with the key path of every open container.
 */

export interface PlanStreamHandlers {
  onPhaseHeader?(index: number, header: Record<string, unknown>): void;
  onStep?(phaseIndex: number, stepIndex: number, step: Record<string, unknown>): void;
  onPhaseEnd?(index: number, phase: Record<string, unknown>): void;
  onError?(err: Error): void;
}

interface Frame {
  type: "object" | "array";
  start: number;
  /** For objects: key currently being read / last completed key. For arrays: element index. */
  key: string | null;
  index: number;
  /** Position where the current key's string starts (objects). */
  keyStart: number;
  /** Path of this container from the root, e.g. ["phases", 0, "steps", 2]. */
  path: (string | number)[];
}

export class PlanStreamWatcher {
  private buf = "";
  private pos = 0;
  private stack: Frame[] = [];
  private inString = false;
  private escape = false;
  private stringStart = -1;
  /** True when the string being read is an object key (vs a value). */
  private stringIsKey = false;
  private expectKey = false;
  private lastKey: string | null = null;
  private readonly headerSent = new Set<number>();
  private started = false;

  constructor(private readonly h: PlanStreamHandlers) {}

  push(delta: string): void {
    this.buf += delta;
    try {
      this.scan();
    } catch (err) {
      // Only parser bugs land here; skip the offending character so the stream stays in sync.
      this.pos++;
      this.h.onError?.(err as Error);
    }
  }

  /** Handler failures must never desynchronize the parser. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.h.onError?.(err as Error);
    }
  }

  private top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  private childPath(): (string | number)[] {
    const t = this.top();
    if (!t) return [];
    return t.type === "object" ? [...t.path, t.key ?? "?"] : [...t.path, t.index];
  }

  private scan(): void {
    const s = this.buf;
    for (; this.pos < s.length; this.pos++) {
      const c = s[this.pos]!;
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') {
          this.inString = false;
          if (this.stringIsKey) {
            const t = this.top()!;
            t.key = JSON.parse(s.slice(this.stringStart, this.pos + 1)) as string;
            t.keyStart = this.stringStart;
            this.lastKey = t.key;
            this.expectKey = false;
          }
        }
        continue;
      }
      if (!this.started) {
        if (c === "{") this.started = true;
        else continue;
      }
      switch (c) {
        case '"': {
          this.inString = true;
          this.stringStart = this.pos;
          const t = this.top();
          this.stringIsKey = !!t && t.type === "object" && this.expectKey;
          break;
        }
        case "{":
        case "[": {
          const path = this.childPath();
          this.stack.push({ type: c === "{" ? "object" : "array", start: this.pos, key: null, index: 0, keyStart: -1, path });
          this.expectKey = c === "{";
          // Phase header: the "steps" array inside phases[i] is opening.
          if (c === "[" && path.length === 3 && path[0] === "phases" && typeof path[1] === "number" && path[2] === "steps") {
            const phaseFrame = this.stack[this.stack.length - 2]!;
            this.emitHeader(path[1], phaseFrame);
          }
          break;
        }
        case "}":
        case "]": {
          const f = this.stack.pop();
          if (!f) break;
          const p = f.path;
          if (f.type === "object" && p.length === 4 && p[0] === "phases" && typeof p[1] === "number" && p[2] === "steps" && typeof p[3] === "number") {
            const step = JSON.parse(s.slice(f.start, this.pos + 1)) as Record<string, unknown>;
            const [pi, si] = [p[1], p[3]];
            this.safe(() => this.h.onStep?.(pi, si, step));
          } else if (f.type === "object" && p.length === 2 && p[0] === "phases" && typeof p[1] === "number") {
            const phase = JSON.parse(s.slice(f.start, this.pos + 1)) as Record<string, unknown>;
            const pi = p[1];
            if (!this.headerSent.has(pi)) {
              const { steps: _s, ...header } = phase;
              this.headerSent.add(pi);
              this.safe(() => this.h.onPhaseHeader?.(pi, header));
            }
            this.safe(() => this.h.onPhaseEnd?.(pi, phase));
          }
          this.expectKey = false;
          break;
        }
        case ",": {
          const t = this.top();
          if (t?.type === "array") t.index++;
          else if (t?.type === "object") this.expectKey = true;
          break;
        }
        default:
          break;
      }
    }
  }

  /** Close the partial phase object right before "steps" and parse the fields seen so far. */
  private emitHeader(index: number, phaseFrame: Frame): void {
    if (this.headerSent.has(index) || phaseFrame.keyStart < 0) return;
    const partial = this.buf.slice(phaseFrame.start, phaseFrame.keyStart).replace(/,\s*$/, "") + "}";
    try {
      const header = JSON.parse(partial) as Record<string, unknown>;
      if (!("id" in header) || !("kind" in header)) return; // fields arrive later; the phase end will report them
      this.headerSent.add(index);
      this.safe(() => this.h.onPhaseHeader?.(index, header));
    } catch {
      // incomplete header (unexpected key order); reported at phase end instead
    }
  }

  get text(): string {
    return this.buf;
  }
}
