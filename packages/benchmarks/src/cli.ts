import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TaskTemplateId, type EngineHealth, type PublicScenario, type RunConfigInput } from "@overclock/contracts";
import { Arena, configFromScenario, Overclock } from "@overclock/sdk";
import { DEFAULT_BUDGET_USD, DEFAULT_RUN_TIMEOUT_MS, parseExternalResult, runPlan, timestampStem, type ExternalRunner, type HarnessDeps } from "./harness";
import { writeReport } from "./report";
import {
  CONDITION_NAMES,
  DEFAULT_PLAN_OPTIONS,
  formatPlan,
  HOLDOUT_FREEZE_ENV,
  isConditionName,
  MODE_NAMES,
  planMode,
  planSuite,
  SUITE_NAMES,
  type ConditionName,
  type ModeName,
  type PlannedRun,
  type PlanOptions,
  type SuiteName,
} from "./suites";

/**
 * Benchmark CLI.
 *   tsx packages/benchmarks/src/cli.ts --suite all [--dry] [--spawn]
 *   tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 3
 *   tsx packages/benchmarks/src/cli.ts --report
 */

const USAGE = `Usage: tsx packages/benchmarks/src/cli.ts (--mode <m> | --suite <s> | --report) [options]

  --mode <m>          ${MODE_NAMES.join(" | ")}
  --suite <s>         ${SUITE_NAMES.join(" | ")}
  --report            regenerate docs/BENCHMARKS.md from the result files only
  --records <n>       records per run (default ${DEFAULT_PLAN_OPTIONS.records})
  --trials <n>        trials per label (default ${DEFAULT_PLAN_OPTIONS.trials}; holdout always runs 1)
  --seed <n>          scenario seed (default ${DEFAULT_PLAN_OPTIONS.seed})
  --template <t>      t1 | t2 | t3 | t4 or a full template id (default ${DEFAULT_PLAN_OPTIONS.template})
  --condition <c>     ${CONDITION_NAMES.join(" | ")} | both (default: both for all/holdout, local otherwise)
  --budget <usd>      spend cap (default $OVERCLOCK_BENCH_BUDGET_USD or ${DEFAULT_BUDGET_USD})
  --timeout <min>     per-run timeout in minutes (default ${DEFAULT_RUN_TIMEOUT_MS / 60_000})
  --engine <url>      engine endpoint (default http://127.0.0.1:4000)
  --arena <url>       arena admin endpoint (default http://127.0.0.1:4100)
  --out <dir>         results directory (default benchmarks/results)
  --label <tag>       tag this invocation; results go to suite "<suite>@<tag>"
  --include-sequential-100   also run sequential at 100 records in the all suite
  --no-external       do not run the external baseline even when its package is present
  --dry               print the planned runs and counts without executing anything
  --spawn             start pnpm arena and pnpm engine, wait for health, stop them at the end
`;

class UsageError extends Error {}

function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function intArg(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer, got "${raw}"`);
  return n;
}

function numArg(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number, got "${raw}"`);
  return n;
}

const TEMPLATE_ALIASES: Readonly<Record<string, TaskTemplateId>> = {
  t1: "t1-order-reconcile",
  t2: "t2-ticket-triage",
  t3: "t3-crm-status-sync",
  t4: "t4-holdout",
};

function templateArg(raw: string | undefined): TaskTemplateId {
  if (raw === undefined) return DEFAULT_PLAN_OPTIONS.template;
  const parsed = TaskTemplateId.safeParse(TEMPLATE_ALIASES[raw] ?? raw);
  if (!parsed.success) throw new UsageError(`--template must be one of t1, t2, t3, t4, ${TaskTemplateId.options.join(", ")}; got "${raw}"`);
  return parsed.data;
}

function conditionArg(raw: string | undefined): ConditionName[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === "both" || raw === "all") return [...CONDITION_NAMES];
  const names = raw.split(",").map((s) => s.trim());
  for (const n of names) if (!isConditionName(n)) throw new UsageError(`--condition must be ${CONDITION_NAMES.join(", ")}, or both; got "${n}"`);
  return names.filter(isConditionName);
}

