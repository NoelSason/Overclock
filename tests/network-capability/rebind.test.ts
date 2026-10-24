import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BrowserManager } from "@overclock/browser-runtime";
import { compileProgram } from "@overclock/compiler";
import type { CapabilityCandidate, PortableCapability } from "@overclock/network-contracts";
import { controlRefs, interfaceSignatures, matchCandidates, matchControl, rebindCapability, registryFingerprints, withArtifactHash, type RebindResult } from "../../packages/network-capability/src/index";
import { exportFixture, loginState, OPERATOR, overTheWire, patchVariations, resetVariations, setupEnv, VIEWER, type Env } from "./fixtures";

let env: Env;
let cap: PortableCapability;
const latencies: { name: string; ms: number; pages: number; outcome: string }[] = [];

function track(name: string, r: RebindResult): RebindResult {
  latencies.push({ name, ms: r.report.ms, pages: r.report.pagesVisited, outcome: r.report.outcome });
  return r;
}

beforeAll(async () => {
  env = await setupEnv();
  cap = exportFixture(env).capability;
});
afterAll(async () => {
  console.log(`rebinding latencies:\n${latencies.map((l) => `  ${l.name.padEnd(28)} ${String(l.ms).padStart(5)} ms  ${l.pages} pages  ${l.outcome}`).join("\n")}`);
  await env?.close();
});
beforeEach(async () => {
  await resetVariations(env);
});

const rebind = (extra: Partial<Parameters<typeof rebindCapability>[0]> = {}) => rebindCapability({ capability: overTheWire(cap), apps: env.apps, browser: env.browser, storageState: env.operator, ...extra });

