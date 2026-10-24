/**
 * Overclock Network: runtime A discovers and publishes, runtime B imports, rebinds, and executes.
 *
 *   pnpm network:demo [--records 10] [--seed 4242] [--variation rename-save] [--mode overclock] [--compare-cold] [--keep]
 *
 * Needs the arena (`pnpm arena`) and a local SpacetimeDB (`pnpm network:dev` starts one). The
 * script publishes the module to a separate `overclock-demo` database and wipes it first, so
 * every demo starts with an empty registry. It starts two engines as child processes, each with
 * its own data dir and identity:
 *
 *   1. runtime A (:4010, network-read-and-contribute): lookup misses, discovers cold, executes,
 *      verifies, and proposes the capability.
 *   2. an independent validator identity re-checks it in mutation-blocked contexts; the admin
 *      (the CLI identity that owns the database) promotes it to ACTIVE.
 *   3. the arena loads a new scenario (seed + 1: different records, same apps) and, with
 *      --variation, a UI change; runtime B (:4020, network-read) imports the capability,
 *      rebinds it to its own observation, and executes without a planner call.
 *
 * With --keep, both engines stay up after the report (Ctrl+C stops them), so their runs can be
 * opened in a dashboard started with NEXT_PUBLIC_OVERCLOCK_URL=http://127.0.0.1:4010 (or 4020).
 *
 * With --compare-cold, B then repeats its scenario (reloaded, same seed and variation) with the
 * strict-cold policy, so network-warm and strict-cold are compared on identical data.
 *
 * The script exits 1 unless every acceptance check passes: both runs complete and the arena's
 * independent checker finds every record correct with no duplicate or collateral writes; B
 * imported an executable capability and selected it instead of planning; and B made no planner
 * calls while A made at least one.
 *
 * Every number printed comes from the engines' run summaries and the arena's checker. Tokens
 * stay in each runtime's data dir and are never printed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserManager, SessionManager } from "@overclock/browser-runtime";
import type { PublisherRole } from "@overclock/network-contracts";
import { NetworkClient } from "@overclock/network-client";
import { Arena, configFromScenario, Overclock, type RunResultResponse, type RunConfigInput } from "@overclock/sdk";
import { startValidationWorker } from "../services/network/validation-worker/src/worker";
import { argValue, authorizeAsOwner, cliServerFor, ensureCli, ensureLocalServer, LOCAL_ENDPOINT, publishModule, REPO_ROOT } from "./network-lib";

const DATABASE = "overclock-demo";
const ENDPOINT = LOCAL_ENDPOINT;
const DEMO_DIR = join(REPO_ROOT, ".data", "demo");

function networkConfig(label: string, publishEnabled: boolean) {
  return { enabled: true, endpoint: ENDPOINT, database: DATABASE, mode: "network-read" as const, publishEnabled, lookupTimeoutMs: 2000, dataDir: join(DEMO_DIR, label, "network"), runtimeLabel: label };
}

async function waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Register `label` and have the owner-authorized admin grant it `role`. Its token stays in its data dir. */
async function enroll(admin: NetworkClient, label: string, role: PublisherRole, publishEnabled = false): Promise<NetworkClient> {
  const c = await NetworkClient.connect(networkConfig(label, publishEnabled));
  await c.registerPublisher(label, role);
  await admin.authorizePublisher(c.identity!, role);
  await waitFor(() => c.myPublisher()?.status === "authorized", 10_000, `${label} authorization`);
  return c;
}

function startEngine(label: string, port: number): ChildProcess {
  const env = {
    ...process.env,
    OVERCLOCK_ENGINE_PORT: String(port),
    OVERCLOCK_DATA_DIR: join(DEMO_DIR, label),
    OVERCLOCK_RUNTIME_LABEL: label,
    OVERCLOCK_NETWORK_ENABLED: "true",
    OVERCLOCK_NETWORK_ENDPOINT: ENDPOINT,
    OVERCLOCK_NETWORK_DATABASE: DATABASE,
    OVERCLOCK_NETWORK_PUBLISH_ENABLED: "true",
    OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS: "2000",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "services/engine/src/main.ts"], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = join(DEMO_DIR, `${label}.log`);
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (d: Buffer) => chunks.push(d));
  child.stderr?.on("data", (d: Buffer) => chunks.push(d));
  child.on("exit", () => writeFileSync(log, Buffer.concat(chunks)));
  return child;
}

async function engineReady(engine: Overclock, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await engine.health()).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error("engine did not start");
    await new Promise((r) => setTimeout(r, 300));
  }
}

type Events = Awaited<ReturnType<Overclock["events"]>>["events"];

/** Planner (plan and repair) calls in a run, from its model.call events. */
function plannerCalls(events: Events): number {
  return events.filter((e) => e.type === "model.call" && e.purpose.startsWith("planner.")).length;
}

