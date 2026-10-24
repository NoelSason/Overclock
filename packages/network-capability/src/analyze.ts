import type { DslStep, Effect } from "@overclock/contracts";
import { parseExpr, parseTemplate, stepExprs } from "@overclock/compiler";
import { MAX_CAPABILITY_BYTES, PortableCapability, type PortableControl } from "@overclock/network-contracts";
import { isExactOperationIdentity } from "./export";
import { canonicalJson, verifyArtifactHash } from "./hash";
import { controlRefs, submitContexts, templateRoute } from "./plan";

/**
 * Static analysis of a capability, run by the importer before any browser work and by the
 * validation worker before live checks. Nothing here trusts the publisher: every rule is
 * re-derived from the artifact itself.
 */

export interface AnalysisIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string | undefined;
  stepId?: string | undefined;
}

export interface EffectSummary {
  /** Highest effect any step can have. */
  maxEffect: Effect;
  reads: number;
  writes: { stepId: string; app: string | undefined; control: string; effect: Effect; resources: string[] }[];
  irreversible: string[];
  appsWritten: string[];
}

export interface AnalysisResult {
  ok: boolean;
  issues: AnalysisIssue[];
  effects: EffectSummary;
  bytes: number;
}

export const LIMITS = {
  bytes: MAX_CAPABILITY_BYTES,
  phases: 20,
  steps: 300,
  controls: 400,
  pages: 60,
  applications: 8,
  stringLength: 4000,
  exprLength: 2000,
};

const ALLOWED_ROOTS = new Set(["rec", "input", "out", "phase", "key"]);
const FIELD_KINDS = new Set<PortableControl["kind"]>(["input", "select", "textarea", "checkbox"]);

function last(s: string): string {
  const parts = s.split("›");
  return parts[parts.length - 1]!.trim().toLowerCase();
}

