import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConcurrencyMode,
  ExecutionMode,
  IntelligenceMode,
  TaskTemplateId,
  VariationConfig,
  VerificationStatus,
  applyEvent,
  createRunView,
  deriveMetrics,
  type AppBinding,
  type CheckResult,
  type EngineHealth,
  type PublicScenario,
  type RunConfigInput,
  type RunResultResponse,
  type RunView,
} from "@overclock/contracts";
import { Arena, Overclock, OverclockError, configFromScenario } from "@overclock/sdk";
import { UsageError, flagBool, flagChoice, flagInt, flagList, flagString, parseArgs, positional, type FlagSpec, type ParsedArgs } from "./args";
import { columns, fmtCount, fmtMs, fmtPct, fmtTime, fmtUsd, keyValues, truncate } from "./format";
import { loadRecords } from "./records";

/**
 * `pnpm cli <command>`. Exit codes: 0 success, 1 failure, 2 usage error.
 * Never prints secrets: output is built only from engine/arena responses and the user's own flags.
 */

export interface CliIO {
  /** Writes raw text (callers add newlines). */
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Directory relative paths (e.g. --records) resolve against. */
  cwd: string;
  /** Live progress overwrites one line when true; otherwise it prints a line per phase. */
  isTTY: boolean;
  fetch?: typeof fetch | undefined;
  /** Install SIGINT handling for `run` (first Ctrl-C cancels the run, second stops waiting). */
  handleSignals: boolean;
}

interface Ctx {
  io: CliIO;
  engine: Overclock;
  arena: Arena;
  out: (line?: string) => void;
  err: (line?: string) => void;
}

interface Command {
  usage: string;
  summary: string;
  flags: FlagSpec;
  run: (ctx: Ctx, args: ParsedArgs) => Promise<number>;
}

/** Runtime failure with a message meant for the user. Exit code 1. */
class CliError extends Error {}

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

// ---------------------------------------------------------------------------------------------
// run

function parseApp(spec: string): AppBinding {
  const eq = spec.indexOf("=");
  const name = eq === -1 ? "" : spec.slice(0, eq).trim();
  const origin = eq === -1 ? "" : spec.slice(eq + 1).trim();
  if (!name || !origin) throw new UsageError(`--app expects Name=origin (e.g. CRM=http://127.0.0.1:4101), got "${spec}"`);
  return { name, origin };
}

async function currentScenario(ctx: Ctx): Promise<PublicScenario> {
  try {
    return await ctx.arena.scenario();
  } catch (err) {
    if (err instanceof OverclockError && err.status === 404) throw new CliError("The arena has no scenario loaded. Load one with `pnpm cli reset --seed 4242`.");
    throw err;
  }
}

async function buildRunConfig(ctx: Ctx, args: ParsedArgs): Promise<RunConfigInput> {
  const base = flagBool(args, "scenario") ? configFromScenario(await currentScenario(ctx)) : undefined;
  const goal = flagString(args, "goal") ?? base?.goal;
  const apps = flagList(args, "app").map(parseApp);
  const applications = apps.length > 0 ? apps : base?.applications;
  if (!goal) throw new UsageError("run needs --goal, or --scenario to use the arena's task");
  if (!applications || applications.length === 0) throw new UsageError("run needs at least one --app Name=origin, or --scenario");

  const recordsPath = flagString(args, "records");
  let records = base?.records ?? [];
  if (recordsPath !== undefined) {
    try {
      records = await loadRecords(resolve(ctx.io.cwd, recordsPath));
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err));
    }
  }

  const config: RunConfigInput = { ...base, goal, applications, records };
  const mode = flagChoice(args, "mode", ExecutionMode.options);
  const intelligence = flagChoice(args, "intelligence", IntelligenceMode.options);
  const concurrency = flagChoice(args, "concurrency", ConcurrencyMode.options);
  const cache = flagChoice(args, "cache", ["cold", "warm"] as const);
  const knowledge = flagChoice(args, "knowledge", ["strict-cold", "local-only", "network-read", "network-read-and-contribute"] as const);
  const workers = flagInt(args, "workers", 1, 32);
  if (mode) config.mode = mode;
  if (intelligence) config.intelligence = intelligence;
  if (concurrency) config.concurrency = concurrency;
  if (cache) config.cache = cache;
  if (knowledge) config.knowledge = knowledge;
  if (workers !== undefined) config.maxWorkers = workers;
  if (flagBool(args, "no-jev")) config.useJev = false;
  if (flagBool(args, "dry-run")) config.dryRun = true;
  const ablation = { ...config.ablation };
  if (flagBool(args, "no-streaming")) ablation.streaming = false;
  if (flagBool(args, "no-access-paths")) ablation.accessPaths = false;
  if (flagBool(args, "no-write-canary")) ablation.writeCanary = false;
  if (Object.keys(ablation).length > 0) config.ablation = ablation;
  return config;
}