function groundTruthOk(o: ReturnType<typeof brief>): boolean {
  return o.status === "completed" && o.checker.accuracy === 1 && o.checker.correct === o.checker.total && o.checker.total === o.records && o.checker.duplicateWrites === 0 && o.checker.collateralWrites === 0;
}

function brief(label: string, r: RunResultResponse, check: { accuracy: number; correctRecords: number; totalRecords: number; duplicateWrites: number; collateralWrites: number }) {
  const s = r.summary!;
  return {
    runtime: label,
    status: r.status,
    knowledge: s.knowledge,
    network: s.network,
    wallMs: s.wallMs,
    firstActionMs: s.firstActionMs,
    firstVerifiedMs: s.firstVerifiedMs,
    stageMs: s.stageMs,
    modelCalls: s.modelCalls,
    modelCostUsd: s.modelCostUsd,
    recordsVerified: s.recordsVerified,
    records: s.records,
    checker: { accuracy: check.accuracy, correct: check.correctRecords, total: check.totalRecords, duplicateWrites: check.duplicateWrites, collateralWrites: check.collateralWrites },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const records = Number(argValue(argv, "--records") ?? 10);
  const seed = Number(argValue(argv, "--seed") ?? 4242);
  const variation = argValue(argv, "--variation");
  const mode = (argValue(argv, "--mode") ?? "overclock") as RunConfigInput["mode"];
  const compareCold = argv.includes("--compare-cold");
  const keep = argv.includes("--keep");
  const arena = new Arena();
  await arena.health();

  // Clean registry and per-runtime state.
  rmSync(DEMO_DIR, { recursive: true, force: true });
  mkdirSync(DEMO_DIR, { recursive: true });
  await ensureCli();
  await ensureLocalServer(ENDPOINT);
  const server = cliServerFor(ENDPOINT);
  await publishModule({ database: DATABASE, server, clean: true });
  console.log(`registry: fresh ${DATABASE} on ${ENDPOINT}`);

  const admin = await NetworkClient.connect(networkConfig("admin", false));
  await admin.registerPublisher("admin", "admin");
  await authorizeAsOwner({ database: DATABASE, server, identityHex: admin.identity!, role: "admin" });
  await waitFor(() => admin.myPublisher()?.status === "authorized", 10_000, "admin authorization");
  const validator = await enroll(admin, "validator", "validator");
  for (const label of ["runtime-a", "runtime-b"]) await (await enroll(admin, label, "publisher", true)).close();
  console.log("identities: admin, validator, runtime-a, runtime-b (separate tokens, all authorized)");

  const a = startEngine("runtime-a", 4010);
  const b = startEngine("runtime-b", 4020);
  const engineA = new Overclock({ endpoint: "http://127.0.0.1:4010", timeoutMs: 60_000 });
  const engineB = new Overclock({ endpoint: "http://127.0.0.1:4020", timeoutMs: 60_000 });
  const browser = new BrowserManager({ headless: true });
  try {
    await Promise.all([engineReady(engineA), engineReady(engineB)]);

    // The validator runs as a service: it picks up every PROPOSED version for the arena's apps.
    const health = (await arena.health()) as { origins: Record<string, string> };
    const apps = Object.entries(health.origins).map(([name, origin]) => ({ name, origin }));
    // The admin promotes from its own view of the registry, scoped to these origins.
    await admin.watchOrigins(apps.map((a) => a.origin));
    const sessions = new SessionManager(browser, () => ({ username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" }));
    let validation: { versionId: string; outcome: string; category: string; ms: number } | null = null;
    const worker = await startValidationWorker({
      client: validator,
      browser,
      apps,
      environment: "demo-validator",
      storageStateFor: (x) => sessions.storageStateFor(x),
      onResult: (r) => (validation = { versionId: r.result.versionId, outcome: r.result.outcome, category: r.result.category, ms: Math.round(r.ms) }),
      onSkip: (v, reason) => console.log(`validator skipped ${v}: ${reason}`),
    });

    // 1. Runtime A: cold discovery, execution, verification, publication.
    await arena.resetVariations();
    const scenarioA = await arena.loadScenario({ seed, template: "t1-order-reconcile", records });
    console.log(`\nA: ${scenarioA.title} (${scenarioA.records.length} records), network-read-and-contribute`);
    const resA = await engineA.execute(configFromScenario(scenarioA, { mode, knowledge: "network-read-and-contribute", thumbnails: false }));
    const outA = brief("runtime-a", resA, await arena.check());
    console.log(JSON.stringify(outA, null, 2));
    const eventsA = await engineA.events(resA.runId, 0, 10_000);
    if (!groundTruthOk(outA)) console.log("A did not pass the ground-truth check; continuing so the report records it");
    const pub = eventsA.events.find((e) => e.type === "network.publish");
    if (!pub || pub.type !== "network.publish" || pub.rejected) throw new Error(`A did not publish: ${pub && pub.type === "network.publish" ? pub.rejected : "no network.publish event"}`);
    const versionId = `${pub.capabilityId}@${pub.version}`;
    console.log(`A proposed ${versionId} (${pub.bytes} bytes, ${pub.redactions} redactions, ${pub.ms} ms)`);

    // 2. Independent validation, then promotion by the admin.
    await waitFor(() => validation?.versionId === versionId, 180_000, "validation");
    await worker.stop();
    console.log(`validator: ${JSON.stringify(validation)}`);
    if (validation!.outcome !== "pass") throw new Error("validation failed; not promoting");
    await waitFor(() => admin.versionInfo(versionId)?.state === "VERIFIED", 10_000, "VERIFIED state");
    const tPromote = performance.now();
    await admin.promote(versionId);
    await waitFor(() => admin.versionInfo(versionId)?.state === "ACTIVE", 10_000, "ACTIVE state");
    console.log(`admin promoted ${versionId} to ACTIVE in ${Math.round(performance.now() - tPromote)} ms`);

    // 3. Runtime B: new records (and optionally a UI change), import + rebind + execute.
    const scenarioB = await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
    if (variation) await arena.surprise(variation);
    console.log(`\nB: ${scenarioB.title} (${scenarioB.records.length} records)${variation ? `, UI variation ${variation}` : ""}, network-read`);
    const resB = await engineB.execute(configFromScenario(scenarioB, { mode, knowledge: "network-read", thumbnails: false }));
    const outB = brief("runtime-b", resB, await arena.check());
    console.log(JSON.stringify(outB, null, 2));
    const eventsB = (await engineB.events(resB.runId, 0, 10_000)).events;
    const importB = eventsB.find((e) => e.type === "network.import");
    const policyB = eventsB.find((e) => e.type === "policy.decision");
    const selectedB = eventsB.find((e) => e.type === "candidate.selected");
    const plannerA = plannerCalls(eventsA.events);
    const plannerB = plannerCalls(eventsB);

    let outCold: ReturnType<typeof brief> | null = null;
    if (compareCold) {
      await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
      console.log(`\nB again, same scenario${variation ? " and variation" : ""}, strict-cold (no network, no local cache)`);
      const resCold = await engineB.execute(configFromScenario(scenarioB, { mode, knowledge: "strict-cold", thumbnails: false }));
      outCold = brief("runtime-b strict-cold", resCold, await arena.check());
      console.log(JSON.stringify(outCold, null, 2));
    }
    if (variation) await arena.resetVariations();

    const checks = [
      { check: "A passes the independent ground-truth check", ok: groundTruthOk(outA), detail: JSON.stringify(outA.checker) },
      { check: "B passes the independent ground-truth check", ok: groundTruthOk(outB), detail: JSON.stringify(outB.checker) },
      {
        check: "B imported the shared capability (executable after rebinding)",
        ok: importB?.type === "network.import" && `${importB.capabilityId}@${importB.version}` === versionId && ["EXACT_COMPATIBLE", "STRUCTURALLY_COMPATIBLE", "REQUIRES_REBINDING"].includes(importB.outcome),
        detail: importB?.type === "network.import" ? `${importB.capabilityId}@${importB.version} ${importB.outcome}, ${importB.bound} bound, ${importB.unbound} unbound` : "no network.import event",
      },
      {
        check: "B executed the imported plan (no cold planning)",
        ok: policyB?.type === "policy.decision" && policyB.intelligence === "network-import" && selectedB?.type === "candidate.selected" && selectedB.candidateId === "network",
        detail: `policy ${policyB?.type === "policy.decision" ? policyB.intelligence : "?"}, selected ${selectedB?.type === "candidate.selected" ? selectedB.candidateId : "?"}`,
      },
      { check: "B made fewer planner calls than A (zero expected)", ok: plannerB === 0 && plannerA > 0, detail: `A ${plannerA}, B ${plannerB}` },
    ];
    console.log("\nacceptance checks");
    for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.check}: ${c.detail}`);
    const passed = checks.every((c) => c.ok);
    const report = { at: new Date().toISOString(), passed, checks, database: DATABASE, endpoint: ENDPOINT, records, seed, variation: variation ?? null, mode, versionId, validation, plannerCalls: { a: plannerA, b: plannerB }, a: outA, b: outB, bStrictCold: outCold };
    writeFileSync(join(DEMO_DIR, "report.json"), JSON.stringify(report, null, 2));
    console.log(`\nreport: ${join(DEMO_DIR, "report.json")}`);
    if (!passed) process.exitCode = 1;
    if (keep) {
      console.log("\nengines still running: A http://127.0.0.1:4010, B http://127.0.0.1:4020 (Ctrl+C stops them)");
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    }
  } finally {
    a.kill("SIGTERM");
    b.kill("SIGTERM");
    await browser.close();
    await validator.close();
    await admin.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
