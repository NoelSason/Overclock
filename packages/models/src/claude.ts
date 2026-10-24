import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { FAST_PRICES, priceFor, usageCost, type ModelLedger, type Speed } from "./ledger";

export class ModelUnavailableError extends Error {}

/** A model stream delivered nothing for STREAM_IDLE_MS (a stalled connection never errors on its own). */
export class ModelStallError extends Error {}

const STREAM_IDLE_MS = Number(process.env.OVERCLOCK_MODEL_STREAM_IDLE_MS ?? 90_000);

/** Abort signal for one stream: follows the caller's signal, and fires after STREAM_IDLE_MS without an event. */
function stallGuard(outer: AbortSignal | undefined) {
  const ac = new AbortController();
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const onOuter = () => ac.abort(outer?.reason);
  if (outer?.aborted) ac.abort(outer.reason);
  else outer?.addEventListener("abort", onOuter, { once: true });
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ac.abort(new ModelStallError(`model stream stalled: no data for ${Math.round(STREAM_IDLE_MS / 1000)} s`));
    }, STREAM_IDLE_MS);
  };
  kick();
  return {
    signal: ac.signal,
    kick,
    get stalled() {
      return stalled;
    },
    done() {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly stopReason: string | null,
  ) {
    super(message);
  }
}

/** planner: plans and repairs. critic: the adversarial review that gates writes. helper: everything else. */
export type ClaudeRole = "planner" | "helper" | "critic";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  plannerModel: string;
  helperModel: string;
  plannerEffort: Effort;
  helperEffort: Effort;
  /** Inference speed for planner-role calls. `fast` applies only to models in FAST_PRICES. */
  plannerSpeed: Speed;
  /** Inference speed for helper-role calls (summaries, catalogs); same rule as plannerSpeed. */
  helperSpeed: Speed;
  criticModel: string;
  criticEffort: Effort;
  /** Inference speed for the critique; same rule as plannerSpeed. */
  criticSpeed: Speed;
}

export function claudeConfigFromEnv(): ClaudeConfig {
  const helperEffort = (process.env.OVERCLOCK_HELPER_EFFORT as Effort) || "low";
  // Planner and critic default to Opus 5.5 at fast speed: in paired 25-record trials it was the
  // fastest configuration that kept every record correct (docs/BENCHMARKS.md, "Planner speed").
  // A refused fast request falls back to standard speed on its own; OVERCLOCK_*_SPEED=standard
  // and OVERCLOCK_CRITIC_MODEL=claude-haiku-5-5 restore the earlier configuration.
  const speed = (v: string | undefined): Speed => (v === "standard" ? "standard" : "fast");
  return {
    plannerModel: process.env.OVERCLOCK_PLANNER_MODEL || "claude-opus-5-5",
    helperModel: process.env.OVERCLOCK_HELPER_MODEL || "claude-haiku-5-5",
    plannerEffort: (process.env.OVERCLOCK_PLANNER_EFFORT as Effort) || "low",
    helperEffort,
    plannerSpeed: speed(process.env.OVERCLOCK_PLANNER_SPEED),
    helperSpeed: process.env.OVERCLOCK_HELPER_SPEED === "fast" ? "fast" : "standard",
    criticModel: process.env.OVERCLOCK_CRITIC_MODEL || "claude-opus-5-5",
    criticEffort: (process.env.OVERCLOCK_CRITIC_EFFORT as Effort) || "low",
    criticSpeed: speed(process.env.OVERCLOCK_CRITIC_SPEED),
  };
}

/** Models that support the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** Beta header for `speed`. Some fast-capable models require it; it is harmless on the others. */
const FAST_MODE_BETA = "fast-mode-2026-02-01";

/**
 * Fast mode has its own rate limits and capacity. After the API refuses a fast request, fast
 * requests pause until this time so later calls don't each pay a failed round trip. A 400 that
 * names the speed setting means fast mode isn't available to this organization or model, which
 * disables it for the process. Module-level because the limits are per organization, not per run.
 */