/** "-" until the value exists. */
function fmtMaybeMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? "-" : fmtMs(ms);
}

/** One-line live status: phase, verified/total tasks, first verified, overlap, workers, model calls, cost. */
function progressLine(view: RunView): string {
  const m = deriveMetrics(view);
  const total = Object.keys(view.tasks).length;
  const verified = view.taskCounts.VERIFIED ?? 0;
  const failed = view.taskCounts.FAILED ?? 0;
  const unconfirmed = view.taskCounts.UNCONFIRMED ?? 0;
  const parts = [view.status.padEnd(11), fmtMs(view.lastT).padStart(7), `verified ${verified}/${total} tasks`];
  if (failed > 0) parts.push(`failed ${failed}`);
  if (unconfirmed > 0) parts.push(`unconfirmed ${unconfirmed}`);
  parts.push(
    `first verified ${fmtMaybeMs(m.firstVerifiedMs)}`,
    `overlap ${fmtMs(m.overlapMs)}`,
    `workers ${m.activeWorkers}/${Object.keys(view.workers).length}`,
    `model calls ${view.modelCalls.count}`,
    fmtUsd(view.modelCalls.costUsd),
  );
  return parts.join("  ");
}

class Progress {
  private lastStatus = "";
  private lastRender = 0;
  private lastLine = "";

  constructor(
    private readonly ctx: Ctx,
    private readonly view: RunView,
  ) {}

  update(): void {
    const now = Date.now();
    const statusChanged = this.view.status !== this.lastStatus;
    const interval = this.ctx.io.isTTY ? 100 : 5_000;
    if (!statusChanged && now - this.lastRender < interval) return;
    this.render(now);
  }

  finish(): void {
    this.render(Date.now(), true);
  }

  private render(now: number, final = false): void {
    const line = progressLine(this.view);
    this.lastStatus = this.view.status;
    this.lastRender = now;
    if (this.ctx.io.isTTY) {
      this.ctx.io.stderr(`\r\x1b[2K${line}${final ? "\n" : ""}`);
    } else if (line !== this.lastLine) {
      this.ctx.io.stderr(`${line}\n`);
    }
    this.lastLine = line;
  }
}

function outcomeCounts(result: RunResultResponse): Record<VerificationStatus, number> {
  const counts = Object.fromEntries(VerificationStatus.options.map((s) => [s, 0])) as Record<VerificationStatus, number>;
  for (const o of result.outcomes) counts[o.status]++;
  return counts;
}