describe("rebinding", () => {
  it("rebinds in a fresh runtime: new local control ids from its own observation, and the plan compiles", async () => {
    // An independent runtime: its own browser process and its own login.
    const fresh = new BrowserManager({ headless: true });
    try {
      const state = await loginState(fresh, env.apps, OPERATOR);
      const r = track("fresh runtime (unchanged)", await rebindCapability({ capability: overTheWire(cap), apps: env.apps, browser: fresh, storageState: state }));
      expect(r.report.outcome).toBe("EXACT_COMPATIBLE");
      expect(r.report.writesSafe).toBe(true);
      expect(r.report.unbound).toEqual([]);
      expect(r.report.ambiguous).toEqual([]);
      expect(r.report.bound).toBe(cap.controls.length);
      expect(r.report.fingerprintMismatches).toBe(0);
      expect(r.report.fingerprintMatches).toBeGreaterThan(cap.pages.length);
      expect(r.report.pagesVisited).toBe(cap.pages.length);

      // Local ids come from the local runtime's models, never from the artifact.
      const artifact = JSON.stringify(cap);
      const localIds = new Set(r.models.flatMap((m) => Object.keys(m.controls)));
      for (const [key, id] of r.bindings) {
        expect(localIds.has(id), id).toBe(true);
        expect(id).not.toBe(key);
        expect(artifact.includes(`"${id}"`), id).toBe(false);
      }
      // The local models were built from new observations (not the publisher's).
      const publisherObs = new Set(env.models.flatMap((m) => m.pages.map((p) => p.observationId)));
      for (const m of r.models) for (const p of m.pages) expect(publisherObs.has(p.observationId)).toBe(false);
      // Every control reference in the rebound plan is a local id, and it compiles.
      for (const ref of controlRefs(r.plan)) expect(localIds.has(ref.ref), ref.ref).toBe(true);
      expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(r.program).not.toBeNull();
      const compiled = compileProgram(r.program!);
      expect(compiled.stats.writeSegments).toBe(1);
      expect(r.details.bindings.every((b) => b.evidence === "label")).toBe(true);
      // Concrete params found during the mini-crawl stay local (not part of the report).
      expect(r.details.paramValues.Orders?.orderId).toMatch(/^ORD-\d+$/);
      expect(JSON.stringify(r.report)).not.toMatch(/ORD-\d+/);
    } finally {
      await fresh.close();
    }
  });

  it("is EXACT_COMPATIBLE on the unchanged arena with the publisher's own browser too", async () => {
    const r = track("unchanged", await rebind({ records: env.records }));
    expect(r.report.outcome).toBe("EXACT_COMPATIBLE");
    expect(r.report.writesSafe).toBe(true);
    // A caller-supplied record is used for the record-field path param.
    expect(r.details.paramValues.Orders?.orderId).toBe(String(env.records[0]!.orderId));
  });

  it("falls back to a list link when the caller's record does not exist in this app", async () => {
    const r = track("unknown record id", await rebind({ records: [{ orderId: "ORD-1" }] }));
    expect(r.report.outcome).toBe("EXACT_COMPATIBLE");
    expect(r.details.paramValues.Orders?.orderId).not.toBe("ORD-1");
    expect(r.details.missingRoutes).toEqual([]);
  });

  it("reordered form fields: same labels, different region structure -> STRUCTURALLY_COMPATIBLE, writes safe", async () => {
    await patchVariations(env, { shuffleFields: { Orders: 4242 } });
    const r = track("shuffled form fields", await rebind());
    expect(r.report.outcome).toBe("STRUCTURALLY_COMPATIBLE");
    expect(r.report.fingerprintMismatches).toBeGreaterThan(0);
    expect(r.details.bindings.every((b) => b.evidence === "label")).toBe(true);
    expect(r.report.writesSafe).toBe(true);
  });

  it("renamed save button: binds structurally, REQUIRES_REBINDING, writes not safe", async () => {
    await patchVariations(env, { renameButtons: { Orders: { "Update order": "Apply changes" } } });
    const r = track("renamed save button", await rebind());
    expect(["REQUIRES_REBINDING", "REQUIRES_REPAIR"]).toContain(r.report.outcome);
    expect(r.report.outcome).toBe("REQUIRES_REBINDING");
    expect(r.report.writesSafe).toBe(false);
    const save = r.details.bindings.find((b) => b.key === "Orders:/orders/:id/edit:button:update_order")!;
    expect(save.evidence).toBe("structural");
    const local = r.models.find((m) => m.app === "Orders")!.controls[save.localId!]!;
    expect(local.name).toBe("Apply changes");
    expect(r.report.fingerprintMismatches).toBeGreaterThan(0);
    expect(r.program).not.toBeNull();
  });

  it("fields moved into a tab: REQUIRES_REPAIR, writes not safe", async () => {
    await patchVariations(env, { editInTab: { Orders: true } });
    const r = track("edit form in tab", await rebind());
    expect(r.report.outcome).toBe("REQUIRES_REPAIR");
    expect(r.report.writesSafe).toBe(false);
    expect(r.details.flags).toEqual(expect.arrayContaining(["hidden-in-tab:Orders:/orders/:id/edit:input:review_reason", "hidden-in-tab:Orders:/orders/:id/edit:select:status"]));
    // Labels are unchanged, so every control still binds by label; the write's precondition changed.
    expect(r.report.unbound).toEqual([]);
  });

  it("is INCOMPATIBLE for a different origin, without browsing", async () => {
    const wrongApp = track("different origin", await rebind({ apps: [{ name: "Orders", origin: env.arena.origins.CRM }, env.apps[1]!] }));
    expect(wrongApp.report.outcome).toBe("INCOMPATIBLE");
    expect(wrongApp.report.pagesVisited).toBe(0);
    expect(wrongApp.report.writesSafe).toBe(false);
    expect(wrongApp.report.unbound.length).toBeGreaterThan(0);
    const unbound = await rebind({ apps: [env.apps[1]!] });
    expect(unbound.report.outcome).toBe("INCOMPATIBLE");
  });

  it("is INCOMPATIBLE when a route family is missing", async () => {
    const extra = withArtifactHash({
      ...structuredClone(cap),
      pages: [...structuredClone(cap.pages), { app: "Orders", routeFamily: "/reports", pathTemplate: "/reports", pageFingerprint: "000000000000", regionFingerprints: {} }],
    });
    const r = track("missing route family", await rebindCapability({ capability: extra, apps: env.apps, browser: env.browser, storageState: env.operator }));
    expect(r.report.outcome).toBe("INCOMPATIBLE");
    expect(r.details.missingRoutes.map((m) => m.routeFamily)).toEqual(["/reports"]);
  });

  it("a session without access, or a viewer session, is not treated as write-compatible", async () => {
    // No session: every route redirects to /login.
    const anon = track("no session", await rebind({ storageState: undefined }));
    expect(anon.report.outcome).toBe("INCOMPATIBLE");
    expect(anon.report.writesSafe).toBe(false);
    expect(anon.details.missingRoutes[0]!.reason).toMatch(/login/);

    // Viewer: the arena renders the same UI and refuses writes server-side with 403. A GET-only
    // observation cannot see that, so the caller declares the session's role class.
    const viewer = await loginState(env.browser, env.apps, VIEWER);
    const declared = track("viewer (declared reader)", await rebind({ storageState: viewer, sessionRoleClass: "reader" }));
    expect(declared.report.writesSafe).toBe(false);
    expect(declared.report.outcome).toBe("INCOMPATIBLE");
    expect(declared.details.flags.some((f) => f.startsWith("role-class:Orders"))).toBe(true);
    // Documented limitation: undeclared, the viewer's interface is observationally identical.
    const undeclared = await rebind({ storageState: viewer });
    expect(undeclared.report.fingerprintMismatches).toBe(0);
  });
});

