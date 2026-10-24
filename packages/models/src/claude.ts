import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { priceFor, type ModelLedger } from "./ledger";

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

export type ClaudeRole = "planner" | "helper";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  plannerModel: string;
  helperModel: string;
  plannerEffort: Effort;
  helperEffort: Effort;
}

export function claudeConfigFromEnv(): ClaudeConfig {
  return {
    plannerModel: process.env.OVERCLOCK_PLANNER_MODEL || "claude-opus-5-5",
    helperModel: process.env.OVERCLOCK_HELPER_MODEL || "claude-haiku-5-5",
    plannerEffort: (process.env.OVERCLOCK_PLANNER_EFFORT as Effort) || "low",
    helperEffort: (process.env.OVERCLOCK_HELPER_EFFORT as Effort) || "low",
  };
}

/** Models that support the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface ParseRequest<T extends z.ZodType> {
  role: ClaudeRole;
  purpose: string;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  effort?: Effort;
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
    return role === "planner" ? this.config.plannerModel : this.config.helperModel;
  }

  private get api(): Anthropic {
    if (!this.available) throw new ModelUnavailableError(this.reason ?? "Claude unavailable");
    this.client ??= new Anthropic({ maxRetries: 2, timeout: 240_000 });
    return this.client;
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<ParseResult<z.infer<T>>> {
    const model = this.modelFor(req.role);
    const price = priceFor(model);
    const projected = ((req.system.length + req.user.length) / 3.5 / 1e6) * price.input + ((req.maxTokens ?? 16_000) / 1e6) * price.output * 0.5;
    this.ledger.guard(projected);
    const start = performance.now();
    const useFallback = FALLBACK_MODELS.has(model);
    try {
      const response = await this.api.beta.messages.parse(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? (req.role === "planner" ? this.config.plannerEffort : this.config.helperEffort) },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
      const ms = performance.now() - start;
      const u = response.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead;
      const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) / 1e6) * price.input + (cacheRead / 1e6) * (price.cacheRead ?? price.input * 0.1) + (u.output_tokens / 1e6) * price.output;
      const ok = response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens" && response.parsed_output != null;
      this.ledger.record({ provider: "anthropic", model: response.model ?? model, purpose: req.purpose, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}` });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (response.parsed_output == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: response.parsed_output as z.infer<T>, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, model: response.model ?? model };
    } catch (err) {
      if (err instanceof ModelOutputError) throw err;
      const ms = performance.now() - start;
      this.ledger.record({ provider: "anthropic", model, purpose: req.purpose, ms, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: (err as Error).message.slice(0, 200) });
      throw err;
    }
  }

  /**
   * Streaming variant of parse(): the structured JSON arrives incrementally through `onText`, so
   * callers can act on completed parts (e.g. compile plan steps) before generation finishes.
   */
  async streamParse<T extends z.ZodType>(req: StreamParseRequest<T>): Promise<ParseResult<z.infer<T>> & { firstTextMs: number | null }> {
    const model = this.modelFor(req.role);
    const price = priceFor(model);
    const projected = ((req.system.length + req.user.length) / 3.5 / 1e6) * price.input + ((req.maxTokens ?? 16_000) / 1e6) * price.output * 0.5;
    this.ledger.guard(projected);
    const start = performance.now();
    let firstTextMs: number | null = null;
    const useFallback = FALLBACK_MODELS.has(model);
    const guard = stallGuard(req.signal);
    try {
      const stream = this.api.beta.messages.stream(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? (req.role === "planner" ? this.config.plannerEffort : this.config.helperEffort) },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: guard.signal },
      );
      stream.on("streamEvent", guard.kick);
      stream.on("text", (delta, snapshot) => {
        firstTextMs ??= performance.now() - start;
        req.onText?.(delta, snapshot);
      });
      const response = await stream.finalMessage();
      const ms = performance.now() - start;
      const u = response.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead;
      const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) / 1e6) * price.input + (cacheRead / 1e6) * (price.cacheRead ?? price.input * 0.1) + (u.output_tokens / 1e6) * price.output;
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
      this.ledger.record({ provider: "anthropic", model: response.model ?? model, purpose: req.purpose, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}` });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (parsed == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: parsed as z.infer<T>, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, model: response.model ?? model, firstTextMs };
    } catch (err) {
      if (err instanceof ModelOutputError) throw err;
      const e = guard.stalled ? new ModelStallError(`model stream stalled: no data for ${Math.round(STREAM_IDLE_MS / 1000)} s`) : (err as Error);
      this.ledger.record({ provider: "anthropic", model, purpose: req.purpose, ms: performance.now() - start, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: e.message.slice(0, 200) });
      throw e;
    } finally {
      guard.done();
    }
  }

  /**
   * JSON output without grammar-constrained decoding, for schemas too large for structured
   * outputs. The schema is described in the prompt by the caller; the response is extracted,
   * normalized, and validated with zod. One repair round re-asks with the exact validation errors.
   * Streams text through `onText` when provided.
   */
  async json<T extends z.ZodType>(req: StreamParseRequest<T> & { normalize?: (raw: unknown) => unknown }): Promise<ParseResult<z.infer<T>> & { firstTextMs: number | null; repaired: boolean }> {
    const model = this.modelFor(req.role);
    const price = priceFor(model);
    const useFallback = FALLBACK_MODELS.has(model);
    const attempt = async (user: string, onText?: (d: string, s: string) => void) => {
      const projected = ((req.system.length + user.length) / 3.5 / 1e6) * price.input + ((req.maxTokens ?? 16_000) / 1e6) * price.output * 0.5;
      this.ledger.guard(projected);
      const start = performance.now();
      let firstTextMs: number | null = null;
      const guard = stallGuard(req.signal);
      try {
        const stream = this.api.beta.messages.stream(
          {
            model,
            max_tokens: req.maxTokens ?? 16_000,
            system: req.system,
            messages: [{ role: "user", content: user }],
            output_config: { effort: req.effort ?? (req.role === "planner" ? this.config.plannerEffort : this.config.helperEffort) },
            ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: guard.signal },
        );
        stream.on("streamEvent", guard.kick);
        stream.on("text", (delta, snapshot) => {
          firstTextMs ??= performance.now() - start;
          onText?.(delta, snapshot);
        });
        const response = await stream.finalMessage();
        const ms = performance.now() - start;
        const u = response.usage;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead;
        const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) / 1e6) * price.input + (cacheRead / 1e6) * (price.cacheRead ?? price.input * 0.1) + (u.output_tokens / 1e6) * price.output;
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return { response, text, ms, input, output: u.output_tokens, costUsd, firstTextMs };
      } catch (err) {
        const e = guard.stalled ? new ModelStallError(`model stream stalled: no data for ${Math.round(STREAM_IDLE_MS / 1000)} s`) : (err as Error);
        this.ledger.record({ provider: "anthropic", model, purpose: req.purpose, ms: performance.now() - start, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: e.message.slice(0, 200) });
        throw Object.assign(e, { textDelivered: firstTextMs !== null });
      } finally {
        guard.done();
      }
    };
    // A stalled stream is retried once, unless its text already reached a live consumer (onText):
    // replaying deltas there would corrupt whatever consumes them.
    const call = async (user: string, onText?: (d: string, s: string) => void) => {
      try {
        return await attempt(user, onText);
      } catch (err) {
        const delivered = (err as { textDelivered?: boolean }).textDelivered === true;
        if (!(err instanceof ModelStallError) || req.signal?.aborted || (onText && delivered)) throw err;
        return attempt(user, onText);
      }
    };
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
    let first = await call(req.user, req.onText);
    let out = extract(first.text);
    let total = { ms: first.ms, input: first.input, output: first.output, costUsd: first.costUsd };
    const finish = (ok: boolean, error?: string) => this.ledger.record({ provider: "anthropic", model: first.response.model ?? model, purpose: req.purpose, ms: first.ms, inputTokens: first.input, outputTokens: first.output, costUsd: first.costUsd, ok, error });
    if (first.response.stop_reason === "refusal") {
      finish(false, "stop_reason=refusal");
      throw new ModelOutputError("The model declined the request", "refusal");
    }
    if (out.ok) {
      finish(true);
      return { data: out.value, ms: total.ms, inputTokens: total.input, outputTokens: total.output, costUsd: total.costUsd, model: first.response.model ?? model, firstTextMs: first.firstTextMs, repaired: false };
    }
    finish(false, `invalid output: ${out.error.slice(0, 160)}`);
    const repairUser = `${req.user}\n\n<previous_response_invalid>\nYour previous response could not be used: ${out.error}\nReturn the complete corrected JSON object only.\nPrevious response (truncated):\n${first.text.slice(0, 12_000)}\n</previous_response_invalid>`;
    const second = await call(repairUser);
    const out2 = extract(second.text);
    this.ledger.record({ provider: "anthropic", model: second.response.model ?? model, purpose: `${req.purpose}.repair`, ms: second.ms, inputTokens: second.input, outputTokens: second.output, costUsd: second.costUsd, ok: out2.ok, error: out2.ok ? undefined : out2.error.slice(0, 160) });
    total = { ms: total.ms + second.ms, input: total.input + second.input, output: total.output + second.output, costUsd: total.costUsd + second.costUsd };
    if (!out2.ok) throw new ModelOutputError(`Output failed validation twice: ${out2.error}`, second.response.stop_reason ?? null);
    return { data: out2.value, ms: total.ms, inputTokens: total.input, outputTokens: total.output, costUsd: total.costUsd, model: second.response.model ?? model, firstTextMs: first.firstTextMs, repaired: true };
  }
}
