/**
 * Warm execution benchmark: the engine reuses its locally cached, reviewed plan (no model calls),
 * so wall time measures execution alone: browser workers, scheduler, verification.
 *
 *   tsx scripts/warm-bench.ts [--records 500] [--workers 16] [--trials 3] [--seed 4242] [--label tag] [--engine http://127.0.0.1:4000]
 *
 * Needs the arena and an engine whose cache holds a plan for the task (run one cold run of the
 * same task first). A 25-record warm-up runs first and isn't recorded. Each trial reloads the
 * scenario, so every trial starts from the same data. Fails a trial that made a model call (the
 * cache missed) instead of reporting it as warm. Results go to benchmarks/results/warm/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arena, configFromScenario, Overclock } from "@overclock/sdk";
import { argValue, REPO_ROOT } from "./network-lib";

const argv = process.argv.slice(2);
const records = Number(argValue(argv, "--records") ?? 500);
const workers = Number(argValue(argv, "--workers") ?? 16);
const trials = Number(argValue(argv, "--trials") ?? 3);
const seed = Number(argValue(argv, "--seed") ?? 4242);
const label = argValue(argv, "--label") ?? "default";
const engine = new Overclock({ endpoint: argValue(argv, "--engine") ?? "http://127.0.0.1:4000", timeoutMs: 600_000 });
const arena = new Arena();

async function run(n: number) {
  await arena.resetVariations();
  const s = await arena.loadScenario({ seed, template: "t1-order-reconcile", records: n });
  const res = await engine.execute(configFromScenario(s, { mode: "overclock", knowledge: "local-only", cache: "warm", thumbnails: false, maxWorkers: workers }));
  const check = await arena.check();
  const sum = res.summary!;
  return {
    runId: res.runId,
    status: res.status,
    wallMs: Math.round(sum.wallMs),
    firstVerifiedMs: sum.firstVerifiedMs === null ? null : Math.round(sum.firstVerifiedMs),
    modelCalls: sum.modelCalls,
    modelCostUsd: sum.modelCostUsd,
    workerUtilization: sum.workerUtilization,
    maxConcurrency: sum.maxConcurrency,
    check: { correct: check.correctRecords, total: check.totalRecords, duplicateWrites: check.duplicateWrites, collateralWrites: check.collateralWrites },
  };
}

await run(25); // warm-up: browser processes, JIT, connection pools
const results = [];
for (let i = 0; i < trials; i++) {
  const r = await run(records);
  if (r.modelCalls > 0) throw new Error(`trial ${i + 1} made ${r.modelCalls} model call(s): the plan cache missed, so this was not a warm run`);
  console.log(JSON.stringify({ trial: i + 1, ...r }));
  results.push(r);
}
const walls = results.map((r) => r.wallMs).sort((a, b) => a - b);
const report = { at: new Date().toISOString(), label, records, workers, trials, seed, env: { OVERCLOCK_BROWSERS: process.env.OVERCLOCK_BROWSERS ?? null }, medianWallMs: walls[Math.floor(walls.length / 2)], results };
const dir = join(REPO_ROOT, "benchmarks", "results", "warm");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${report.at.replace(/:/g, "-")}-n${records}-w${workers}-${label}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(`median wall ${report.medianWallMs} ms over ${trials} trial(s); recorded as ${file}`);
