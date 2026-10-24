import type { AppBinding } from "@overclock/contracts";
import type { BrowserManager, StorageState } from "@overclock/browser-runtime";
import { compileProgram } from "@overclock/compiler";
import { dryRunCandidate, type DryRunResult } from "@overclock/discovery";
import { PortableCapability, type RebindReport, type ValidationResult } from "@overclock/network-contracts";
// Relative import: services/network/* is outside the pnpm workspace globs (services/*), so the
// package is not linked here. See the report for the proposed workspace change.
import { analyzeCapability, canonicalJson, rebindCapability, sanitizeCapability, scrubText, sha256, verifyArtifactHash, type AnalysisResult, type Finding, type RebindResult } from "../../../../packages/network-capability/src/index";

/**
 * Independent validation of a proposed capability. Nothing the publisher claims is trusted:
 * the validator re-runs the sanitizer and static analysis, rebinds every control against its
 * own live observation in a mutation-blocked context, and dry-runs the rebound plan's read
 * segments for one record.
 *
 * Write steps are never executed here. Validation of writes relies on static analysis (writes
 * declared, verify blocks present, guards, POST-form submit targets, irreversible effects
 * flagged) plus the publisher's verified-receipt evidence. Full sandbox write-validation
 * (executing writes against a disposable copy of the app) is not implemented.
 */

export const WRITE_VALIDATION_LIMITATION =
  "Writes were not executed: write validation relies on static analysis plus the publisher's verified-receipt evidence; full sandbox write-validation is not implemented.";

export type ValidationCategory = "ok" | "schema" | "integrity" | "sanitizer" | "static-analysis" | "incompatible" | "requires-repair" | "requires-rebinding" | "writes-unsafe" | "no-probe-record" | "dry-run" | "dry-run-mutation" | "error";