let fastPausedUntil = 0;

/** A fast request the API refused for rate limits, capacity, or availability: safe to re-send at standard speed. */
export function fastUnavailable(err: unknown): boolean {
  if (!(err instanceof APIError)) return false;
  if (err.status === 429 || err.status === 529) return true;
  if (err.type === "rate_limit_error" || err.type === "overloaded_error") return true;
  return err.status === 400 && /\bspeed\b|fast[ -]mode/i.test(err.message);
}

function pauseFast(err: unknown): void {
  if (err instanceof APIError && err.status === 400) {
    fastPausedUntil = Number.POSITIVE_INFINITY;
    return;
  }
  const retryAfter = Number(err instanceof APIError ? err.headers?.get("retry-after") : NaN);
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000;
  fastPausedUntil = Math.max(fastPausedUntil, Date.now() + Math.min(ms, 300_000));
}

/** Test hook: clears a fast-mode pause left by an earlier refusal. */
export function resetFastModePause(): void {
  fastPausedUntil = 0;
}

/** An attempt's error, marked when its streamed text already reached a live consumer. */
type AttemptError = Error & { replayUnsafe?: boolean };

export interface ParseRequest<T extends z.ZodType> {
  role: ClaudeRole;
  purpose: string;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  /** Overrides the role's configured speed for this call. */
  speed?: Speed;
  signal?: AbortSignal;
}

export interface StreamParseRequest<T extends z.ZodType> extends ParseRequest<T> {
  /** Called with each text delta and the accumulated text (the JSON being generated). */
  onText?: (delta: string, snapshot: string) => void;
}

export interface ParseResult<T> {
  data: T;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  /** Speed the response reports it ran at. */
  speed: Speed;
}

/** Usage fields read from a response, with the optional `speed` the API reports. */
interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  speed?: Speed | null;
}

/**
 * Claude provider with typed (structured) outputs. Every response is schema-validated by the
 * SDK; callers still validate semantics (control ids, expressions) in the compiler.
 */
export class ClaudeProvider {
  private client: Anthropic | null = null;
  readonly available: boolean;
  readonly reason?: string | undefined;

  constructor(
    readonly config: ClaudeConfig,
    private readonly ledger: ModelLedger,
  ) {
    this.available = !!process.env.ANTHROPIC_API_KEY;
    if (!this.available) this.reason = "ANTHROPIC_API_KEY is not set";
  }

  modelFor(role: ClaudeRole): string {
    return role === "planner" ? this.config.plannerModel : role === "critic" ? this.config.criticModel : this.config.helperModel;
  }

  /** The speed a call is sent at: fast only when asked for, priced, and not paused after a refusal. */
  speedFor(req: { role: ClaudeRole; speed?: Speed | undefined }): Speed {
    const model = this.modelFor(req.role);
    const want = req.speed ?? (req.role === "planner" ? this.config.plannerSpeed : req.role === "critic" ? this.config.criticSpeed : this.config.helperSpeed);
    return want === "fast" && model in FAST_PRICES && Date.now() >= fastPausedUntil ? "fast" : "standard";
  }

  private get api(): Anthropic {
    if (!this.available) throw new ModelUnavailableError(this.reason ?? "Claude unavailable");
    this.client ??= new Anthropic({ maxRetries: 2, timeout: 240_000 });
    return this.client;
  }

  private effortFor(req: ParseRequest<z.ZodType>): Effort {
    return req.effort ?? (req.role === "planner" ? this.config.plannerEffort : req.role === "critic" ? this.config.criticEffort : this.config.helperEffort);
  }

  /** Body fields shared by every request: server-side fallbacks and the inference speed. */
  private routing(model: string, speed: Speed) {
    const fallback = FALLBACK_MODELS.has(model);
    const betas = [...(fallback ? ["server-side-fallback-2026-07-01"] : []), ...(speed === "fast" ? [FAST_MODE_BETA] : [])];
    return {
      ...(betas.length ? { betas } : {}),
      ...(fallback ? { fallbacks: "default" as const } : {}),
      ...(speed === "fast" ? { speed: "fast" as const } : {}),
    };
  }