function printResult(ctx: Ctx, result: RunResultResponse): void {
  const s = result.summary;
  ctx.out(`Run ${result.runId} · ${result.status}${s ? ` · ${s.mode}` : ""}`);
  if (s) {
    const rows: [string, string][] = [
      ["Wall time", `${fmtMs(s.wallMs)} (discovery ${fmtMs(s.discoveryMs)} · compile ${fmtMs(s.compileMs)} · execution ${fmtMs(s.executionMs)})`],
      // Engines older than the cold-start metrics omit these fields; show "-" rather than "NaN".
      ["First verified", `${fmtMaybeMs(s.firstVerifiedMs)} (first action ${fmtMaybeMs(s.firstActionMs)})`],
      ["Overlap", `${fmtMs(s.overlapMs ?? 0)} of planning alongside execution`],
      ["Records", `${s.records} (${s.recordsVerified} verified)`],
      ["Tasks", `${s.tasks}: ${s.verified} verified · ${s.failed} failed · ${s.unconfirmed} unconfirmed · ${s.skipped} skipped · ${s.needsApproval} need approval`],
      ["Recoveries", `${s.recoveries} (${fmtMs(s.recoveryMs ?? 0)})`],
      ["Model calls", `${s.modelCalls} · ${fmtCount(s.inputTokens)} in / ${fmtCount(s.outputTokens)} out tokens · ${fmtUsd(s.modelCostUsd)}`],
      ["Workers", `max ${s.maxConcurrency} · ${fmtPct(s.workerUtilization)} utilization`],
    ];
    const stages = Object.entries(s.stageMs ?? {});
    if (stages.length > 0) rows.push(["Stages", stages.map(([name, ms]) => `${name} ${fmtMs(ms)}`).join(" · ")]);
    if (s.strategy) rows.push(["Strategy", s.strategy]);
    ctx.out(keyValues(rows));
  } else {
    ctx.out("  No summary: the run ended before producing one.");
  }

  const counts = outcomeCounts(result);
  ctx.out("");
  ctx.out(`Record outcomes (${result.outcomes.length})`);
  ctx.out(keyValues(VerificationStatus.options.map((st) => [st, String(counts[st])])));

  const notVerified = result.outcomes.filter((o) => o.status === "FAILED" || o.status === "UNCONFIRMED");
  if (notVerified.length > 0) {
    ctx.out("");
    ctx.out(`Need attention (${notVerified.length})`);
    const shown = notVerified.slice(0, 10).map((o) => [o.recordKey, o.status, truncate(o.notes.join("; ") || "-", 80)]);
    ctx.out(columns(shown, "  "));
    if (notVerified.length > shown.length) ctx.out(`  … ${notVerified.length - shown.length} more (use --json for all)`);
  }
  if (counts.UNCONFIRMED > 0) {
    ctx.out("");
    ctx.out("UNCONFIRMED: a write may or may not have committed and could not be read back. Check these records by hand.");
  }
}

/** A run succeeds when it completed and nothing failed or stayed unconfirmed. */
function runExitCode(result: RunResultResponse): number {
  if (result.status !== "completed") return EXIT_FAIL;
  return result.outcomes.some((o) => o.status === "FAILED" || o.status === "UNCONFIRMED") ? EXIT_FAIL : EXIT_OK;
}

async function runCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const json = flagBool(args, "json");
  const config = await buildRunConfig(ctx, args);
  const { runId } = await ctx.engine.start(config);
  ctx.err(`Started run ${runId} (${config.mode ?? "overclock"}, ${config.records?.length ?? 0} records, up to ${config.maxWorkers ?? 8} workers)`);

  const view = createRunView(runId);
  const progress = new Progress(ctx, view);
  const stop = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      ctx.err("\nCancelling run… press Ctrl-C again to stop waiting.");
      ctx.engine.cancel(runId).catch((err: unknown) => ctx.err(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`));
    } else {
      stop.abort(new Error("interrupted"));
    }
  };
  if (ctx.io.handleSignals) process.on("SIGINT", onSigint);
  try {
    await ctx.engine.waitForCompletion(runId, {
      signal: stop.signal,
      onEvent: (ev) => {
        applyEvent(view, ev);
        progress.update();
      },
    });
  } catch (err) {
    if (stop.signal.aborted) {
      ctx.err(`\nStopped waiting. Run ${runId} may still be cancelling; check it with \`pnpm cli status ${runId}\`.`);
      return EXIT_INTERRUPTED;
    }
    throw err;
  } finally {
    if (ctx.io.handleSignals) process.off("SIGINT", onSigint);
  }
  progress.finish();

  const result = await ctx.engine.result(runId);
  if (json) ctx.out(JSON.stringify(result, null, 2));
  else {
    ctx.err("");
    printResult(ctx, result);
  }
  return runExitCode(result);
}

// ---------------------------------------------------------------------------------------------
// run inspection