/** URL safety: relative (`/…`, `?…`) or absolute http(s) on the step app's origin. No scripts, data, or protocol-relative URLs. */
export function checkUrlTemplate(template: string, appOrigin: string | undefined): string | null {
  let first: { lit: string; expr?: string } | undefined;
  try {
    first = parseTemplate(template)[0];
  } catch (err) {
    return `template does not parse: ${(err as Error).message}`;
  }
  const head = (first?.lit ?? "").trimStart();
  const t = template.trim();
  if (/^(?:javascript|data|vbscript|file|blob|about|chrome|filesystem):/i.test(t.replace(/[\s\u0000-\u001f]+/g, ""))) return "script/data URL";
  if (t.startsWith("//") || t.startsWith("\\\\") || t.startsWith("/\\") || t.startsWith("\\/")) return "protocol-relative URL";
  if (first?.expr !== undefined && head === "") return "URL starts with an expression (origin could be chosen at run time)";
  if (/^[a-z][a-z0-9+.-]*:/i.test(head)) {
    if (!/^https?:\/\//i.test(head)) return "non-http(s) absolute URL";
    const hostEnd = head.indexOf("/", head.indexOf("//") + 2);
    if (hostEnd < 0 && first?.expr !== undefined) return "URL host contains an expression";
    let origin: string;
    try {
      origin = new URL(hostEnd < 0 ? head : head.slice(0, hostEnd)).origin;
    } catch {
      return "absolute URL does not parse";
    }
    if (!appOrigin || origin !== appOrigin) return `absolute URL on ${origin}, outside the app's origin`;
    return null;
  }
  if (!head.startsWith("/") && !head.startsWith("?")) return "relative URL must start with '/' or '?'";
  return null;
}

export function analyzeCapability(input: unknown): AnalysisResult {
  const issues: AnalysisIssue[] = [];
  const err = (code: string, message: string, extra: Partial<AnalysisIssue> = {}) => issues.push({ severity: "error", code, message, ...extra });
  const warn = (code: string, message: string, extra: Partial<AnalysisIssue> = {}) => issues.push({ severity: "warning", code, message, ...extra });
  const empty: EffectSummary = { maxEffect: "read", reads: 0, writes: [], irreversible: [], appsWritten: [] };

  let bytes = 0;
  try {
    bytes = Buffer.byteLength(canonicalJson(input));
  } catch {
    err("schema", "capability is not serializable");
    return { ok: false, issues, effects: empty, bytes };
  }
  if (bytes > LIMITS.bytes) err("size", `capability is ${bytes} bytes (limit ${LIMITS.bytes})`);

  const parsed = PortableCapability.safeParse(input);
  if (!parsed.success) {
    for (const e of parsed.error.issues.slice(0, 20)) err("schema", `${e.path.join(".")}: ${e.message}`, { path: e.path.join(".") });
    return { ok: false, issues, effects: empty, bytes };
  }
  const cap = parsed.data;
  const plan = cap.procedure.plan;

  // ---- size limits
  const stepCount = plan.phases.reduce((n, p) => n + p.steps.length, 0);
  if (plan.phases.length > LIMITS.phases) err("size", `${plan.phases.length} phases (limit ${LIMITS.phases})`);
  if (stepCount > LIMITS.steps) err("size", `${stepCount} steps (limit ${LIMITS.steps})`);
  if (cap.controls.length > LIMITS.controls) err("size", `${cap.controls.length} controls (limit ${LIMITS.controls})`);
  if (cap.pages.length > LIMITS.pages) err("size", `${cap.pages.length} pages (limit ${LIMITS.pages})`);
  if (cap.applications.length > LIMITS.applications) err("size", `${cap.applications.length} applications (limit ${LIMITS.applications})`);
  const longString = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (v.length > LIMITS.stringLength) err("size", `string at ${path} is ${v.length} chars (limit ${LIMITS.stringLength})`, { path });
    } else if (Array.isArray(v)) v.forEach((x, i) => longString(x, `${path}.${i}`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) longString(x, path ? `${path}.${k}` : k);
  };
  longString(cap, "");

  // ---- integrity
  if (!verifyArtifactHash(cap)) err("hash-mismatch", "provenance.artifactHash does not match the canonical content");
  // An identity from the superseded scheme hashed a lossy goal (literals and numbers replaced by
  // placeholders), so it can't prove the importer asked for the same operation. Never reuse it.
  if (!isExactOperationIdentity(cap.intent.canonicalOperation)) err("operation-identity", "intent.canonicalOperation uses the superseded lossy scheme (literals and numbers erased); republish under the exact operation identity");

  // ---- origins
  const appOrigin = new Map<string, string>();
  for (const a of cap.applications) {
    let o: string | null = null;
    try {
      const u = new URL(a.origin);
      o = u.origin;
      if (u.protocol !== "http:" && u.protocol !== "https:") err("origin", `app ${a.name} origin is not http(s)`);
    } catch {
      err("origin", `app ${a.name} origin does not parse`);
    }
    if (o && o !== a.origin) err("origin", `app ${a.name} origin is not normalized (expected ${o})`);
    if (appOrigin.has(a.name)) err("duplicate-app", `application ${a.name} is listed twice`);
    if (o) appOrigin.set(a.name, o);
  }
  const allowed = [...new Set(cap.requirements.allowedOrigins)].sort();
  const appOrigins = [...new Set(appOrigin.values())].sort();
  if (allowed.join(" ") !== appOrigins.join(" ")) err("origin", `requirements.allowedOrigins (${allowed.join(", ")}) must equal the application origins (${appOrigins.join(", ")})`);

  // ---- controls and pages
  const controls = new Map<string, PortableControl>();
  for (const c of cap.controls) {
    if (controls.has(c.key)) err("duplicate-control", `control key ${c.key} appears twice`);
    controls.set(c.key, c);
    if (!appOrigin.has(c.app)) err("unknown-app", `control ${c.key} belongs to unknown app ${c.app}`);
    if (!c.key.startsWith(`${c.app}:${c.routeFamily}:${c.kind}:`)) err("control-key", `control key ${c.key} does not match its app/route/kind`);
    if (!cap.pages.some((p) => p.app === c.app && p.routeFamily === c.routeFamily)) warn("control-page", `control ${c.key} is on ${c.routeFamily}, which has no page entry (cannot be rebound)`);
    if (c.options && c.kind !== "select") warn("options", `control ${c.key} carries options but is a ${c.kind}`);
  }
  for (const p of cap.pages) {
    if (!appOrigin.has(p.app)) err("unknown-app", `page ${p.routeFamily} belongs to unknown app ${p.app}`);
    const segs = p.routeFamily.split("/");
    const tsegs = p.pathTemplate.split("/");
    const shapeOk = segs.length === tsegs.length && segs.every((s, i) => (s === ":id" ? /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(tsegs[i]!) : s === tsegs[i]));
    if (!shapeOk) err("path-template", `page ${p.app} ${p.routeFamily}: path template ${p.pathTemplate} does not match the route family`);
    if (p.reachVia && !cap.pages.some((q) => q.app === p.app && q.routeFamily === p.reachVia!.routeFamily)) warn("reach-via", `page ${p.routeFamily} is reached via ${p.reachVia.routeFamily}, which has no page entry`);
    if (p.reachVia?.tableKey && !controls.has(p.reachVia.tableKey)) warn("reach-via", `page ${p.routeFamily} reach table ${p.reachVia.tableKey} is not a control`);
  }

  // ---- procedure: expressions, urls, control references
  const phaseIds = new Set(plan.phases.map((p) => p.id));
  const parse = (source: string, ctx: { stepId?: string; path: string }) => {
    if (source.length > LIMITS.exprLength) err("size", `expression at ${ctx.path} is ${source.length} chars`, ctx);
    try {
      const p = parseExpr(source);
      for (const r of p.roots) if (!ALLOWED_ROOTS.has(r)) err("bad-expression", `unknown path root $${r} at ${ctx.path}`, ctx);
      for (const ref of p.phaseRefs) if (!phaseIds.has(ref)) err("bad-expression", `$phase.${ref} is not a phase (${ctx.path})`, ctx);
    } catch (e) {
      err("bad-expression", `${ctx.path}: ${(e as Error).message}`, ctx);
    }
  };
  const effects: EffectSummary = { maxEffect: "read", reads: 0, writes: [], irreversible: [], appsWritten: [] };
  const rank: Record<Effect, number> = { read: 0, "local-write": 1, "remote-write": 2, irreversible: 3 };
  const raise = (e: Effect) => {
    if (rank[e] > rank[effects.maxEffect]) effects.maxEffect = e;
  };
  plan.phases.forEach((phase, pi) => {
    if (phase.over) parse(phase.over, { path: `phases.${pi}.over` });
    if (phase.key) parse(phase.key, { path: `phases.${pi}.key` });
    let app: string | undefined;
    phase.steps.forEach((s: DslStep, si) => {
      const path = `phases.${pi}.steps.${si}`;
      for (const e of stepExprs(s)) parse(e, { stepId: s.id, path });
      if (s.op === "goto") {
        if (!appOrigin.has(s.app)) err("unknown-app", `goto ${s.id} targets unknown app ${s.app}`, { stepId: s.id });
        const bad = checkUrlTemplate(s.url, appOrigin.get(s.app));
        if (bad) err("unsafe-url", `goto ${s.id}: ${bad}`, { stepId: s.id });
        const route = templateRoute(s.url);
        if (route && !cap.pages.some((p) => p.app === s.app && p.routeFamily === route)) warn("unmapped-route", `goto ${s.id} opens ${route}, which has no page entry (not rebound)`, { stepId: s.id });
        app = s.app;
      }
      if (s.op === "extract" || s.op === "extractTable") effects.reads++;
      if (s.op === "submit") {
        const bad = checkUrlTemplate(s.verify.url, app ? appOrigin.get(app) : undefined);
        if (bad) err("unsafe-url", `submit ${s.id} verify url: ${bad}`, { stepId: s.id });
      }
    });
  });

  for (const r of controlRefs(plan)) {
    const c = controls.get(r.ref);
    if (!c) {
      err("unknown-control", `step ${r.stepId} references ${r.ref}, which is not in controls`, { stepId: r.stepId });
      continue;
    }
    if (r.app && c.app !== r.app) err("control-app-mismatch", `step ${r.stepId} uses ${c.app} control ${r.ref} while the page is ${r.app}`, { stepId: r.stepId });
    if (!r.app && r.role !== "verify" && r.role !== "guard") err("no-page", `step ${r.stepId} acts before any goto in its phase`, { stepId: r.stepId });
    const writes = c.effect === "remote-write" || c.effect === "irreversible";
    switch (r.op) {
      case "fill":
      case "select":
        if (!FIELD_KINDS.has(c.kind)) err("fill-target", `step ${r.stepId} fills a ${c.kind} (${r.ref})`, { stepId: r.stepId });
        break;
      case "click":
        if (writes) err("write-via-click", `step ${r.stepId} clicks ${r.ref}, which writes; writes must be submit steps with verification`, { stepId: r.stepId });
        break;
      case "submit":
        if (r.role === "target") {
          if (c.kind !== "button") err("submit-target", `submit ${r.stepId} targets a ${c.kind}`, { stepId: r.stepId });
          if (!writes) err("submit-target", `submit ${r.stepId} targets ${r.ref}, which is not the submit control of a POST form`, { stepId: r.stepId });
          if (!c.formSignature) err("submit-target", `submit ${r.stepId} targets ${r.ref}, which is not inside a form`, { stepId: r.stepId });
        }
        break;
      case "extractTable":
        if (r.role === "table" && c.kind !== "table") err("table-target", `step ${r.stepId} scans a ${c.kind}`, { stepId: r.stepId });
        if (r.role === "paginate" && c.kind !== "pagination" && c.kind !== "link" && c.kind !== "button") err("paginate-target", `step ${r.stepId} paginates with a ${c.kind}`, { stepId: r.stepId });
        break;
      default:
        break;
    }
  }

  // ---- writes: declared resources, verification, guards, effects
  const declared = cap.requirements.expectedEffects;
  for (const sc of submitContexts(plan)) {
    const s = sc.step;
    const c = controls.get(s.control);
    if (s.writes.length === 0) err("missing-writes", `submit ${s.id} declares no written resources`, { stepId: s.id });
    if (s.verify.fields.length === 0) err("missing-verification", `submit ${s.id} has no read-back verification`, { stepId: s.id });
    const irreversible = s.irreversible || c?.effect === "irreversible";
    if (c?.effect === "irreversible" && !s.irreversible) err("irreversible-mismatch", `submit ${s.id} targets an irreversible control but is not marked irreversible`, { stepId: s.id });
    const effect: Effect = irreversible ? "irreversible" : "remote-write";
    raise(effect);
    if (irreversible) {
      effects.irreversible.push(s.id);
      warn("irreversible-effect", `submit ${s.id} is irreversible and requires human approval at run time`, { stepId: s.id });
    }
    effects.writes.push({ stepId: s.id, app: sc.app, control: s.control, effect, resources: [...s.writes] });
    if (sc.app && !effects.appsWritten.includes(sc.app)) effects.appsWritten.push(sc.app);
    for (const w of s.writes) {
      if (!declared.some((d) => d.stepId === s.id && d.resource === w && d.effect === effect)) err("undeclared-effect", `submit ${s.id} writes ${w} (${effect}) but requirements.expectedEffects does not declare it`, { stepId: s.id });
    }
    const rule = cap.verification.rules.find((r) => r.stepId === s.id);
    if (!rule || rule.url !== s.verify.url || rule.fields.length !== s.verify.fields.length) err("verification-rule", `submit ${s.id} verification is not declared in verification.rules`, { stepId: s.id });
    // Overwriting a value read earlier needs a compare-and-swap guard on that field.
    const guarded = new Set(s.guards.map((g) => g.control));
    for (const f of sc.fills) {
      const fc = controls.get(f.control);
      const readDirect = sc.reads.some((r) => r.fields.some((x) => x.control === f.control));
      const readFact = !readDirect && fc && sc.reads.some((r) => r.fields.some((x) => controls.get(x.control)?.kind === "fact" && last(controls.get(x.control)!.name) === (fc.label ?? fc.name).trim().toLowerCase()));
      if (readDirect && !guarded.has(f.control)) err("missing-guard", `submit ${s.id} overwrites ${f.control}, which the plan read earlier, without a compare-and-swap guard`, { stepId: s.id });
      else if (readFact && !guarded.has(f.control)) warn("missing-guard", `submit ${s.id} overwrites ${f.control}; its value was read from the detail page but is not guarded`, { stepId: s.id });
    }
  }
  for (const d of declared) if (!effects.writes.some((w) => w.stepId === d.stepId)) err("undeclared-effect", `expectedEffects names step ${d.stepId}, which is not a submit`);
  for (const r of cap.verification.rules) for (const f of r.fields) if (!controls.has(f.control)) err("unknown-control", `verification rule ${r.stepId} uses unknown control ${f.control}`);

  const ok = !issues.some((i) => i.severity === "error");
  return { ok, issues, effects, bytes };
}