  /** Fast requests skip the SDK's own retries: a refusal falls back to standard speed at once. */
  private options(speed: Speed, signal: AbortSignal | undefined) {
    return { signal, ...(speed === "fast" ? { maxRetries: 0 } : {}) };
  }

  /** Projected spend for the budget guard, priced at the speed being requested. */
  private guard(model: string, speed: Speed, system: string, user: string, maxTokens: number): void {
    const price = priceFor(model, speed);
    this.ledger.guard(((system.length + user.length) / 3.5 / 1e6) * price.input + (maxTokens / 1e6) * price.output * 0.5);
  }

  /** Tokens and cost of a response, priced by the model and speed the response reports. */
  private account(model: string, speed: Speed, response: { model?: string | null; usage: ResponseUsage }) {
    const u = response.usage;
    const actualModel = response.model ?? model;
    const actualSpeed: Speed = u.speed ?? speed;
    const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return { model: actualModel, speed: actualSpeed, input, output: u.output_tokens, costUsd: usageCost(priceFor(actualModel, actualSpeed), u) };
  }

  /** Records a failed attempt and marks whether its text already reached a live consumer. */
  private failed(err: unknown, at: { model: string; purpose: string; speed: Speed; start: number; ttftMs: number | null; stalled: boolean; textDelivered: boolean }): AttemptError {
    const e: AttemptError = at.stalled ? new ModelStallError(`model stream stalled: no data for ${Math.round(STREAM_IDLE_MS / 1000)} s`) : (err as Error);
    const fallback = at.speed === "fast" && !at.textDelivered && fastUnavailable(e);
    const message = `${fallback ? "fast mode unavailable, retrying at standard speed: " : ""}${e.message}`;
    this.ledger.record({ provider: "anthropic", model: at.model, purpose: at.purpose, ms: performance.now() - at.start, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: message.slice(0, 200), speed: at.speed, ttftMs: at.ttftMs });
    return Object.assign(e, { replayUnsafe: at.textDelivered });
  }