export interface ValidateArgs {
  /** Untrusted artifact as fetched from the network. */
  capability: unknown;
  /** The validator's own app bindings (its environment). */
  apps: AppBinding[];
  browser: BrowserManager;
  storageState?: StorageState | undefined;
  versionId?: string | undefined;
  /** Non-sensitive environment label recorded with the result. */
  environment?: string | undefined;
  /** Validator-owned probe records; when absent, one is derived from the live list pages. */
  records?: Record<string, unknown>[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface EvidenceSummary {
  schema: "overclock-validation-evidence/1";
  versionId: string;
  capabilityId: string | null;
  version: number | null;
  artifactHash: string | null;
  environment: string;
  category: ValidationCategory;
  outcome: "pass" | "fail";
  sanitizer: { ok: boolean; redactions: number; findings: { path: string; kind: string; action: string }[] } | null;
  analysis: { ok: boolean; errors: string[]; warnings: string[]; maxEffect: string; writes: number; irreversible: number } | null;
  rebind: { outcome: string; bound: number; unbound: string[]; ambiguous: string[]; writesSafe: boolean; pagesVisited: number; fingerprintMatches: number; fingerprintMismatches: number; flags: string[] } | null;
  dryRun: { ok: boolean; segments: { segmentId: string; ok: boolean; skipped: boolean }[]; failures: number; blockedMutations: number } | null;
  writesExecuted: 0;
  writeValidation: "static-analysis+publisher-receipts";
  publisherVerifiedReceipts: number | null;
}

export interface ValidationReport {
  result: ValidationResult;
  evidence: EvidenceSummary;
  analysis: AnalysisResult | null;
  sanitizerFindings: Finding[];
  rebind: RebindResult | null;
  dryRun: DryRunResult | null;
  limitations: string[];
  ms: number;
}

/** Probe record for the dry run, from path params resolved during rebinding (e.g. the list page's first order). */
export function probeRecord(cap: PortableCapability, rebind: RebindResult): Record<string, unknown> | null {
  const rec: Record<string, unknown> = {};
  for (const f of cap.intent.inputSchema.recordFields) {
    for (const p of cap.pages) {
      if (!p.pathTemplate.includes(`{${f}}`)) continue;
      const v = rebind.details.paramValues[p.app]?.[f];
      if (v !== undefined) {
        rec[f] = v;
        break;
      }
    }
    if (rec[f] === undefined) return null;
  }
  return rec;
}

function needsRecords(cap: PortableCapability): boolean {
  return cap.procedure.plan.phases.some((p) => p.kind === "foreach" && /\$input\.records/.test(p.over ?? ""));
}

export async function validateProposedCapability(args: ValidateArgs): Promise<ValidationReport> {
  const t0 = performance.now();
  const environment = args.environment ?? "validator";
  const limitations = [WRITE_VALIDATION_LIMITATION];
  const raw = args.capability as Partial<PortableCapability> | null;
  const versionId = args.versionId ?? (raw && typeof raw === "object" ? `${String(raw.capabilityId)}@${String(raw.version)}` : "unknown");
  const evidence: EvidenceSummary = {
    schema: "overclock-validation-evidence/1",
    versionId,
    capabilityId: null,
    version: null,
    artifactHash: null,
    environment,
    category: "error",
    outcome: "fail",
    sanitizer: null,
    analysis: null,
    rebind: null,
    dryRun: null,
    writesExecuted: 0,
    writeValidation: "static-analysis+publisher-receipts",
    publisherVerifiedReceipts: null,
  };
  let analysis: AnalysisResult | null = null;
  let sanitizerFindings: Finding[] = [];
  let rebind: RebindResult | null = null;
  let dryRun: DryRunResult | null = null;

  const finish = (category: ValidationCategory, detail: string): ValidationReport => {
    evidence.category = category;
    evidence.outcome = category === "ok" ? "pass" : "fail";
    const digest = sha256(canonicalJson(evidence));
    const text = scrubText(`${evidence.outcome}: ${detail} ${category === "ok" || evidence.analysis?.writes ? `| ${WRITE_VALIDATION_LIMITATION}` : ""}`).text.slice(0, 500);
    return {
      result: { versionId, environment, outcome: evidence.outcome, category, evidenceDigest: digest, detail: text },
      evidence,
      analysis,
      sanitizerFindings,
      rebind,
      dryRun,
      limitations,
      ms: Math.round(performance.now() - t0),
    };
  };

  try {
    // 1. schema
    const parsed = PortableCapability.safeParse(args.capability);
    if (!parsed.success) return finish("schema", `schema invalid: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const cap = parsed.data;
    evidence.capabilityId = cap.capabilityId;
    evidence.version = cap.version;
    evidence.artifactHash = cap.provenance.artifactHash;
    evidence.publisherVerifiedReceipts = cap.provenance.verifiedReceipts;

    // 2. integrity
    if (!verifyArtifactHash(cap)) return finish("integrity", "artifact hash does not match its canonical content");

    // 3. sanitizer re-check: the validator judges, it does not repair. Any redaction is a failure.
    const s = sanitizeCapability(cap, { records: args.records });
    sanitizerFindings = s.findings;
    evidence.sanitizer = { ok: s.ok && s.redactions === 0, redactions: s.redactions, findings: s.findings.map((f) => ({ path: f.path, kind: f.kind, action: f.action })) };
    if (!s.ok || s.redactions > 0) return finish("sanitizer", `sanitizer: ${s.rejected.length} rejecting and ${s.redactions} redactable finding(s), e.g. ${(s.rejected[0] ?? s.findings[0]?.detail ?? "").slice(0, 160)}`);

    // 4. static analysis
    analysis = analyzeCapability(cap);
    const errors = analysis.issues.filter((i) => i.severity === "error");
    evidence.analysis = {
      ok: analysis.ok,
      errors: [...new Set(errors.map((i) => i.code))].sort(),
      warnings: [...new Set(analysis.issues.filter((i) => i.severity === "warning").map((i) => i.code))].sort(),
      maxEffect: analysis.effects.maxEffect,
      writes: analysis.effects.writes.length,
      irreversible: analysis.effects.irreversible.length,
    };
    if (!analysis.ok) return finish("static-analysis", `static analysis: ${errors.slice(0, 3).map((e) => `${e.code}: ${e.message}`).join("; ")}`);

    // 5. live rebinding in a mutation-blocked context
    rebind = await rebindCapability({ capability: cap, apps: args.apps, browser: args.browser, storageState: args.storageState, records: args.records, signal: args.signal });
    const r: RebindReport = rebind.report;
    evidence.rebind = {
      outcome: r.outcome,
      bound: r.bound,
      unbound: r.unbound.map((u) => u.key).sort(),
      ambiguous: [...r.ambiguous].sort(),
      writesSafe: r.writesSafe,
      pagesVisited: r.pagesVisited,
      fingerprintMatches: r.fingerprintMatches,
      fingerprintMismatches: r.fingerprintMismatches,
      flags: [...rebind.details.flags].sort(),
    };
    if (r.outcome === "INCOMPATIBLE") return finish("incompatible", `rebinding: INCOMPATIBLE (${[...rebind.details.missingRoutes.map((m) => `${m.app} ${m.routeFamily}: ${m.reason}`), ...rebind.details.flags].slice(0, 3).join("; ")})`);
    if (r.outcome === "REQUIRES_REPAIR") return finish("requires-repair", `rebinding: REQUIRES_REPAIR (${[...r.unbound.map((u) => `${u.key}: ${u.reason}`), ...r.ambiguous.map((a) => `${a}: ambiguous`), ...rebind.details.flags, ...rebind.issues.filter((i) => i.severity === "error").map((i) => i.code)].slice(0, 3).join("; ")})`);
    if (r.outcome === "REQUIRES_REBINDING") return finish("requires-rebinding", `rebinding: labels changed since publication; ${r.bound} bound, writesSafe=${r.writesSafe}`);
    if (!r.writesSafe) return finish("writes-unsafe", `rebinding: ${r.outcome} but writes are not safe (${rebind.details.flags.slice(0, 3).join("; ") || "non-label evidence on a write control"})`);
    if (!rebind.program) return finish("requires-repair", "rebound plan did not compile");

    // 6. read-only dry run of the rebound plan for one record
    let records: Record<string, unknown>[] = [];
    if (needsRecords(cap)) {
      const probe = args.records?.[0] ?? probeRecord(cap, rebind);
      if (!probe) return finish("no-probe-record", "no probe record: no record field maps to a path parameter the validator could resolve, and none was supplied");
      records = [probe];
    }
    const compiled = compileProgram({ ...rebind.program, inputs: { records } });
    dryRun = await dryRunCandidate({ compiled, browser: args.browser, storageState: args.storageState, apps: rebind.models.map((m) => ({ name: m.app, origin: m.origin })), inputs: { records }, signal: args.signal });
    evidence.dryRun = {
      ok: dryRun.ok,
      segments: dryRun.segments.map((x) => ({ segmentId: x.segmentId, ok: x.ok, skipped: x.skipped !== undefined })),
      failures: dryRun.failures.length,
      blockedMutations: dryRun.blockedMutations,
    };
    if (dryRun.blockedMutations > 0) return finish("dry-run-mutation", `dry run: a read segment attempted ${dryRun.blockedMutations} mutation(s) (blocked)`);
    if (!dryRun.ok) return finish("dry-run", `dry run failed: ${dryRun.failures.slice(0, 2).join("; ")}`);

    const ran = dryRun.segments.filter((x) => !x.skipped).length;
    const skipped = dryRun.segments.length - ran;
    return finish("ok", `${r.outcome}; ${r.bound} controls bound; ${r.pagesVisited} pages; dry run ${ran} read segment(s) ok, ${skipped} write/dependent segment(s) skipped; publisher receipts ${cap.provenance.verifiedReceipts}`);
  } catch (err) {
    return finish("error", `validator error: ${(err as Error).message.split("\n")[0]!.slice(0, 200)}`);
  }
}
