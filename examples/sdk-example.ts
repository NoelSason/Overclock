/**
 * Run the arena's current scenario through Overclock and compare the result with ground truth.
 *
 *   pnpm arena & pnpm engine &          # start the arena and the engine
 *   npx tsx examples/sdk-example.ts
 *
 * Env: OVERCLOCK_URL (engine, default http://127.0.0.1:4000), OVERCLOCK_ARENA_URL (default http://127.0.0.1:4100).
 * Ctrl-C aborts the call, which also cancels the run on the engine.
 */
import { Arena, Overclock, OverclockError, type PublicScenario, type RunEvent } from "@overclock/sdk";

const engine = new Overclock({ endpoint: process.env.OVERCLOCK_URL });
const arena = new Arena({ endpoint: process.env.OVERCLOCK_ARENA_URL });

async function loadScenario(): Promise<PublicScenario> {
  try {
    return await arena.scenario();
  } catch (err) {
    if (err instanceof OverclockError && err.status === 404) return arena.loadScenario({ seed: 4242, records: 100 });
    throw err;
  }
}

const started = Date.now();
let verified = 0;
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s`;

/** Compact log: phases and stages, plan selection, recoveries, approvals, and every 10th verified receipt. */
function logEvent(e: RunEvent): void {
  switch (e.type) {
    case "run.status":
      console.log(`${stamp()}  phase   ${e.status}${e.reason ? ` (${e.reason})` : ""}`);
      break;
    case "stage":
      console.log(`${stamp()}  stage   ${e.stage} ${e.phase}`);
      break;
    case "policy.decision":
      console.log(`${stamp()}  policy  ${e.intelligence}, ${e.candidates} candidate(s): ${e.reason}`);
      break;
    case "candidate.selected":
      console.log(`${stamp()}  plan    ${e.candidateId}: ${e.reason}`);
      break;
    case "program.compiled":
      console.log(`${stamp()}  compile ${e.strategy}: ${e.segments.length} segments, ${e.nodeCount} nodes in ${e.compileMs}ms`);
      break;
    case "receipt":
      if (e.status === "VERIFIED" && ++verified % 10 === 0) console.log(`${stamp()}  verify  ${verified} writes verified`);
      if (e.status !== "VERIFIED") console.log(`${stamp()}  verify  ${e.recordKey} ${e.status}`);
      break;
    case "recovery":
      if (e.phase !== "started") console.log(`${stamp()}  recover ${e.taskId} level ${e.level} ${e.phase}: ${e.reason}`);
      break;
    case "approval.requested":
      console.log(`${stamp()}  approve ${e.approvalId} needs a decision: ${e.description}`);
      break;
    case "log":
      if (e.level === "warn" || e.level === "error") console.log(`${stamp()}  ${e.level.padEnd(7)} ${e.message}`);
      break;
    default:
      break;
  }
}

const health = await engine.health();
console.log(`Engine ${engine.endpoint} v${health.version}; arena ${arena.endpoint}`);

const scenario = await loadScenario();
console.log(`Scenario ${scenario.scenarioId}: ${scenario.title} (${scenario.records.length} records)`);

const { goal, applications, records } = scenario;
const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("interrupted")));

const result = await engine.execute(
  { goal, applications, records, maxWorkers: 8, optimization: "minimize-wall-time", verification: "required", label: scenario.title },
  { onEvent: logEvent, signal: controller.signal },
);

const counts: Record<string, number> = {};
for (const o of result.outcomes) counts[o.status] = (counts[o.status] ?? 0) + 1;
const s = result.summary;
console.log(`\nRun ${result.runId}: ${result.status}`);
if (s) {
  console.log(`  wall ${(s.wallMs / 1000).toFixed(1)}s · ${s.recordsVerified}/${s.records} records verified · ${s.modelCalls} model calls · $${s.modelCostUsd.toFixed(4)}`);
  const firstVerified = s.firstVerifiedMs === null ? "-" : `${(s.firstVerifiedMs / 1000).toFixed(1)}s`;
  console.log(`  first verified write ${firstVerified} · planning overlapped execution for ${(s.overlapMs / 1000).toFixed(1)}s`);
}
console.log(`  outcomes ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
console.log(`  ${result.verificationSemantics}`);

const check = await arena.check();
console.log(`\nArena check: ${(check.accuracy * 100).toFixed(1)}% correct (${check.correctRecords}/${check.totalRecords})`);
console.log(`  mismatches ${check.mismatches.length} · duplicate writes ${check.duplicateWrites} · collateral writes ${check.collateralWrites}`);