  /**
   * Runs one request with the retries that are safe: a fast request the API refuses for rate
   * limits or capacity is re-sent at standard speed, and a stalled stream is re-sent once. Neither
   * happens after streamed text reached a live consumer: replaying deltas into it (the incremental
   * compiler) would corrupt what it has already consumed.
   */
  private async withRetries<R>(speed: Speed, signal: AbortSignal | undefined, run: (speed: Speed) => Promise<R>): Promise<R> {
    let stallRetried = false;
    for (;;) {
      try {
        return await run(speed);
      } catch (err) {
        if ((err as AttemptError).replayUnsafe || signal?.aborted) throw err;
        if (speed === "fast" && fastUnavailable(err)) {
          pauseFast(err);
          speed = "standard";
          continue;
        }
        if (err instanceof ModelStallError && !stallRetried) {
          stallRetried = true;
          continue;
        }
        throw err;
      }
    }
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<ParseResult<z.infer<T>>> {
    const model = this.modelFor(req.role);
    return this.withRetries(this.speedFor(req), req.signal, async (speed) => {
      this.guard(model, speed, req.system, req.user, req.maxTokens ?? 16_000);
      const start = performance.now();
      let response;
      try {
        response = await this.api.beta.messages.parse(
          {
            model,
            max_tokens: req.maxTokens ?? 16_000,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { format: betaZodOutputFormat(req.schema), effort: this.effortFor(req) },
            ...this.routing(model, speed),
          },
          this.options(speed, req.signal),
        );
      } catch (err) {
        throw this.failed(err, { model, purpose: req.purpose, speed, start, ttftMs: null, stalled: false, textDelivered: false });
      }
      const ms = performance.now() - start;
      const a = this.account(model, speed, response);
      const ok = response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens" && response.parsed_output != null;
      this.ledger.record({ provider: "anthropic", model: a.model, purpose: req.purpose, ms, inputTokens: a.input, outputTokens: a.output, costUsd: a.costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}`, speed: a.speed, ttftMs: null });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (response.parsed_output == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: response.parsed_output as z.infer<T>, ms, inputTokens: a.input, outputTokens: a.output, costUsd: a.costUsd, model: a.model, speed: a.speed };
    });
  }

  /**
   * Streaming variant of parse(): the structured JSON arrives incrementally through `onText`, so
   * callers can act on completed parts (e.g. compile plan steps) before generation finishes.
   */
  async streamParse<T extends z.ZodType>(req: StreamParseRequest<T>): Promise<ParseResult<z.infer<T>> & { firstTextMs: number | null; ttftMs: number | null }> {
    const model = this.modelFor(req.role);
    return this.withRetries(this.speedFor(req), req.signal, async (speed) => {
      this.guard(model, speed, req.system, req.user, req.maxTokens ?? 16_000);
      const start = performance.now();
      let firstTextMs: number | null = null;
      let ttftMs: number | null = null;
      const guard = stallGuard(req.signal);
      let response;
      try {
        const stream = this.api.beta.messages.stream(
          {
            model,
            max_tokens: req.maxTokens ?? 16_000,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { format: betaZodOutputFormat(req.schema), effort: this.effortFor(req) },
            ...this.routing(model, speed),
          },
          this.options(speed, guard.signal),
        );
        stream.on("streamEvent", (ev) => {
          guard.kick();
          if (ttftMs === null && ev.type === "content_block_delta") ttftMs = performance.now() - start;
        });
        stream.on("text", (delta, snapshot) => {
          firstTextMs ??= performance.now() - start;
          req.onText?.(delta, snapshot);
        });
        response = await stream.finalMessage();
      } catch (err) {
        throw this.failed(err, { model, purpose: req.purpose, speed, start, ttftMs, stalled: guard.stalled, textDelivered: !!req.onText && firstTextMs !== null });
      } finally {
        guard.done();
      }
      const ms = performance.now() - start;
      const a = this.account(model, speed, response);
      let parsed: unknown = response.parsed_output;
      if (parsed == null) {
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const r = req.schema.safeParse((() => {
          try {
            return JSON.parse(text);
          } catch {
            return undefined;
          }
        })());
        parsed = r.success ? r.data : null;
      }
      const ok = response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens" && parsed != null;
      this.ledger.record({ provider: "anthropic", model: a.model, purpose: req.purpose, ms, inputTokens: a.input, outputTokens: a.output, costUsd: a.costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}`, speed: a.speed, ttftMs });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (parsed == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: parsed as z.infer<T>, ms, inputTokens: a.input, outputTokens: a.output, costUsd: a.costUsd, model: a.model, speed: a.speed, firstTextMs, ttftMs };
    });
  }