async function statusCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const res = await ctx.engine.status(positional(args, 0, "runId"));
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(res, null, 2));
    return EXIT_OK;
  }
  const v = res.view;
  const m = deriveMetrics(v);
  const tasks = Object.keys(v.tasks).length;
  const rows: [string, string][] = [];
  if (v.goal) rows.push(["Goal", truncate(v.goal, 100)]);
  rows.push(
    ["Elapsed", fmtMs(m.elapsedMs)],
    ["Tasks", `${v.taskCounts.VERIFIED ?? 0} verified / ${tasks} · ${v.taskCounts.FAILED ?? 0} failed · ${v.taskCounts.UNCONFIRMED ?? 0} unconfirmed`],
    ["Workers", `${m.activeWorkers} active / ${Object.keys(v.workers).length}`],
    ["Model calls", `${v.modelCalls.count} · ${fmtUsd(v.modelCalls.costUsd)}`],
    ["Recoveries", String(v.recoveries.length)],
  );
  const pending = Object.values(v.approvals).filter((a) => !a.resolved);
  if (pending.length > 0) rows.push(["Approvals", `${pending.length} pending: ${pending.map((a) => `${a.approvalId} (${truncate(a.description, 40)})`).join(", ")}`]);
  ctx.out(`Run ${res.runId} · ${res.status}${v.mode ? ` · ${v.mode}` : ""}`);
  ctx.out(keyValues(rows));
  return EXIT_OK;
}

async function resultCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const result = await ctx.engine.result(positional(args, 0, "runId"));
  if (flagBool(args, "json")) ctx.out(JSON.stringify(result, null, 2));
  else printResult(ctx, result);
  return EXIT_OK;
}

async function cancelCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const runId = positional(args, 0, "runId");
  const res = await ctx.engine.cancel(runId);
  if (res.ok) {
    ctx.out(`Cancel requested for run ${runId} (status: ${res.status}).`);
    return EXIT_OK;
  }
  ctx.err(`Run ${runId} was not cancelled (status: ${res.status}).`);
  return EXIT_FAIL;
}

async function runsCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const runs = await ctx.engine.list();
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify(runs, null, 2));
    return EXIT_OK;
  }
  if (runs.length === 0) {
    ctx.out("No runs yet. Start one with `pnpm cli run --scenario`.");
    return EXIT_OK;
  }
  const rows = [["RUN", "STATUS", "MODE", "CREATED", "RECORDS VERIFIED", "WALL", "GOAL"]];
  for (const r of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
    const s = r.summary;
    rows.push([r.runId, r.status, r.mode, fmtTime(r.createdAt), s ? `${s.recordsVerified}/${s.records}` : "-", s ? fmtMs(s.wallMs) : "-", truncate(r.label ?? r.goal, 50)]);
  }
  ctx.out(columns(rows));
  return EXIT_OK;
}

function capability(c: { available: boolean; reason?: string | undefined }, detail: string): string {
  return c.available ? `available${detail ? ` (${detail})` : ""}` : `unavailable${c.reason ? `: ${c.reason}` : ""}`;
}

async function healthCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  let engine: EngineHealth;
  try {
    engine = await ctx.engine.health();
  } catch (err) {
    if (flagBool(args, "json")) ctx.out(JSON.stringify({ engine: null, error: err instanceof Error ? err.message : String(err) }, null, 2));
    throw err;
  }
  const arena = await ctx.arena.health().then(
    () => true,
    () => false,
  );
  if (flagBool(args, "json")) {
    ctx.out(JSON.stringify({ engine, arena: { endpoint: ctx.arena.endpoint, reachable: arena } }, null, 2));
    return engine.ok ? EXIT_OK : EXIT_FAIL;
  }
  const c = engine.capabilities;
  ctx.out(`Engine  ${ctx.engine.endpoint}  ${engine.ok ? "ok" : "NOT OK"} · v${engine.version}`);
  ctx.out(
    keyValues([
      ["Planner (Claude)", capability(c.anthropic, `${c.anthropic.plannerModel}, helper ${c.anthropic.helperModel}`)],
      ["Reflex (TypeSafe)", capability(c.typesafe, `${c.typesafe.model}, vision ${c.typesafe.visionModel}`)],
      ["Browser", capability(c.browser, "")],
    ]),
  );
  ctx.out(`Arena   ${ctx.arena.endpoint}  ${arena ? "ok" : "unreachable (start it with `pnpm arena`)"}`);
  return engine.ok ? EXIT_OK : EXIT_FAIL;
}

