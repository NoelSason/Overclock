import { randomBytes } from "node:crypto";

/**
 * Minimal OpenTelemetry-compatible tracer. Spans use OTel ids and semantics and export as
 * OTLP/JSON (resourceSpans), so they load into any OTel backend, without pulling in the full SDK.
 */

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  startUnixNano: string;
  endUnixNano?: string | undefined;
  durationMs?: number | undefined;
  attributes: Record<string, string | number | boolean>;
  status: "unset" | "ok" | "error";
}

export class Span {
  private readonly startPerf = performance.now();
  constructor(
    private readonly tracer: Tracer,
    readonly record: SpanRecord,
  ) {}

  child(name: string, attributes: SpanRecord["attributes"] = {}): Span {
    return this.tracer.start(name, attributes, this);
  }

  set(attrs: SpanRecord["attributes"]): this {
    Object.assign(this.record.attributes, attrs);
    return this;
  }

  end(status: "ok" | "error" = "ok", attrs: SpanRecord["attributes"] = {}): number {
    const ms = performance.now() - this.startPerf;
    Object.assign(this.record.attributes, attrs);
    this.record.durationMs = Math.round(ms * 100) / 100;
    this.record.endUnixNano = (BigInt(this.record.startUnixNano) + BigInt(Math.round(ms * 1e6))).toString();
    this.record.status = status;
    this.tracer.finished(this.record);
    return ms;
  }
}

export class Tracer {
  readonly traceId = randomBytes(16).toString("hex");
  readonly spans: SpanRecord[] = [];
  private readonly epochNs = BigInt(Date.now()) * 1_000_000n - BigInt(Math.round(performance.now() * 1e6));

  constructor(
    private readonly service = "overclock-engine",
    private readonly onEnd?: (s: SpanRecord) => void,
    private readonly maxSpans = 50_000,
  ) {}

  start(name: string, attributes: SpanRecord["attributes"] = {}, parent?: Span): Span {
    const record: SpanRecord = {
      traceId: this.traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: parent?.record.spanId,
      name,
      startUnixNano: (this.epochNs + BigInt(Math.round(performance.now() * 1e6))).toString(),
      attributes: { ...attributes },
      status: "unset",
    };
    return new Span(this, record);
  }

  async time<T>(name: string, attributes: SpanRecord["attributes"], fn: (span: Span) => Promise<T>, parent?: Span): Promise<T> {
    const span = this.start(name, attributes, parent);
    try {
      const r = await fn(span);
      span.end("ok");
      return r;
    } catch (err) {
      span.end("error", { "error.message": String((err as Error).message).slice(0, 300) });
      throw err;
    }
  }

  finished(s: SpanRecord): void {
    if (this.spans.length < this.maxSpans) this.spans.push(s);
    this.onEnd?.(s);
  }

  /** Aggregate durations by span name (for bottleneck reports). */
  summary(): { name: string; count: number; totalMs: number; p50: number; p95: number }[] {
    const by = new Map<string, number[]>();
    for (const s of this.spans) if (s.durationMs !== undefined) (by.get(s.name) ?? by.set(s.name, []).get(s.name)!).push(s.durationMs);
    return [...by.entries()]
      .map(([name, xs]) => {
        xs.sort((a, b) => a - b);
        return { name, count: xs.length, totalMs: Math.round(xs.reduce((a, b) => a + b, 0)), p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) };
      })
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  toOtlpJson(): unknown {
    const attr = (attrs: SpanRecord["attributes"]) =>
      Object.entries(attrs).map(([key, v]) => ({ key, value: typeof v === "number" ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : typeof v === "boolean" ? { boolValue: v } : { stringValue: v } }));
    return {
      resourceSpans: [
        {
          resource: { attributes: attr({ "service.name": this.service }) },
          scopeSpans: [
            {
              scope: { name: "overclock" },
              spans: this.spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId,
                name: s.name,
                kind: 1,
                startTimeUnixNano: s.startUnixNano,
                endTimeUnixNano: s.endUnixNano,
                attributes: attr(s.attributes),
                status: { code: s.status === "ok" ? 1 : s.status === "error" ? 2 : 0 },
              })),
            },
          ],
        },
      ],
    };
  }
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return Math.round(sorted[i]! * 100) / 100;
}