  /**
   * JSON output without grammar-constrained decoding, for schemas too large for structured
   * outputs. The schema is described in the prompt by the caller; the response is extracted,
   * normalized, and validated with zod. One repair round re-asks with the exact validation errors.
   * Streams text through `onText` when provided.
   */
  async json<T extends z.ZodType>(req: StreamParseRequest<T> & { normalize?: (raw: unknown) => unknown }): Promise<ParseResult<z.infer<T>> & { firstTextMs: number | null; ttftMs: number | null; repaired: boolean }> {
    const model = this.modelFor(req.role);
    const attempt = async (user: string, onText: ((d: string, s: string) => void) | undefined, speed: Speed) => {
      this.guard(model, speed, req.system, user, req.maxTokens ?? 16_000);
      const start = performance.now();
      let firstTextMs: number | null = null;
      let ttftMs: number | null = null;
      const guard = stallGuard(req.signal);
      try {
        const stream = this.api.beta.messages.stream(
          {
            model,
            max_tokens: req.maxTokens ?? 16_000,
            system: req.system,
            messages: [{ role: "user", content: user }],
            output_config: { effort: this.effortFor(req) },
            ...this.routing(model, speed),
          },
          this.options(speed, guard.signal),
        );
        stream.on("streamEvent", (ev) => {
          guard.kick();
          if (ttftMs === null && ev.type === "content_block_delta") ttftMs = performance.now() - start;
        });
        stream.on("text", (delta, snapshot) => {
          firstTextMs ??= performance.now() - start;
          onText?.(delta, snapshot);
        });
        const response = await stream.finalMessage();
        const ms = performance.now() - start;
        const a = this.account(model, speed, response);
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return { response, text, ms, ...a, firstTextMs, ttftMs };
      } catch (err) {
        throw this.failed(err, { model, purpose: req.purpose, speed, start, ttftMs, stalled: guard.stalled, textDelivered: !!onText && firstTextMs !== null });
      } finally {
        guard.done();
      }
    };
    const call = (user: string, onText?: (d: string, s: string) => void) => this.withRetries(this.speedFor(req), req.signal, (speed) => attempt(user, onText, speed));
    const extract = (text: string): { ok: true; value: z.infer<T> } | { ok: false; error: string } => {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
      const raw = (fenced ? fenced[1]! : text).trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < start) return { ok: false, error: "no JSON object found in the response" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.slice(start, end + 1));
      } catch (e) {
        return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
      }
      const r = req.schema.safeParse(req.normalize ? req.normalize(parsed) : parsed);
      if (!r.success) return { ok: false, error: r.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      return { ok: true, value: r.data };
    };
    const first = await call(req.user, req.onText);
    const out = extract(first.text);
    let total = { ms: first.ms, input: first.input, output: first.output, costUsd: first.costUsd };
    const finish = (ok: boolean, error?: string) => this.ledger.record({ provider: "anthropic", model: first.model, purpose: req.purpose, ms: first.ms, inputTokens: first.input, outputTokens: first.output, costUsd: first.costUsd, ok, error, speed: first.speed, ttftMs: first.ttftMs });
    if (first.response.stop_reason === "refusal") {
      finish(false, "stop_reason=refusal");
      throw new ModelOutputError("The model declined the request", "refusal");
    }
    if (out.ok) {
      finish(true);
      return { data: out.value, ms: total.ms, inputTokens: total.input, outputTokens: total.output, costUsd: total.costUsd, model: first.model, speed: first.speed, firstTextMs: first.firstTextMs, ttftMs: first.ttftMs, repaired: false };
    }
    finish(false, `invalid output: ${out.error.slice(0, 160)}`);
    const repairUser = `${req.user}\n\n<previous_response_invalid>\nYour previous response could not be used: ${out.error}\nReturn the complete corrected JSON object only.\nPrevious response (truncated):\n${first.text.slice(0, 12_000)}\n</previous_response_invalid>`;
    const second = await call(repairUser);
    const out2 = extract(second.text);
    this.ledger.record({ provider: "anthropic", model: second.model, purpose: `${req.purpose}.repair`, ms: second.ms, inputTokens: second.input, outputTokens: second.output, costUsd: second.costUsd, ok: out2.ok, error: out2.ok ? undefined : out2.error.slice(0, 160), speed: second.speed, ttftMs: second.ttftMs });
    total = { ms: total.ms + second.ms, input: total.input + second.input, output: total.output + second.output, costUsd: total.costUsd + second.costUsd };
    if (!out2.ok) throw new ModelOutputError(`Output failed validation twice: ${out2.error}`, second.response.stop_reason ?? null);
    return { data: out2.value, ms: total.ms, inputTokens: total.input, outputTokens: total.output, costUsd: total.costUsd, model: second.model, speed: second.speed, firstTextMs: first.firstTextMs, ttftMs: first.ttftMs, repaired: true };
  }
}
