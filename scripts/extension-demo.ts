/**
 * Prepares the Chrome extension demo in the demonstration environment (the arena):
 *
 *   pnpm extension:demo [--seed 2222] [--records 10] [--data-dir .data/engine] [--from .data/scratch/a-cache]
 *
 * 1. Loads a fresh batch of records into the arena (the harness's admin API; the extension never
 *    touches it) and writes them to `.data/extension-demo/records-seed<seed>.csv`, the file a
 *    customer uploads in the extension.
 * 2. Makes sure the engine's workflow library holds the workflow it learned in an earlier run for
 *    exactly this task: the cached, reviewed plan stored under the task's exact identity (the
 *    instructions, the record fields, and the application origins). An entry written before the
 *    library stored instructions gets them added, but only after the identity computed from those
 *    instructions equals the key it was stored under. With --from, a cached entry with that exact
 *    key is copied in first. Nothing is planned and no model is called.
 *
 * Run it while the engine is up; the library is read from disk on every request.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Arena } from "@overclock/sdk";
import { cacheKey } from "@overclock/swarm";
import { argValue, REPO_ROOT } from "./network-lib";

const argv = process.argv.slice(2);
const seed = Number(argValue(argv, "--seed") ?? 2222);
const records = Number(argValue(argv, "--records") ?? 10);
const dataDir = argValue(argv, "--data-dir") ?? (process.env.OVERCLOCK_DATA_DIR || join(REPO_ROOT, ".data", "engine"));
const from = argValue(argv, "--from") ?? join(REPO_ROOT, ".data", "scratch", "a-cache");

const arena = new Arena();
const scenario = await arena.loadScenario({ seed, template: "t1-order-reconcile", records });
const fields = [...new Set(scenario.records.flatMap((r) => Object.keys(r)))].sort();

// 1. The customer's input file.
const outDir = join(REPO_ROOT, ".data", "extension-demo");
mkdirSync(outDir, { recursive: true });
const csvFile = join(outDir, `records-seed${seed}.csv`);
const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
writeFileSync(csvFile, [fields.join(","), ...scenario.records.map((r) => fields.map((f) => cell((r as Record<string, unknown>)[f])).join(","))].join("\n") + "\n");

// 2. The learned workflow for exactly this task.
const applications = scenario.applications.map((a) => ({ name: a.name, origin: new URL(a.origin).origin }));
const key = cacheKey({ goal: scenario.goal, applications, records: scenario.records } as never);
const cacheDir = join(dataDir, "program-cache");
mkdirSync(cacheDir, { recursive: true });
const keyed = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => join(dir, f))
        .find((f) => {
          try {
            return (JSON.parse(readFileSync(f, "utf8")) as { key?: string }).key === key;
          } catch {
            return false;
          }
        })
    : undefined;
let file = keyed(cacheDir);
if (!file) {
  const source = keyed(from);
  if (!source) {
    console.error(`No learned workflow for this task in ${cacheDir} or ${from}. Learn it once (a cold run, which calls the model), then run this again.`);
    process.exit(1);
  }
  file = join(cacheDir, source.split("/").at(-1)!);
  copyFileSync(source, file);
  console.log(`copied the learned workflow from ${source}`);
}
const entry = JSON.parse(readFileSync(file, "utf8")) as { key: string; review?: { status: string }; learned?: unknown };
if (entry.review?.status !== "passed") {
  console.error(`The cached plan for this task has no passed review (${entry.review?.status ?? "none"}); the extension won't offer it.`);
  process.exit(1);
}
if (!entry.learned) {
  const learned = { goal: scenario.goal, recordFields: fields, applications, records: scenario.records.length, at: statSync(file).mtimeMs, source: { kind: "local" } };
  if (cacheKey({ goal: learned.goal, applications, records: scenario.records } as never) !== entry.key) throw new Error("identity mismatch; not annotating");
  writeFileSync(file, JSON.stringify({ ...entry, learned }));
  console.log("added the task's instructions to the stored workflow (its identity matched)");
}

console.log(`\narena: seed ${seed}, ${scenario.records.length} records loaded (${scenario.title})`);
console.log(`workflow: ${scenario.goal.split("\n")[0]}`);
console.log(`records file for the extension: ${csvFile}`);
