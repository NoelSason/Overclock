/**
 * TEST-ONLY. Writes the synthetic replay fixtures:
 *   tests/e2e/fixtures/synthetic-run.jsonl        one RunEvent per line
 *   tests/e2e/fixtures/synthetic-run.extras.json  artifacts, program, arena scenario/check
 *   tests/e2e/fixtures/synthetic-benchmark.json   a BenchmarkResultFile
 * Usage: pnpm exec tsx tests/e2e/fixtures/generate.ts [--records 60]
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { generateBenchmarkFile, generateSyntheticRun } from "./synthetic-run";

const dir = import.meta.dirname;
const argIndex = process.argv.indexOf("--records");
const records = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 60;
const run = generateSyntheticRun({ records });
writeFileSync(path.join(dir, "synthetic-run.jsonl"), run.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
writeFileSync(path.join(dir, "synthetic-run.extras.json"), JSON.stringify({ runId: run.runId, artifacts: run.artifacts, program: run.program, scenario: run.scenario, check: run.check }, null, 2));
writeFileSync(path.join(dir, "synthetic-benchmark.json"), JSON.stringify(generateBenchmarkFile(), null, 2));
console.log(`wrote ${run.events.length} events for ${run.runId} (${records} records)`);
