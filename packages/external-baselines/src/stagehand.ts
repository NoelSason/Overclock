import type { AgentResult } from "@browserbasehq/stagehand";
import { recordKeyOf, type ExternalEpisode, type ExternalRunResult, type ResolvedRunInput } from "./contract";
import { UsageMeter, type Effort } from "./meter";
import { OPERATING_RULES, recordInstruction, wrapUpInstruction } from "./prompt";
import { FRAMEWORK, openStagehandSession, type Framework, type StagehandSession } from "./session";

/**
 * Stagehand v3 baseline: the framework's own multi-step agent (`stagehand.agent().execute()`,
 * DOM tool mode: ariaTree, act, fillForm, extract, goto, ...) drives a locally launched Chromium.
 *
 * Records run in input order, one `execute()` per record, then one wrap-up `execute()` for the
 * batch-level rules. Each record run sees the task text, the apps, the record, and the earlier
 * records' final summaries (batch notes). One run per record keeps the agent's conversation, which
 * grows with every step, bounded by the step cap instead of by the batch size; it is the same
 * decomposition Overclock's sequential baseline uses.
 *
 * Nothing here judges correctness: claims are reported as claims, and the harness asks the arena.
 */

export interface StagehandRunOptions extends ResolvedRunInput {
  framework: Framework;
  apiKey: string;
  effort: Effort | null;
}

/** Agent tools that act on the browser (reading tools such as ariaTree, screenshot, extract, think are excluded). */
const ACTING_TOOLS = new Set(["act", "fillForm", "goto", "scroll", "keys", "navback", "click", "type", "dragAndDrop", "clickAndHold", "fillFormVision"]);
const MAX_MESSAGE = 600;
const WRAPUP_KEY = "batch";

type Agent = ReturnType<StagehandSession["stagehand"]["agent"]>;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function errMessage(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), 300);
}

function keyedRecords(records: Record<string, unknown>[]): { key: string; record: Record<string, unknown> }[] {
  const used = new Map<string, number>();
  return records.map((record, i) => {
    let key = recordKeyOf(record, i);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    return { key, record };
  });
}

export async function runStagehand(o: StagehandRunOptions): Promise<ExternalRunResult> {
  const t0 = performance.now();
  const epoch0 = Date.now();
  const meter = new UsageMeter(o.model, o.budgetUsd, o.effort, o.signal);
  const episodes: ExternalEpisode[] = [];
  let firstActionAt: number | null = null;
  let error: string | undefined;
  let session: StagehandSession | null = null;
  let frameworkReported: ExternalRunResult["frameworkReported"];

  const stopReason = (): string | undefined => {
    if (meter.budgetExceeded) return meter.budgetExceeded.message;
    if (o.signal?.aborted) return "Cancelled";
    return undefined;
  };

  const runEpisode = async (agent: Agent, key: string, kind: ExternalEpisode["kind"], instruction: string, maxSteps: number): Promise<ExternalEpisode> => {
    const s0 = performance.now();
    let res: AgentResult | null = null;
    let epError: string | undefined;
    try {
      res = await agent.execute({ instruction, maxSteps });
    } catch (err) {
      epError = errMessage(err);
    }
    for (const a of res?.actions ?? []) {
      const at = a.timestamp;
      if (ACTING_TOOLS.has(a.type) && typeof at === "number" && (firstActionAt === null || at < firstActionAt)) firstActionAt = at;
    }
    // Stagehand reports run failures (including our budget refusal) as success=false with this prefix.
    if (res && !res.success && res.message.startsWith("Failed to execute task")) epError ??= clip(res.message, 300);
    const stop = stopReason();
    if (stop) epError = stop;
    return {
      key,
      kind,
      claimedDone: !!res?.completed && !epError,
      actions: res?.actions.length ?? 0,
      wallMs: Math.round(performance.now() - s0),
      message: clip(res?.message ?? "", MAX_MESSAGE),
      ...(epError ? { error: epError } : {}),
    };
  };

  const records = keyedRecords(o.records);
  try {
    session = await openStagehandSession({ framework: o.framework, applications: o.applications, credentials: o.credentials, model: o.model, apiKey: o.apiKey, middleware: meter.middleware });
    const agent = session.stagehand.agent({ systemPrompt: OPERATING_RULES });
    const notes: string[] = [];
    for (const [index, r] of records.entries()) {
      error = stopReason();
      if (error) break;
      const instruction = recordInstruction({ goal: o.goal, apps: o.applications, index, total: records.length, key: r.key, record: r.record, notes });
      const ep = await runEpisode(agent, r.key, "record", instruction, o.maxStepsPerRecord);
      episodes.push(ep);
      notes.push(`${r.key}: ${ep.message || (ep.claimedDone ? "finished" : "not finished")}`);
    }
    error ??= stopReason();
    if (!error && records.length) {
      const items = episodes.map((e) => ({ key: e.key, claimedDone: e.claimedDone, message: e.message || e.error || "" }));
      episodes.push(await runEpisode(agent, WRAPUP_KEY, "wrap-up", wrapUpInstruction({ goal: o.goal, apps: o.applications, items }), o.maxStepsPerRecord * 2));
      error = stopReason();
    }
    const m = await session.stagehand.metrics.catch(() => null);
    if (m) frameworkReported = { inputTokens: m.totalPromptTokens, outputTokens: m.totalCompletionTokens };
  } catch (err) {
    error = stopReason() ?? (session ? errMessage(err) : `Setup failed: ${errMessage(err)}`);
  } finally {
    await session?.close();
  }

  const recordEpisodes = episodes.filter((e) => e.kind === "record");
  return {
    framework: FRAMEWORK,
    frameworkVersion: o.framework.version,
    model: o.model,
    wallMs: Math.round(performance.now() - t0),
    firstActionMs: firstActionAt === null ? null : Math.max(0, firstActionAt - epoch0),
    modelCalls: meter.calls,
    inputTokens: meter.inputTokens,
    outputTokens: meter.outputTokens,
    costUsd: Math.round(meter.spentUsd * 1e6) / 1e6,
    recordsAttempted: recordEpisodes.length,
    recordsClaimedDone: recordEpisodes.filter((e) => e.claimedDone).length,
    ...(error ? { error } : {}),
    episodes,
    blockedRequests: session?.guard.blocked ?? 0,
    ...(frameworkReported ? { frameworkReported } : {}),
  };
}