// ---------------------------------------------------------------------------------------------
// arena

function printScenario(ctx: Ctx, s: PublicScenario): void {
  ctx.out(`Scenario ${s.scenarioId}${s.holdout ? " (holdout)" : ""}`);
  ctx.out(
    keyValues([
      ["Title", s.title],
      ["Template", s.template],
      ["Seed", String(s.seed)],
      ["Records", String(s.records.length)],
      ["Apps", s.applications.map((a) => `${a.name}=${a.origin}`).join("  ")],
    ]),
  );
}

async function resetCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const seed = flagInt(args, "seed", 0, Number.MAX_SAFE_INTEGER);
  const template = flagChoice(args, "template", TaskTemplateId.options);
  const records = flagInt(args, "records", 1, 500);
  let scenario: PublicScenario;
  if (seed === undefined && template === undefined && records === undefined) {
    // No flags: restore the loaded scenario to its starting state (or load the default one).
    try {
      scenario = await ctx.arena.reset();
    } catch (err) {
      if (!(err instanceof OverclockError && err.status === 404)) throw err;
      scenario = await ctx.arena.loadScenario({ seed: 4242 });
    }
  } else {
    scenario = await ctx.arena.loadScenario({ seed: seed ?? 4242, ...(template ? { template } : {}), ...(records !== undefined ? { records } : {}) });
  }
  printScenario(ctx, scenario);
  return EXIT_OK;
}

function printCheck(ctx: Ctx, r: CheckResult): void {
  ctx.out(`Check ${r.scenarioId} at ${fmtTime(r.checkedAt)}`);
  ctx.out(
    keyValues([
      ["Accuracy", `${fmtPct(r.accuracy)} (${r.correctRecords}/${r.totalRecords} records correct)`],
      ["Mismatches", String(r.mismatches.length)],
      ["Duplicate writes", String(r.duplicateWrites)],
      ["Collateral writes", String(r.collateralWrites)],
      ["Escalations expected", String(r.escalationExpected)],
    ]),
  );
  if (r.mismatches.length > 0) {
    ctx.out("");
    ctx.out(`Mismatches${r.mismatches.length > 10 ? " (first 10; use --json for all)" : ""}`);
    const rows = r.mismatches.slice(0, 10).map((m) => [m.recordKey, `${m.entity}.${m.field}`, `expected ${truncate(JSON.stringify(m.expected) ?? "undefined", 30)}`, `actual ${truncate(JSON.stringify(m.actual) ?? "undefined", 30)}`]);
    ctx.out(columns(rows, "  "));
  }
}

async function checkCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const r = await ctx.arena.check();
  if (flagBool(args, "json")) ctx.out(JSON.stringify(r, null, 2));
  else printCheck(ctx, r);
  return EXIT_OK;
}

/** Top-level variation keys that differ from the defaults. */
function activeVariations(cfg: VariationConfig): string[] {
  const defaults: Record<string, unknown> = VariationConfig.parse({});
  return Object.entries(cfg)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key]))
    .map(([key]) => key);
}

async function surpriseCmd(ctx: Ctx, args: ParsedArgs): Promise<number> {
  const kind = positional(args, 0, "kind");
  const app = flagString(args, "app");
  const cfg = await ctx.arena.surprise(kind, app);
  const active = activeVariations(cfg);
  ctx.out(`Applied surprise "${kind}" to ${app && app !== "all" ? app : "all apps"}.`);
  ctx.out(`Active variations: ${active.length > 0 ? active.join(", ") : "none"}`);
  return EXIT_OK;
}

function isEditResult(v: unknown): v is { recordKey: string; entity: string; id: string; patch: Record<string, unknown> } {
  return typeof v === "object" && v !== null && "recordKey" in v && typeof v.recordKey === "string" && "entity" in v && "id" in v && "patch" in v && typeof v.patch === "object" && v.patch !== null;
}