describe("matching", () => {
  it("never guesses: ambiguous candidates are listed, not bound", () => {
    const pc = cap.controls.find((c) => c.key === "Orders:/orders/:id/edit:select:status")!;
    const local = (id: string, extra: Record<string, unknown> = {}) => ({
      control: { id, app: "Orders", page: pc.routeFamily, role: "combobox", name: "Status", label: "Status", kind: "select" as const, locator: { strategies: [{ kind: "label" as const, text: "Status" }], confidence: 0.9, evidence: [] } },
      descriptor: { app: "Orders", routeFamily: pc.routeFamily, kind: "select" as const, role: "combobox", name: "Status", label: "Status", options: pc.options, strategies: [], semanticName: "Status", redactions: 0, ...extra },
    });
    const ambiguous = matchControl(pc, [local("a"), local("b")]);
    expect(ambiguous.localId).toBeNull();
    expect(ambiguous.reason).toMatch(/^ambiguous/);
    // Form-signature agreement breaks the tie deterministically.
    const tie = matchControl(pc, [local("a"), local("b", { formSignature: pc.formSignature, param: pc.param })]);
    expect(tie.localId).toBe("b");
    // Options changed: no longer a label-level match.
    const changed = matchControl(pc, [local("c", { options: [{ value: "open", label: "Open" }] })]);
    expect(changed.evidence).not.toBe("label");
    expect(matchControl(pc, []).reason).toMatch(/no select/);
  });

  it("ranks registry candidates deterministically from interface signatures", async () => {
    const r = await rebind();
    const sigs = interfaceSignatures(r.models);
    const fps = registryFingerprints(cap);
    const origins = cap.applications.map((a) => a.origin);
    const cand = (versionId: string, extra: Partial<CapabilityCandidate> = {}): CapabilityCandidate => ({
      capabilityId: cap.capabilityId,
      versionId,
      version: 1,
      canonicalOperation: cap.intent.canonicalOperation,
      origins,
      interfaceFingerprints: fps,
      state: "ACTIVE",
      contentHash: cap.provenance.artifactHash,
      bytes: 1000,
      publisherId: "p1",
      validations: 1,
      successfulReuses: 0,
      updatedAt: 1,
      ...extra,
    });
    const candidates = [
      cand("v-canary", { state: "CANARY", version: 3 }),
      cand("v-active", { version: 2, successfulReuses: 4 }),
      cand("v-stale", { version: 1, interfaceFingerprints: ["ffffffffffff"] }),
      cand("v-quarantined", { state: "QUARANTINED", version: 4 }),
      cand("v-other-op", { canonicalOperation: "0".repeat(64) }),
      cand("v-foreign", { origins: ["https://elsewhere.example.net"] }),
    ];
    const ranked = matchCandidates(sigs, candidates, { canonicalOperation: cap.intent.canonicalOperation, origins });
    expect(ranked.map((m) => m.candidate.versionId)).toEqual(["v-active", "v-stale", "v-canary"]);
    expect(ranked[0]!.fingerprintOverlap).toBe(1);
    expect(ranked[0]!.predicted).toBe("EXACT_COMPATIBLE");
    expect(ranked[1]!.predicted).toBe("REQUIRES_REBINDING");
    // Same inputs in any order give the same ranking.
    const again = matchCandidates(sigs, [...candidates].reverse(), { canonicalOperation: cap.intent.canonicalOperation, origins });
    expect(again.map((m) => [m.candidate.versionId, m.score])).toEqual(ranked.map((m) => [m.candidate.versionId, m.score]));
  });
});