function urlArg(name: string, raw: string): string {
  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new UsageError(`--${name} must be a URL, got "${raw}"`);
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type Probe = { ok: true } | { ok: false; error: string };

async function probe(endpoint: string): Promise<Probe> {
  try {
    const res = await fetch(`${endpoint}/api/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

interface Child {
  name: string;
  proc: ChildProcess;
  logPath: string;
  exited: Promise<number | null>;
}

function startChild(name: string, script: string, root: string, env: NodeJS.ProcessEnv, logPath: string): Child {
  const log = createWriteStream(logPath, { flags: "a" });
  // detached: the child leads its own process group, so stopping it also stops pnpm's children.
  const proc = spawn("pnpm", [script], { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.pipe(log);
  proc.stderr?.pipe(log);
  const exited = new Promise<number | null>((res) => proc.once("exit", (code) => res(code)));
  return { name, proc, logPath, exited };
}

function signalGroup(c: Child, sig: NodeJS.Signals): void {
  if (c.proc.pid === undefined) return;
  try {
    process.kill(-c.proc.pid, sig);
  } catch {
    c.proc.kill(sig);
  }
}

async function stopChild(c: Child): Promise<void> {
  if (c.proc.exitCode !== null || c.proc.signalCode !== null) return;
  signalGroup(c, "SIGTERM");
  const done = await Promise.race([c.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10_000))]);
  if (!done) signalGroup(c, "SIGKILL");
}

async function waitHealthy(endpoint: string, child: Child, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null | undefined;
  void child.exited.then((code) => {
    exitCode = code;
  });
  for (;;) {
    if ((await probe(endpoint)).ok) return;
    if (exitCode !== undefined) throw new Error(`${child.name} exited (code ${exitCode}) before becoming healthy; see ${child.logPath}`);
    if (Date.now() > deadline) throw new Error(`${child.name} did not answer ${endpoint}/api/health within ${Math.round(timeoutMs / 1000)} s; see ${child.logPath}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function engineNotes(h: EngineHealth): { notes: string[]; fatal?: string } {
  const c = h.capabilities;
  const avail = (x: { available: boolean; reason?: string | undefined }) => (x.available ? "available" : `unavailable${x.reason ? `: ${x.reason}` : ""}`);
  const notes = [
    `Engine ${h.version}. Planner ${c.anthropic.plannerModel}, helper ${c.anthropic.helperModel} (Anthropic ${avail(c.anthropic)}). JEV ${c.typesafe.model} / ${c.typesafe.visionModel} (${avail(c.typesafe)}). Browser ${avail(c.browser)}.`,
  ];
  if (!c.browser.available) return { notes, fatal: `The engine reports no browser (${c.browser.reason ?? "no reason given"}); every run would fail.` };
  return { notes };
}

function codeVersion(root: string): string | undefined {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
    return `${sha}${dirty ? " (uncommitted changes)" : ""}`;
  } catch {
    return undefined;
  }
}

/** Load the optional external baseline adapter from packages/external-baselines. */
async function loadExternal(root: string): Promise<{ runner?: ExternalRunner; note: string }> {
  const dir = join(root, "packages", "external-baselines");
  if (!existsSync(dir)) return { note: "External baseline skipped: packages/external-baselines is not present." };
  const entry = ["src/index.ts", "index.ts"].map((p) => join(dir, p)).find((p) => existsSync(p));
  if (!entry) return { note: "External baseline skipped: packages/external-baselines has no src/index.ts." };
  try {
    const mod: unknown = await import(pathToFileURL(entry).href);
    const fn = isRecord(mod) ? mod.runExternal : undefined;
    if (typeof fn !== "function") return { note: "External baseline skipped: packages/external-baselines does not export runExternal." };
    // Checked to be a function above; its return value is validated on every call.
    const runExternal = fn as (config: RunConfigInput, scenario: PublicScenario) => unknown;
    return { runner: async (config, scenario) => parseExternalResult(await runExternal(config, scenario)), note: "External baseline: runExternal from packages/external-baselines." };
  } catch (err) {
    return { note: `External baseline skipped: packages/external-baselines failed to load (${errMessage(err)}).` };
  }
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      suite: { type: "string" },
      report: { type: "boolean", default: false },
      records: { type: "string" },
      trials: { type: "string" },
      seed: { type: "string" },
      template: { type: "string" },
      condition: { type: "string" },
      budget: { type: "string" },
      timeout: { type: "string" },
      engine: { type: "string", default: "http://127.0.0.1:4000" },
      arena: { type: "string", default: "http://127.0.0.1:4100" },
      out: { type: "string", default: "benchmarks/results" },
      label: { type: "string" },
      "include-sequential-100": { type: "boolean", default: false },
      "no-external": { type: "boolean", default: false },
      dry: { type: "boolean", default: false },
      spawn: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = findRepoRoot();
  const outDir = isAbsolute(values.out) ? values.out : join(root, values.out);
  const docsPath = join(root, "docs", "BENCHMARKS.md");

  if (values.report) {
    const r = await writeReport(outDir, docsPath);
    console.log(`Wrote ${r.path} from ${r.files} result files (${r.runs} runs${r.skipped ? `, ${r.skipped} unreadable files skipped` : ""}).`);
    return 0;
  }

  if ((values.mode === undefined) === (values.suite === undefined)) throw new UsageError("Pass exactly one of --mode, --suite, or --report.");
  const tag = values.label?.trim() || undefined;
  if (tag && !/^[\w.-]+$/.test(tag)) throw new UsageError("--label may contain only letters, digits, '.', '_', and '-'.");
  const budgetUsd = numArg("budget", values.budget ?? process.env.OVERCLOCK_BENCH_BUDGET_USD, DEFAULT_BUDGET_USD);
  const runTimeoutMs = numArg("timeout", values.timeout, DEFAULT_RUN_TIMEOUT_MS / 60_000) * 60_000;
  if (runTimeoutMs <= 0) throw new UsageError("--timeout must be positive");
  const engineUrl = urlArg("engine", values.engine);
  const arenaUrl = urlArg("arena", values.arena);
  const notes: string[] = [`Command: tsx packages/benchmarks/src/cli.ts ${argv.join(" ")}`];
  const version = codeVersion(root);
  if (version) notes.push(`Code version: ${version}.`);

  const wantsExternal = values.suite === "all" && !values["no-external"];
  let external: { runner?: ExternalRunner; note: string } | undefined;
  if (wantsExternal) {
    // A dry run only checks that the package exists; it never loads or runs it.
    external = values.dry ? { note: existsSync(join(root, "packages", "external-baselines")) ? "External baseline package found (not loaded in a dry run)." : "External baseline skipped: packages/external-baselines is not present." } : await loadExternal(root);
    notes.push(external.note);
  }
  const externalAvailable = values.dry ? existsSync(join(root, "packages", "external-baselines")) : external?.runner !== undefined;

  const planOpts: PlanOptions = {
    records: intArg("records", values.records, DEFAULT_PLAN_OPTIONS.records),
    trials: intArg("trials", values.trials, DEFAULT_PLAN_OPTIONS.trials),
    seed: intArg("seed", values.seed, DEFAULT_PLAN_OPTIONS.seed),
    template: templateArg(values.template),
    includeSequential100: values["include-sequential-100"],
    includeExternal: wantsExternal && externalAvailable,
    conditions: conditionArg(values.condition),
    tag,
  };
  let plan: PlannedRun[];
  if (values.mode !== undefined) {
    if (!(MODE_NAMES as readonly string[]).includes(values.mode)) throw new UsageError(`--mode must be one of ${MODE_NAMES.join(", ")}; got "${values.mode}"`);
    plan = planMode(values.mode as ModeName, planOpts);
  } else {
    const suite = values.suite ?? "";
    if (!(SUITE_NAMES as readonly string[]).includes(suite)) throw new UsageError(`--suite must be one of ${SUITE_NAMES.join(", ")}; got "${suite}"`);
    plan = planSuite(suite as SuiteName, planOpts);
  }
  const suiteName = plan[0]?.suite ?? values.suite ?? "modes";
  const freezeId = process.env[HOLDOUT_FREEZE_ENV]?.trim() || undefined;
  const hasHoldout = plan.some((r) => r.holdout);

  if (values.dry) {
    console.log(formatPlan(plan, budgetUsd));
    if (external) console.log(external.note);
    if (hasHoldout && !freezeId) console.log(`Note: ${HOLDOUT_FREEZE_ENV} is not set, so executing this plan would be refused.`);
    return 0;
  }
  if (hasHoldout && !freezeId) {
    console.error(`Refusing to run holdout scenarios: set ${HOLDOUT_FREEZE_ENV} to the code-freeze identifier (for example a git tag or commit).`);
    return 2;
  }

  const stem = timestampStem(Date.now());
  const children: Child[] = [];
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts === 1) {
      console.error("\nInterrupt received: cancelling the current run and saving results. Press Ctrl-C again to exit immediately.");
      controller.abort();
    } else {
      for (const c of children) signalGroup(c, "SIGKILL");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    const targets = [
      { name: "arena", script: "arena", url: arenaUrl, portEnv: "OVERCLOCK_ARENA_ADMIN_PORT" },
      { name: "engine", script: "engine", url: engineUrl, portEnv: "OVERCLOCK_ENGINE_PORT" },
    ];
    for (const t of targets) {
      const p = await probe(t.url);
      if (p.ok) {
        if (values.spawn) notes.push(`${t.name} was already running at ${t.url}; not spawned.`);
        continue;
      }
      if (!values.spawn) {
        console.error(`The ${t.name} is not reachable at ${t.url}/api/health (${p.error}). Start it with \`pnpm ${t.script}\`, or pass --spawn.`);
        return 2;
      }
      const logDir = join(root, ".data", "benchmarks");
      await mkdir(logDir, { recursive: true });
      const env: NodeJS.ProcessEnv = { ...process.env };
      const port = new URL(t.url).port;
      if (port) env[t.portEnv] = port;
      const child = startChild(t.name, t.script, root, env, join(logDir, `${stem}-${t.name}.log`));
      children.push(child);
      console.log(`Started ${t.name} (log: ${child.logPath}); waiting for ${t.url}/api/health…`);
      await waitHealthy(t.url, child, 120_000);
    }

    const engine = new Overclock({ endpoint: engineUrl });
    const arena = new Arena({ endpoint: arenaUrl });
    const health = engineNotes(await engine.health());
    notes.push(...health.notes);
    if (health.fatal) {
      console.error(health.fatal);
      return 2;
    }
    if (hasHoldout && freezeId) console.log(`Holdout code freeze: ${freezeId}`);

    const deps: HarnessDeps = { engine, arena, buildConfig: configFromScenario, external: external?.runner };
    console.log(`Running ${plan.length} planned runs for suite "${suiteName}" (budget $${budgetUsd.toFixed(2)}).`);
    const result = await runPlan(plan, deps, {
      suite: suiteName,
      outDir,
      budgetUsd,
      runTimeoutMs,
      holdoutFreezeId: freezeId,
      notes,
      stem,
      signal: controller.signal,
      log: (line) => console.log(line),
    });
    const failed = result.file.runs.filter((r) => r.error).length;
    console.log(
      `Recorded ${result.file.runs.length} runs (${failed} failed, ${result.notExecuted.length} not executed), spend $${result.file.spentUsd.toFixed(4)} of $${budgetUsd.toFixed(2)}. Results: ${result.path}`,
    );
    const r = await writeReport(outDir, docsPath);
    console.log(`Wrote ${r.path} from ${r.files} result files.`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
    for (const c of children.reverse()) await stopChild(c);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError || (isRecord(err) && typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS"))) {
      console.error(`${errMessage(err)}\n\n${USAGE}`);
      process.exit(2);
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