async function editUnprocessedCmd(ctx: Ctx): Promise<number> {
  const res = await ctx.arena.editUnprocessed();
  if (!isEditResult(res)) {
    ctx.out(JSON.stringify(res, null, 2));
    return EXIT_OK;
  }
  const fields = Object.entries(res.patch).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  ctx.out(`Edited ${res.entity} ${String(res.id)} (record ${res.recordKey}): ${fields.join(", ")}`);
  return EXIT_OK;
}

// ---------------------------------------------------------------------------------------------
// dispatch

const COMMANDS: Record<string, Command> = {
  run: {
    usage:
      "run [--scenario] [--goal \"…\"] [--records file.csv|file.json] [--app Name=origin ...]\n" +
      "    [--mode overclock|overclock-staged|compiled-parallel|compiled-single|sequential-agent] [--workers N]\n" +
      "    [--intelligence adaptive|single-planner|parallel-scout] [--concurrency adaptive|fixed]\n" +
      "    [--no-jev] [--no-streaming] [--no-access-paths] [--no-write-canary] [--dry-run] [--cache cold|warm]\n" +
      "    [--knowledge strict-cold|local-only|network-read|network-read-and-contribute] [--json]",
    summary:
      "Start a run, show live progress, and print the verified result. --scenario takes goal, records, and apps from the arena; other flags override them. " +
      "Modes: overclock (streaming, default), overclock-staged (stage-gated swarm), compiled-parallel, compiled-single, sequential-agent. " +
      "--no-streaming, --no-access-paths, and --no-write-canary turn off those optimizations for ablations. Exits 1 unless every record was verified, skipped, or escalated.",
    flags: {
      goal: "string",
      scenario: "boolean",
      records: "string",
      app: "multi",
      mode: "string",
      workers: "string",
      intelligence: "string",
      concurrency: "string",
      "no-jev": "boolean",
      "no-streaming": "boolean",
      "no-access-paths": "boolean",
      "no-write-canary": "boolean",
      "dry-run": "boolean",
      cache: "string",
      knowledge: "string",
      json: "boolean",
    },
    run: runCmd,
  },
  status: { usage: "status <runId> [--json]", summary: "Show a run's phase, task counts, workers, and pending approvals.", flags: { json: "boolean" }, run: statusCmd },
  result: { usage: "result <runId> [--json]", summary: "Show a run's summary and per-record outcomes.", flags: { json: "boolean" }, run: resultCmd },
  cancel: { usage: "cancel <runId>", summary: "Ask the engine to cancel a run.", flags: {}, run: cancelCmd },
  runs: { usage: "runs [--json]", summary: "List runs, newest first.", flags: { json: "boolean" }, run: runsCmd },
  health: { usage: "health [--json]", summary: "Check the engine (and whether the arena is reachable).", flags: { json: "boolean" }, run: healthCmd },
  reset: {
    usage: "reset [--seed N] [--template t1-order-reconcile|t2-ticket-triage|t3-crm-status-sync|t4-holdout] [--records N]",
    summary: "Load a fresh arena scenario (seed defaults to 4242). With no flags, restore the loaded scenario to its starting state.",
    flags: { seed: "string", template: "string", records: "string" },
    run: resetCmd,
  },
  check: { usage: "check [--json]", summary: "Compare the arena apps against the scenario's ground truth.", flags: { json: "boolean" }, run: checkCmd },
  surprise: {
    usage: "surprise <kind> [--app CRM|Orders|Support|all]",
    summary: "Inject a judge surprise: rename-save, confirm-modal, announcement, latency, partial-failure, fields-in-tab, shuffle-fields, concurrency-limit, or clear.",
    flags: { app: "string" },
    run: surpriseCmd,
  },
  "edit-unprocessed": { usage: "edit-unprocessed", summary: "Edit one record no run has touched yet, as a judge would mid-run.", flags: {}, run: (ctx) => editUnprocessedCmd(ctx) },
};

