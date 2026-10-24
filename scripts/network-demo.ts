/**
 * Overclock Network: runtime A discovers and publishes, runtime B imports, rebinds, and executes.
 *
 *   pnpm network:demo [--records 10] [--seed 4242] [--variation rename-save] [--expect-refusal] [--warm-arm] [--conflict-arm] [--mode overclock] [--no-cold-arm] [--keep]
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
 * 4. Unless --no-cold-arm: a third fresh runtime C (:4030, own data dir, network disabled) runs
 *    B's scenario (reloaded, same seed and variation) strict-cold, so network-warm and strict-cold
 *    are compared on identical data. Speedups are reported only when both arms are correct.
 *
 * The script exits 1 unless every acceptance check passes: both runs complete and the arena's
 * independent checker finds every record correct with no duplicate or collateral writes; B
 * imported an executable capability and selected it instead of planning; and B made no planner
 * calls while A made at least one. B must also bind every control, be a different network
 * identity than A with an empty local cache, and write through browser controls with fresh
 * read-back. With --variation, B must report what changed (old and new labels) and pass a write
 * canary before fanning out.
 *
 * With --expect-refusal (for a variation rebinding can't prove safe, e.g. fields-in-tab), the
 * checks invert: B must refuse the capability with reasons, plan cold instead, and still pass.
 *
 * With --conflict-arm, before B runs, a fourth runtime X (own identity, own data dir, no model
 * access) asks for the same task with one value changed ("Tier 2" becomes "Tier 1"). Its
 * operation differs, so it must find no capability to reuse and, with no planner, make zero
 * writes: the arena's own write counters must not move.
 *
 * Every number printed comes from the engines' run summaries and the arena's checker. Tokens
 * stay in each runtime's data dir and are never printed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function startEngine(label: string, port: number, network = true, extraEnv: Record<string, string> = {}): ChildProcess {
  const env = {
    ...process.env,
    ...extraEnv,
    OVERCLOCK_ENGINE_PORT: String(port),
    OVERCLOCK_DATA_DIR: join(DEMO_DIR, label),
    OVERCLOCK_RUNTIME_LABEL: label,
    OVERCLOCK_NETWORK_ENABLED: network ? "true" : "false",
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

/** Where a run's time and model spend went: calls by purpose, streaming fallbacks, recoveries. */
function diagnose(events: Events) {
  const calls: Record<string, { calls: number; ms: number; costUsd: number }> = {};
  for (const e of events) {
    if (e.type !== "model.call") continue;
    const c = (calls[e.purpose] ??= { calls: 0, ms: 0, costUsd: 0 });
    c.calls++;
    c.ms += e.ms;
    c.costUsd = Math.round((c.costUsd + e.costUsd) * 1e6) / 1e6;
  }
  const fallbacks = events.flatMap((e) => (e.type === "log" && e.message.startsWith("streaming fallback") ? [e.message.slice(0, 600)] : []));
  const recoveries = events.filter((e) => e.type === "recovery" && e.phase === "succeeded").length;
  const policy = events.find((e) => e.type === "policy.decision");
  return { modelCallsByPurpose: calls, fallbacks, recoveries, policy: policy?.type === "policy.decision" ? `${policy.intelligence}: ${policy.reason.slice(0, 200)}` : null };
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
  const coldArm = !argv.includes("--no-cold-arm");
  const expectRefusal = argv.includes("--expect-refusal");
  const warmArm = argv.includes("--warm-arm");
  const conflictArm = argv.includes("--conflict-arm");
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
  const runtimes = conflictArm ? ["runtime-a", "runtime-b", "runtime-x"] : ["runtime-a", "runtime-b"];
  for (const label of runtimes) await (await enroll(admin, label, "publisher", true)).close();
  console.log(`identities: admin, validator, ${runtimes.join(", ")} (separate tokens, all authorized)`);

  const a = startEngine("runtime-a", 4010);
  const b = startEngine("runtime-b", 4020);
  const c = coldArm ? startEngine("runtime-c", 4030, false) : null;
  // X has no model access: if it can't reuse a capability, it can't plan, so it writes nothing.
  const x = conflictArm ? startEngine("runtime-x", 4040, true, { ANTHROPIC_API_KEY: "" }) : null;
  const engineX = new Overclock({ endpoint: "http://127.0.0.1:4040", timeoutMs: 60_000 });
  const engineA = new Overclock({ endpoint: "http://127.0.0.1:4010", timeoutMs: 60_000 });
  const engineB = new Overclock({ endpoint: "http://127.0.0.1:4020", timeoutMs: 60_000 });
  const engineC = new Overclock({ endpoint: "http://127.0.0.1:4030", timeoutMs: 60_000 });
  const browser = new BrowserManager({ headless: true });
  try {
    await Promise.all([engineReady(engineA), engineReady(engineB), ...(coldArm ? [engineReady(engineC)] : []), ...(conflictArm ? [engineReady(engineX)] : [])]);

    // The validator runs as a service: it picks up every PROPOSED version for the arena's apps.
    const health = (await arena.health()) as { origins: Record<string, string> };
    const apps = Object.entries(health.origins).map(([name, origin]) => ({ name, origin }));
    // The admin promotes from its own view of the registry, scoped to these origins.
    await admin.watchOrigins(apps.map((a) => a.origin));
    const sessions = new SessionManager(browser, () => ({ username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" }));
    let validation: { versionId: string; outcome: string; category: string; ms: number; detail: string } | null = null;
    const worker = await startValidationWorker({
      client: validator,
      browser,
      apps,
      environment: "demo-validator",
      storageStateFor: (x) => sessions.storageStateFor(x),
      onResult: (r) => (validation = { versionId: r.result.versionId, outcome: r.result.outcome, category: r.result.category, ms: Math.round(r.ms), detail: r.result.detail }),
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
    const publishMs = pub.ms;
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
    const promoteMs = Math.round(performance.now() - tPromote);
    console.log(`admin promoted ${versionId} to ACTIVE in ${promoteMs} ms`);

    // 2b. Runtime X: the same task with one value changed must not reuse A's capability.
    let conflict: { goal: string; lookup: string; importOutcome: string | null; refused: string[]; writes: number; receipts: number; plannerCalls: number; status: string; error: string | null } | null = null;
    if (conflictArm) {
      const scenarioX = await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
      if (!scenarioX.goal.includes("Tier 2")) throw new Error("the task text has no \"Tier 2\" to change for the conflict arm");
      const goalX = scenarioX.goal.replace("Tier 2", "Tier 1");
      // Committed writes, counted by the arena itself across every app.
      const writes = async () => Object.values(((await arena.stats()) as { apps: Record<string, { writes: number }> }).apps).reduce((n, a) => n + a.writes, 0);
      const before = await writes();
      console.log(`\nX: same records as B, instructions with one value changed ("Tier 2" -> "Tier 1"), network-read, no model access`);
      const resX: { runId: string | null; status: string; error?: string } = await engineX.execute({ ...configFromScenario(scenarioX, { mode, knowledge: "network-read", thumbnails: false }), goal: goalX }).catch((e: unknown) => ({ runId: null, status: "failed", error: (e as Error).message }));
      const after = await writes();
      const eventsX = resX.runId ? (await engineX.events(resX.runId, 0, 10_000)).events : [];
      const look = eventsX.find((e) => e.type === "network.lookup");
      const impX = eventsX.find((e) => e.type === "network.import");
      const failure = eventsX.find((e) => e.type === "log" && e.level === "error");
      conflict = {
        goal: "t1 with the damage-ticket owner changed from Tier 2 to Tier 1",
        lookup: look?.type === "network.lookup" ? `${look.outcome} (${look.candidates} candidate(s) for this operation)` : "no lookup event",
        importOutcome: impX?.type === "network.import" ? impX.outcome : null,
        refused: impX?.type === "network.import" ? (impX.refused ?? []) : [],
        writes: after - before,
        receipts: eventsX.filter((e) => e.type === "receipt").length,
        // Planner requests that reached the model (X has no key, so an attempt fails before sending).
        plannerCalls: eventsX.filter((e) => e.type === "model.call" && e.purpose.startsWith("planner.") && e.ok).length,
        status: resX.status,
        error: failure?.type === "log" ? failure.message : (resX.error ?? null),
      };
      console.log(`X: ${JSON.stringify(conflict)}`);
    }

    // 3. Runtime B: new records (and optionally a UI change), import + rebind + execute.
    const scenarioB = await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
    if (variation) await arena.surprise(variation);
    // The changes that apply to this task's applications (the arena hosts other apps too).
    const taskApps = new Set(scenarioB.applications.map((x) => x.name));
    const allVariations = await arena.variations();
    const variationsB = Object.fromEntries(Object.entries(allVariations).map(([k, v]) => [k, v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([app]) => taskApps.has(app))) : v]));
    // B starts with nothing local: its own data dir, an empty program cache, its own identity.
    const bCacheDir = join(DEMO_DIR, "runtime-b", "program-cache");
    const bCacheBefore = existsSync(bCacheDir) ? readdirSync(bCacheDir).length : 0;
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
    const lookupA = eventsA.events.find((e) => e.type === "network.lookup");
    const lookupB = eventsB.find((e) => e.type === "network.lookup");
    const idA = lookupA?.type === "network.lookup" ? lookupA.identity : undefined;
    const idB = lookupB?.type === "network.lookup" ? lookupB.identity : undefined;
    const imp = importB?.type === "network.import" ? importB : null;
    const actionsB: Record<string, number> = {};
    for (const e of eventsB) if (e.type === "action" && e.ok) actionsB[e.actionType] = (actionsB[e.actionType] ?? 0) + 1;
    const verifiedB = eventsB.filter((e) => e.type === "receipt" && e.status === "VERIFIED").length;
    const canaryB = eventsB.filter((e) => e.type === "log" && e.message.startsWith("write canary passed")).length;

    let outC: ReturnType<typeof brief> | null = null;
    let outW: ReturnType<typeof brief> | null = null;
    let diagC: ReturnType<typeof diagnose> | null = null;
    if (coldArm) {
      const scenarioC = await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
      if (scenarioC.scenarioId !== scenarioB.scenarioId || JSON.stringify(scenarioC.records) !== JSON.stringify(scenarioB.records)) throw new Error("C's scenario differs from B's");
      console.log(`\nC: same scenario as B${variation ? " and variation" : ""}, fresh runtime, strict-cold (network disabled, empty local cache)`);
      const resC = await engineC.execute(configFromScenario(scenarioC, { mode, knowledge: "strict-cold", thumbnails: false }));
      outC = brief("runtime-c", resC, await arena.check());
      diagC = diagnose((await engineC.events(resC.runId, 0, 10_000)).events);
      console.log(JSON.stringify(outC, null, 2));
      if (warmArm) {
        // Local warm-cache replay, a separate comparator: C again on the same records, reusing the
        // plan its own cold run cached (no network).
        const scenarioW = await arena.loadScenario({ seed: seed + 1, template: "t1-order-reconcile", records });
        if (JSON.stringify(scenarioW.records) !== JSON.stringify(scenarioB.records)) throw new Error("the warm replay's scenario differs from B's");
        console.log(`\nC warm: same scenario${variation ? " and variation" : ""}, runtime C again, local-only knowledge with its own warm cache`);
        const resW = await engineC.execute(configFromScenario(scenarioW, { mode, knowledge: "local-only", cache: "warm", thumbnails: false }));
        outW = brief("runtime-c-warm", resW, await arena.check());
        console.log(JSON.stringify(outW, null, 2));
      }
    }
    if (variation) await arena.resetVariations();
    const diagA = diagnose(eventsA.events);
    const diagB = diagnose(eventsB);

    const distinct = { check: "A and B are distinct runtimes: different network identities; B started with an empty local cache", ok: !!idA && !!idB && idA !== idB && bCacheBefore === 0 && (!imp?.publisher || (imp.publisher.startsWith(idA!) && !imp.publisher.startsWith(idB!))), detail: `A ${idA ?? "?"}, B ${idB ?? "?"}, capability publisher ${imp?.publisher?.slice(0, 16) ?? "?"}, B cache entries before its run ${bCacheBefore}` };
    const refusalChecks = [
      { check: "A passes the independent ground-truth check", ok: groundTruthOk(outA), detail: JSON.stringify(outA.checker) },
      { check: "B refused the capability for this interface, with reasons (nothing guessed)", ok: !!imp && !["EXACT_COMPATIBLE", "STRUCTURALLY_COMPATIBLE", "REQUIRES_REBINDING"].includes(imp.outcome) && (imp.refused?.length ?? 0) > 0 && !(policyB?.type === "policy.decision" && policyB.intelligence === "network-import"), detail: imp ? `${imp.outcome}: ${(imp.refused ?? []).slice(0, 3).join("; ")}` : "no network.import event" },
      { check: "B planned cold instead and passes the independent ground-truth check", ok: plannerB > 0 && groundTruthOk(outB), detail: `B planner calls ${plannerB}; ${JSON.stringify(outB.checker)}` },
      distinct,
    ];
    const conflictChecks = conflict
      ? [{ check: "X, asking for the task with one value changed, reused nothing and made zero writes", ok: !conflict.lookup.startsWith("FOUND") && conflict.importOutcome === null && conflict.writes === 0 && conflict.receipts === 0 && conflict.plannerCalls === 0, detail: `lookup ${conflict.lookup}; import ${conflict.importOutcome ?? "none"}; arena writes during X ${conflict.writes}; receipts ${conflict.receipts}; status ${conflict.status}${conflict.error ? ` (${conflict.error.slice(0, 120)})` : ""}` }]
      : [];
    const checks = [...conflictChecks, ...(expectRefusal ? refusalChecks : [
      { check: "A passes the independent ground-truth check", ok: groundTruthOk(outA), detail: JSON.stringify(outA.checker) },
      { check: "B passes the independent ground-truth check", ok: groundTruthOk(outB), detail: JSON.stringify(outB.checker) },
      distinct,
      { check: "B bound every control the capability needs (0 unbound)", ok: !!imp && imp.unbound === 0 && !imp.refused, detail: imp ? `${imp.bound} bound, ${imp.unbound} unbound` : "no network.import event" },
      { check: "B wrote through browser controls and verified each write by a fresh read", ok: (actionsB.click ?? 0) > 0 && verifiedB > 0, detail: `actions ${JSON.stringify(actionsB)}; ${verifiedB} VERIFIED receipts` },
      ...(variation
        ? [{ check: "B saw the UI change and rebound it: changed labels reported, writes behind a passed write canary", ok: !!imp && (imp.relabeled?.length ?? 0) > 0 && imp.writeCanary === true && canaryB > 0, detail: `${(imp?.relabeled ?? []).map((r) => `"${r.from}" -> "${r.to}" (${r.evidence})`).join(", ") || "nothing relabeled"}; write canary ${imp?.writeCanary ? `on, passed ${canaryB}x` : "off"}` }]
        : []),
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
      ...(outC ? [{ check: "C (strict-cold comparison arm) passes the independent ground-truth check", ok: groundTruthOk(outC), detail: JSON.stringify(outC.checker) }] : []),
      ...(outW ? [{ check: "C's local warm replay passes the independent ground-truth check", ok: groundTruthOk(outW), detail: JSON.stringify(outW.checker) }] : []),
    ])];
    console.log("\nacceptance checks");
    for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.check}: ${c.detail}`);
    const passed = checks.every((c) => c.ok);
    const ratio = (x: number, y: number) => Math.round((x / Math.max(y, 1e-9)) * 100) / 100;
    const comparison =
      outC && groundTruthOk(outB) && groundTruthOk(outC)
        ? { wallSpeedup: ratio(outC.wallMs, outB.wallMs), timeToFirstVerifiedSpeedup: outC.firstVerifiedMs && outB.firstVerifiedMs ? ratio(outC.firstVerifiedMs, outB.firstVerifiedMs) : null, modelCalls: { strictCold: outC.modelCalls, networkWarm: outB.modelCalls }, costUsd: { strictCold: outC.modelCostUsd, networkWarm: outB.modelCostUsd } }
        : { note: outC ? "not reported: at least one arm failed its ground-truth check" : "cold arm skipped" };
    const overhead = {
      aLookupMs: outA.network?.lookupMs ?? null,
      aPublishMs: publishMs,
      // Assigned in the worker callback, which TypeScript cannot see.
      validationMs: (validation as { ms: number } | null)?.ms ?? null,
      promoteMs: promoteMs,
      bLookupMs: outB.network?.lookupMs ?? null,
      bFetchMs: outB.network?.fetchMs ?? null,
      bRebindMs: outB.network?.rebindMs ?? null,
    };
    console.log(`\noverhead: ${JSON.stringify(overhead)}`);
    console.log(`B vs C: ${JSON.stringify(comparison)}`);
    for (const [k, d] of [["A", diagA], ["B", diagB], ["C", diagC]] as const) if (d) console.log(`${k} model calls: ${JSON.stringify(d.modelCallsByPurpose)}; fallbacks ${d.fallbacks.length}; recoveries ${d.recoveries}`);
    const transfer = { identities: { a: idA ?? null, b: idB ?? null, publisher: imp?.publisher?.slice(0, 16) ?? null }, bCacheBefore, variations: variation ? variationsB : null, relabeled: imp?.relabeled ?? [], writeCanary: imp?.writeCanary ?? false, canaryPassed: canaryB, refused: imp?.refused ?? [], importOutcome: imp?.outcome ?? null, actionsB, verifiedB };
    console.log(`transfer: ${JSON.stringify(transfer)}`);
    const report = { at: new Date().toISOString(), passed, expectRefusal, conflict, checks, database: DATABASE, endpoint: ENDPOINT, records, seed, variation: variation ?? null, mode, versionId, validation, overhead, plannerCalls: { a: plannerA, b: plannerB }, comparison, transfer, a: { ...outA, ...diagA }, b: { ...outB, ...diagB }, c: outC ? { ...outC, ...diagC } : null, warm: outW };
    writeFileSync(join(DEMO_DIR, "report.json"), JSON.stringify(report, null, 2));
    // A copy beside the benchmark results, for the dashboard's Transfer page and for review.
    const recordDir = join(REPO_ROOT, "benchmarks", "results", "network");
    mkdirSync(recordDir, { recursive: true });
    const recorded = join(recordDir, `${report.at.replace(/:/g, "-")}-s${seed}-${variation ?? "unchanged"}${expectRefusal ? "-refusal" : ""}.json`);
    writeFileSync(recorded, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${join(DEMO_DIR, "report.json")} (recorded as ${recorded})`);
    if (!passed) process.exitCode = 1;
    if (keep) {
      console.log(`\nengines still running: A http://127.0.0.1:4010, B http://127.0.0.1:4020${c ? ", C http://127.0.0.1:4030" : ""} (Ctrl+C stops them)`);
      await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
    }
  } finally {
    a.kill("SIGTERM");
    b.kill("SIGTERM");
    c?.kill("SIGTERM");
    x?.kill("SIGTERM");
    await browser.close();
    await validator.close();
    await admin.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
