/**
 * Additive-increase / multiplicative-decrease concurrency controller per application.
 *
 * Every window it compares completed-task throughput and latency with the previous window:
 * it adds one slot while throughput keeps improving and errors stay low, and halves the limit
 * on throttling (429), timeouts, or an error-rate spike. Latency inflation without throughput
 * gain also stops growth (queueing at the server, not useful work).
 */
export interface AimdOptions {
  min: number;
  max: number;
  initial: number;
  windowMs: number;
  /** Error ratio in a window that triggers a decrease. */
  errorThreshold: number;
}

export interface AimdDecision {
  limit: number;
  changed: boolean;
  reason: string;
}

interface Window {
  start: number;
  completions: number;
  latencies: number[];
  errors: number;
  throttles: number;
}

export class AimdController {
  limit: number;
  private win: Window;
  private prev: { throughput: number; p50: number } | null = null;
  private cooldownUntil = 0;
  readonly history: { t: number; limit: number; reason: string }[] = [];

  constructor(
    readonly app: string,
    private readonly opts: AimdOptions,
    private readonly now: () => number,
  ) {
    this.limit = Math.max(opts.min, Math.min(opts.max, opts.initial));
    this.win = this.fresh();
  }

  private fresh(): Window {
    return { start: this.now(), completions: 0, latencies: [], errors: 0, throttles: 0 };
  }

  record(outcome: { ms: number; ok: boolean; throttled?: boolean; timeout?: boolean }): AimdDecision | null {
    if (outcome.ok) {
      this.win.completions++;
      this.win.latencies.push(outcome.ms);
    } else {
      this.win.errors++;
      if (outcome.throttled || outcome.timeout) this.win.throttles++;
    }
    // React to throttling immediately rather than waiting for the window to close.
    if (this.win.throttles >= 2 && this.now() >= this.cooldownUntil) return this.decrease("throttled by the application (429/timeouts)");
    return this.maybeAdjust();
  }

  private decrease(reason: string): AimdDecision {
    const next = Math.max(this.opts.min, Math.floor(this.limit / 2));
    const changed = next !== this.limit;
    this.limit = next;
    this.cooldownUntil = this.now() + this.opts.windowMs * 2;
    this.prev = null;
    this.win = this.fresh();
    if (changed) this.history.push({ t: this.now(), limit: next, reason });
    return { limit: next, changed, reason };
  }

  private maybeAdjust(): AimdDecision | null {
    const elapsed = this.now() - this.win.start;
    if (elapsed < this.opts.windowMs) return null;
    const w = this.win;
    this.win = this.fresh();
    const total = w.completions + w.errors;
    if (total === 0) return null;
    const errRate = w.errors / total;
    const throughput = w.completions / (elapsed / 1000);
    const sorted = [...w.latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : Infinity;
    const prev = this.prev;
    this.prev = { throughput, p50 };
    if (errRate > this.opts.errorThreshold && this.now() >= this.cooldownUntil) return this.decrease(`error rate ${(errRate * 100).toFixed(0)}% in last window`);
    if (this.now() < this.cooldownUntil) return null;
    if (this.limit >= this.opts.max) return null;
    if (prev && throughput < prev.throughput * 1.03 && p50 > prev.p50 * 1.25) {
      return { limit: this.limit, changed: false, reason: "latency rising without throughput gain; holding" };
    }
    this.limit++;
    this.history.push({ t: this.now(), limit: this.limit, reason: prev ? `throughput ${throughput.toFixed(2)}/s (prev ${prev.throughput.toFixed(2)}/s), errors ${(errRate * 100).toFixed(0)}%` : "first window healthy" });
    return { limit: this.limit, changed: true, reason: this.history.at(-1)!.reason };
  }
}