function helpText(): string {
  const lines = ["Usage: pnpm cli <command> [options]", "", "Commands:"];
  for (const cmd of Object.values(COMMANDS)) {
    lines.push(`  ${cmd.usage.split("\n").join("\n  ")}`, `      ${cmd.summary}`, "");
  }
  lines.push(
    "  help [command]",
    "      Show this help, or one command's usage.",
    "",
    "Environment:",
    "  OVERCLOCK_URL        engine base URL (default http://127.0.0.1:4000)",
    "  OVERCLOCK_ARENA_URL  arena admin base URL (default http://127.0.0.1:4100)",
    "",
    "Exit codes: 0 success, 1 failure, 2 usage error.",
  );
  return lines.join("\n");
}

function commandHelp(cmd: Command): string {
  return `Usage: pnpm cli ${cmd.usage.split("\n").join("\n  ")}\n\n${cmd.summary}`;
}

/** "path.to.field: message" for one zod issue carried in a validation error's body. */
function issueText(issue: unknown): string {
  if (typeof issue !== "object" || issue === null) return String(issue);
  const path = "path" in issue && Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
  const message = "message" in issue && typeof issue.message === "string" ? issue.message : "invalid";
  return `${path || "(config)"}: ${message}`;
}

function errorText(err: unknown): string {
  if (err instanceof OverclockError) {
    const lines = [`error: ${err.message}`];
    if (err.code === "validation" && Array.isArray(err.body)) {
      lines.length = 0;
      lines.push("error: invalid run config");
      for (const issue of err.body) lines.push(`  - ${issueText(issue)}`);
    }
    if (err.code === "network" && err.message.includes("Overclock engine")) lines.push("Is the engine running? Start it with `pnpm engine`.");
    if (err.code === "network" && err.message.includes("arena")) lines.push("Is the arena running? Start it with `pnpm arena`.");
    return lines.join("\n");
  }
  return `error: ${err instanceof Error ? err.message : String(err)}`;
}

/** Entry point; resolves to the exit code. Exported so tests can drive the CLI without spawning. */
export async function main(argv: readonly string[], io: Partial<CliIO> = {}): Promise<number> {
  const env = io.env ?? process.env;
  const full: CliIO = {
    stdout: io.stdout ?? ((t) => void process.stdout.write(t)),
    stderr: io.stderr ?? ((t) => void process.stderr.write(t)),
    env,
    cwd: io.cwd ?? env.INIT_CWD ?? process.cwd(),
    isTTY: io.isTTY ?? false,
    fetch: io.fetch,
    handleSignals: io.handleSignals ?? false,
  };
  const ctx: Ctx = {
    io: full,
    engine: new Overclock({ endpoint: env.OVERCLOCK_URL, fetch: full.fetch }),
    arena: new Arena({ endpoint: env.OVERCLOCK_ARENA_URL, fetch: full.fetch }),
    out: (line = "") => full.stdout(`${line}\n`),
    err: (line = "") => full.stderr(`${line}\n`),
  };

  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "--help" || name === "-h") {
    const topic = name === "help" ? rest[0] : undefined;
    const cmd = topic === undefined ? undefined : COMMANDS[topic];
    if (topic !== undefined && cmd === undefined) {
      ctx.err(`error: unknown command "${topic}"\n\n${helpText()}`);
      return EXIT_USAGE;
    }
    if (name === undefined) {
      ctx.err(helpText());
      return EXIT_USAGE;
    }
    ctx.out(cmd ? commandHelp(cmd) : helpText());
    return EXIT_OK;
  }

  const cmd = COMMANDS[name];
  if (cmd === undefined) {
    ctx.err(`error: unknown command "${name}". Run \`pnpm cli help\` for the list.`);
    return EXIT_USAGE;
  }
  try {
    const args = parseArgs(rest, { ...cmd.flags, help: "boolean" });
    if (flagBool(args, "help")) {
      ctx.out(commandHelp(cmd));
      return EXIT_OK;
    }
    return await cmd.run(ctx, args);
  } catch (err) {
    if (err instanceof UsageError) {
      ctx.err(`error: ${err.message}\n\n${commandHelp(cmd)}`);
      return EXIT_USAGE;
    }
    ctx.err(errorText(err));
    return err instanceof OverclockError && err.code === "validation" ? EXIT_USAGE : EXIT_FAIL;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), { isTTY: process.stderr.isTTY === true, handleSignals: true }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = EXIT_FAIL;
    },
  );
}
