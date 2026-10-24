import type { DslStep, LocatorStrategy } from "@overclock/contracts";
import { parseExpr, parseTemplate, type Ast } from "@overclock/compiler";
import { PortableCapability, type PortableControl } from "@overclock/network-contracts";
import { withArtifactHash } from "./hash";

/**
 * Sanitizer: the last gate before a capability leaves the machine, and the first check a
 * validator runs on one it received. Policy by field class:
 *
 *  - procedure literals (expressions, url/resource templates, waitFor text, identifiers): data
 *    cannot be removed without changing what the procedure does, so concrete record data there
 *    REJECTS the capability. Templates such as `concat('Reconciled: refund confirmed for ', $rec.orderId)`
 *    are fine: the literal holds no record data, the record value is bound at run time.
 *  - descriptors (control names/labels/options/strategies, page templates): data is removed or
 *    replaced by placeholders, and each removal counts as a redaction.
 *  - free text (step notes, strategy summary/rationale, assumptions, risks, descriptions):
 *    notes are dropped; the rest is scrubbed.
 *  - credentials (cookies, bearer tokens, API keys, passwords, session ids, long random tokens)
 *    REJECT the capability wherever they appear.
 */

export type FindingKind = "credential" | "email" | "phone" | "record-id" | "record-value" | "person-name" | "long-number" | "query-value" | "positional-locator" | "free-text" | "enumeration" | "format";

export interface Finding {
  path: string;
  kind: FindingKind;
  action: "redacted" | "rejected";
  /** What was found, never the value itself. */
  detail: string;
}

export interface SanitizeOptions {
  /** Input records of the publishing run; any of their values found in the artifact is data. */
  records?: Record<string, unknown>[] | undefined;
}

export interface SanitizeResult {
  ok: boolean;
  capability: PortableCapability;
  redactions: number;
  findings: Finding[];
  /** Human-readable reasons, one per rejecting finding. */
  rejected: string[];
}

// ---------------------------------------------------------------------------------------------
// Detectors

const CREDENTIAL_PATTERNS: [string, RegExp][] = [
  ["API key (sk-…)", /\bsk-[A-Za-z0-9_-]{12,}/],
  ["API key (prefixed live/test key)", /\b(?:ts|pk|rk|sk)_(?:live_|test_)?[A-Za-z0-9]{16,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer/basic token", /\b(?:Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/i],
  ["password/secret assignment", /\b(?:pass(?:word|wd)?|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?(?:id|token)|sid|token)\s*[:=]\s*["']?[^\s"'&;,]{4,}/i],
  ["cookie header", /\b(?:set-)?cookie\s*:/i],
  ["session cookie value", /\b[A-Za-z0-9_.-]*(?:session|sess|sid|token|auth|jwt)[A-Za-z0-9_.-]*=[A-Za-z0-9%._~+/-]{12,}/i],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@{}]+:[^\s/@{}]+@/i],
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Credential-like substrings (kinds only). Long random tokens count: session ids are usually exactly that. */
export function findCredentials(s: string): string[] {
  const out: string[] = [];
  for (const [kind, re] of CREDENTIAL_PATTERNS) if (re.test(s)) out.push(kind);
  for (const m of s.matchAll(/[A-Za-z0-9+/_=-]{24,}/g)) {
    const t = m[0];
    if (/\d/.test(t) && /[A-Za-z]/.test(t) && entropy(t) >= 3.5 && !/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(t)) {
      out.push("long random token");
      break;
    }
  }
  if (/(?:^|[^0-9a-f])[0-9a-f]{32,}(?:$|[^0-9a-f])/i.test(s)) out.push("long hex token");
  return [...new Set(out)];
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|\+\d{8,15}\b/g;
/** Concrete record ids: ORD-50012, C-1001, TCK-7, INV2024001, UUIDs. */
const RECORD_ID = /\b[A-Z]{1,6}-\d{1,}\b|\b[A-Z]{2,6}\d{4,}\b|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const LONG_NUMBER = /\b\d{5,}\b/g;
const PERSON_NAME = /^[A-Z][a-z]+(?:[ '-][A-Z][a-z]+){1,3}$/;

export interface DataContext {
  /** Lowercased record values to treat as data. */
  recordValues: string[];
  /** Lowercased schema strings (labels, option values, headers) that are never data. */
  schema: Set<string>;
}

export function dataContext(records: Record<string, unknown>[] | undefined, schema: Iterable<string> = []): DataContext {
  const schemaSet = new Set<string>();
  for (const s of schema) if (s) schemaSet.add(s.trim().toLowerCase());
  const values = new Set<string>();
  for (const r of records ?? []) {
    for (const [k, v] of Object.entries(r)) {
      const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
      const lower = s.toLowerCase();
      if (!s || lower === k.toLowerCase() || schemaSet.has(lower)) continue;
      if (s.length >= 4 || (s.length >= 2 && /\d/.test(s))) values.add(lower);
    }
  }
  return { recordValues: [...values].sort((a, b) => b.length - a.length), schema: schemaSet };
}

export interface DataHit {
  kind: Exclude<FindingKind, "credential" | "query-value" | "positional-locator" | "free-text" | "enumeration" | "format">;
}

/** Data-like content in a string (kinds only). */
export function findData(s: string, ctx: DataContext, opts: { literal?: boolean } = {}): DataHit[] {
  const hits: DataHit[] = [];
  if (new RegExp(EMAIL.source).test(s)) hits.push({ kind: "email" });
  if (new RegExp(PHONE.source).test(s)) hits.push({ kind: "phone" });
  if (new RegExp(RECORD_ID.source).test(s)) hits.push({ kind: "record-id" });
  if (new RegExp(LONG_NUMBER.source).test(s)) hits.push({ kind: "long-number" });
  const lower = s.toLowerCase();
  if (ctx.recordValues.some((v) => lower.includes(v))) hits.push({ kind: "record-value" });
  if (opts.literal && PERSON_NAME.test(s.trim()) && !ctx.schema.has(lower.trim())) hits.push({ kind: "person-name" });
  return hits;
}

/**
 * Replace data-like substrings with placeholders. Deterministic, so the publisher and a fresh
 * runtime scrub the same label to the same text (the matcher compares scrubbed labels).
 */
export function scrubText(s: string, ctx?: DataContext): { text: string; count: number } {
  let count = 0;
  const sub = (re: RegExp, ph: string) => (t: string) =>
    t.replace(re, () => {
      count++;
      return ph;
    });
  let t = s;
  t = sub(new RegExp(EMAIL.source, "g"), "{email}")(t);
  t = sub(new RegExp(PHONE.source, "g"), "{phone}")(t);
  t = sub(new RegExp(RECORD_ID.source, "g"), "{id}")(t);
  t = sub(new RegExp(LONG_NUMBER.source, "g"), "{n}")(t);
  for (const v of ctx?.recordValues ?? []) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    t = sub(re, "{value}")(t);
  }
  return { text: t, count };
}

/** Strings whose value is a hash we computed (validated by format instead of scanned). */
function isHashPath(path: string): boolean {
  return (
    path === "provenance.artifactHash" ||
    path === "intent.canonicalOperation" ||
    path === "capabilityId" ||
    path === "publisherId" ||
    path === "provenance.validationEvidenceId" ||
    /\.(regionFingerprint|pageFingerprint|interfaceFingerprint|formSignature)$/.test(path) ||
    /\.regionFingerprints\.[^.]+$/.test(path)
  );
}

// ---------------------------------------------------------------------------------------------
// Sanitizer

const LABEL_ANCHORED_XPATH = /^xpath=\/\/(?:dt|tr\/th|th|label)\[normalize-space\(\)=("(?:[^"\\]|\\.)*")\]\/following-sibling::(?:dd|td)\[1\]$/;

/** Label-anchored xpath strategies are the only css-kind strategies that survive export. */
export function isLabelAnchoredXpath(s: LocatorStrategy): boolean {
  return s.kind === "css" && LABEL_ANCHORED_XPATH.test(s.selector);
}

function exprLiterals(source: string): { strings: string[]; numbers: number[]; parsed: boolean } {
  const strings: string[] = [];
  const numbers: number[] = [];
  let ast: Ast;
  try {
    ast = parseExpr(source).ast;
  } catch {
    return { strings: [source], numbers, parsed: false };
  }
  const visit = (a: Ast): void => {
    switch (a.k) {
      case "lit":
        if (typeof a.v === "string") strings.push(a.v);
        else if (typeof a.v === "number") numbers.push(a.v);
        break;
      case "member":
        visit(a.obj);
        break;
      case "index":
        visit(a.obj);
        visit(a.index);
        break;
      case "call":
        a.args.forEach(visit);
        break;
      case "unary":
        visit(a.arg);
        break;
      case "binary":
        visit(a.left);
        visit(a.right);
        break;
      case "list":
        a.items.forEach(visit);
        break;
      case "root":
        break;
    }
  };
  visit(ast);
  return { strings, numbers, parsed: true };
}

const SAFE_QUERY_VALUE = /^[A-Za-z_][A-Za-z0-9_ -]{0,30}$/;

/** Keys present in `a` but dropped by schema parsing (unknown fields such as `sample` or `exampleUrl`). */
function strippedKeys(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    a.forEach((x, i) => strippedKeys(x, b[i], `${path}.${i}`, out));
    return;
  }
  if (a && typeof a === "object" && b && typeof b === "object" && !Array.isArray(a)) {
    for (const k of Object.keys(a)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in b)) out.push(p);
      else strippedKeys((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], p, out);
    }
  }
}

export function sanitizeCapability(input: PortableCapability, opts: SanitizeOptions = {}): SanitizeResult {
  const findings: Finding[] = [];
  let redactions = 0;
  const parsed = PortableCapability.safeParse(input);
  if (!parsed.success) {
    const reasons = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
    return { ok: false, capability: input, redactions: 0, findings: reasons.map((r) => ({ path: r.split(":")[0] ?? "", kind: "format" as const, action: "rejected" as const, detail: `schema: ${r}` })), rejected: reasons.map((r) => `schema: ${r}`) };
  }
  const cap = structuredClone(parsed.data);
  const unknown: string[] = [];
  strippedKeys(input, parsed.data, "", unknown);
  for (const p of unknown) {
    findings.push({ path: p, kind: "free-text", action: "redacted", detail: "unknown field removed (artifacts carry schema fields only; no samples, example URLs, or traces)" });
    redactions++;
  }
  const schema: string[] = [];
  for (const c of cap.controls) {
    schema.push(c.name, c.label ?? "", c.tabPanel ?? "", ...(c.headers ?? []));
    for (const o of c.options ?? []) schema.push(o.value, o.label);
  }
  const ctx = dataContext(opts.records, schema);
  const reject = (path: string, kind: FindingKind, detail: string) => findings.push({ path, kind, action: "rejected", detail });
  const redact = (path: string, kind: FindingKind, detail: string, n = 1) => {
    findings.push({ path, kind, action: "redacted", detail });
    redactions += n;
  };
  const credentialCheck = (path: string, s: string): boolean => {
    const kinds = findCredentials(s);
    for (const k of kinds) reject(path, "credential", `${k} in a capability field`);
    return kinds.length > 0;
  };

  /** Procedure literal: data rejects. */
  const procLiteral = (path: string, s: string, literal = true) => {
    if (credentialCheck(path, s)) return;
    for (const h of findData(s, ctx, { literal })) reject(path, h.kind, `${h.kind} in a procedure literal (concrete record data cannot be shared)`);
  };
  const procExpr = (path: string, source: string | undefined) => {
    if (source === undefined) return;
    const lits = exprLiterals(source);
    for (const s of lits.strings) procLiteral(path, s, lits.parsed);
    for (const n of lits.numbers) if (ctx.recordValues.includes(String(n))) reject(path, "record-value", "numeric literal equal to a record value");
  };
  const procTemplate = (path: string, t: string) => {
    let parts: { lit: string; expr?: string }[];
    try {
      parts = parseTemplate(t);
    } catch {
      procLiteral(path, t, false);
      return;
    }
    const lits = parts.map((p) => p.lit).join("\u0000");
    if (credentialCheck(path, lits)) return;
    for (const h of findData(lits.replace(/\u0000/g, " "), ctx)) reject(path, h.kind, `${h.kind} in a url/resource template (use an expression such as {$rec.field})`);
    // Literal query values must be enumeration-like tokens; anything else is data.
    const q = lits.indexOf("?");
    if (q >= 0) {
      for (const pair of lits.slice(q + 1).split(/[&\u0000]/)) {
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const v = decodeURIComponentSafe(pair.slice(eq + 1));
        if (v && !SAFE_QUERY_VALUE.test(v)) reject(path, "query-value", "literal query-string value that is not an enumeration token");
      }
    }
    for (const p of parts) if (p.expr !== undefined) procExpr(path, p.expr);
  };
  const identifier = (path: string, s: string) => procLiteral(path, s, false);
  const scrubField = (path: string, s: string, kind: FindingKind = "free-text"): string => {
    if (credentialCheck(path, s)) return s;
    const r = scrubText(s, ctx);
    if (r.count) redact(path, kind === "free-text" ? "free-text" : kind, "data-like text replaced with placeholders", r.count);
    return r.text;
  };

  // ---- procedure
  const plan = cap.procedure.plan;
  plan.strategy.name = scrubField("procedure.plan.strategy.name", plan.strategy.name);
  plan.strategy.summary = scrubField("procedure.plan.strategy.summary", plan.strategy.summary);
  plan.strategy.rationale = scrubField("procedure.plan.strategy.rationale", plan.strategy.rationale);
  plan.outcomes.forEach((o, i) => {
    identifier(`procedure.plan.outcomes.${i}.id`, o.id);
    o.description = scrubField(`procedure.plan.outcomes.${i}.description`, o.description);
  });
  plan.assumptions = plan.assumptions.map((a, i) => scrubField(`procedure.plan.assumptions.${i}`, a));
  plan.risks = plan.risks.map((r, i) => scrubField(`procedure.plan.risks.${i}`, r));
  plan.phases.forEach((phase, pi) => {
    const pp = `procedure.plan.phases.${pi}`;
    identifier(`${pp}.id`, phase.id);
    procExpr(`${pp}.over`, phase.over);
    procExpr(`${pp}.key`, phase.key);
    phase.steps.forEach((s: DslStep, si) => {
      const sp = `${pp}.steps.${si}`;
      identifier(`${sp}.id`, s.id);
      if (s.note !== undefined) {
        if (s.note.trim()) redact(`${sp}.note`, "free-text", "free-text step note removed");
        delete s.note;
      }
      procExpr(`${sp}.when`, s.when);
      switch (s.op) {
        case "goto":
          identifier(`${sp}.app`, s.app);
          procTemplate(`${sp}.url`, s.url);
          break;
        case "fill":
        case "select":
          identifier(`${sp}.control`, s.control);
          procExpr(`${sp}.value`, s.value);
          break;
        case "click":
          identifier(`${sp}.control`, s.control);
          break;
        case "submit":
          identifier(`${sp}.control`, s.control);
          s.writes.forEach((w, i) => procTemplate(`${sp}.writes.${i}`, w));
          s.guards.forEach((g, i) => {
            identifier(`${sp}.guards.${i}.control`, g.control);
            procExpr(`${sp}.guards.${i}.equals`, g.equals);
          });
          procTemplate(`${sp}.verify.url`, s.verify.url);
          s.verify.fields.forEach((f, i) => {
            identifier(`${sp}.verify.fields.${i}.name`, f.name);
            identifier(`${sp}.verify.fields.${i}.control`, f.control);
            procExpr(`${sp}.verify.fields.${i}.equals`, f.equals);
          });
          break;
        case "extract":
          s.fields.forEach((f, i) => {
            identifier(`${sp}.fields.${i}.name`, f.name);
            identifier(`${sp}.fields.${i}.control`, f.control);
          });
          break;
        case "extractTable":
          identifier(`${sp}.table`, s.table);
          s.columns.forEach((c, i) => {
            identifier(`${sp}.columns.${i}.name`, c.name);
            identifier(`${sp}.columns.${i}.header`, c.header);
          });
          if (s.key) identifier(`${sp}.key`, s.key);
          if (s.paginateNext) identifier(`${sp}.paginateNext`, s.paginateNext);
          break;
        case "compute":
          s.assign.forEach((a, i) => {
            identifier(`${sp}.assign.${i}.name`, a.name);
            procExpr(`${sp}.assign.${i}.expr`, a.expr);
          });
          break;
        case "assert":
          procExpr(`${sp}.expr`, s.expr);
          s.message = scrubField(`${sp}.message`, s.message);
          break;
        case "waitFor":
          if (s.control) identifier(`${sp}.control`, s.control);
          if (s.text !== undefined) procLiteral(`${sp}.text`, s.text, false);
          break;
      }
    });
  });

  // ---- controls (descriptors: redact what we can)
  cap.controls = cap.controls.map((c, i) => sanitizeControl(c, `controls.${i}`));
  function sanitizeControl(c: PortableControl, p: string): PortableControl {
    identifier(`${p}.key`, c.key);
    identifier(`${p}.routeFamily`, c.routeFamily);
    if (!/^[a-z][a-z-]{0,39}$/.test(c.role)) reject(`${p}.role`, "format", "role is not an ARIA role token");
    if (c.type !== undefined && !/^[a-z][a-z0-9-]{0,29}$/.test(c.type)) reject(`${p}.type`, "format", "type is not an input type token");
    c.name = scrubField(`${p}.name`, c.name, "record-id");
    if (c.label !== undefined) c.label = scrubField(`${p}.label`, c.label, "record-id");
    if (c.tabPanel !== undefined) c.tabPanel = scrubField(`${p}.tabPanel`, c.tabPanel, "record-id");
    if (c.headers) c.headers = c.headers.map((h, j) => scrubField(`${p}.headers.${j}`, h, "record-id"));
    if (c.param !== undefined && (findCredentials(c.param).length || findData(c.param, ctx).length || !/^[A-Za-z_][A-Za-z0-9_.[\]-]{0,63}$/.test(c.param))) {
      redact(`${p}.param`, "record-id", "data-like form parameter name removed");
      delete c.param;
    }
    if (c.options) {
      const bad = c.options.length > 100 || c.options.some((o) => findCredentials(`${o.value} ${o.label}`).length || findData(o.value, ctx).length || findData(o.label, ctx, { literal: true }).length);
      if (bad) {
        redact(`${p}.options`, "enumeration", "options are not a closed enumeration (data-like values); removed");
        delete c.options;
      }
    }
    const kept: LocatorStrategy[] = [];
    c.strategies.forEach((s, j) => {
      const sp = `${p}.strategies.${j}`;
      const text = s.kind === "role" ? (s.name ?? "") : s.kind === "label" || s.kind === "placeholder" || s.kind === "text" ? s.text : s.kind === "testId" ? s.id : s.selector;
      if (findCredentials(text).length) {
        credentialCheck(sp, text);
        return;
      }
      if (s.kind === "css" && !isLabelAnchoredXpath(s)) {
        redact(sp, "positional-locator", "positional css/xpath strategy removed");
        return;
      }
      if (findData(text, ctx).length) {
        redact(sp, "record-id", "strategy text contains data; removed");
        return;
      }
      kept.push(s);
    });
    c.strategies = kept.length ? kept : [{ kind: "role", role: c.role }];
    return c;
  }

  // ---- pages
  cap.pages.forEach((pg, i) => {
    const p = `pages.${i}`;
    identifier(`${p}.routeFamily`, pg.routeFamily);
    if (/[?#]/.test(pg.pathTemplate)) {
      redact(`${p}.pathTemplate`, "query-value", "query string removed from path template");
      pg.pathTemplate = pg.pathTemplate.split(/[?#]/)[0] ?? "/";
    }
    for (const seg of pg.pathTemplate.split("/")) {
      if (!seg || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(seg)) continue;
      if (/\d/.test(seg) || findData(seg, ctx).length || findCredentials(seg).length) reject(`${p}.pathTemplate`, "record-id", "path template contains a concrete id segment (use a named {param})");
    }
    for (const k of Object.keys(pg.regionFingerprints)) if (!/^(?:(?:form|table):[0-9a-f]{16}(?:#\d+)?|facts|actions)$/.test(k)) reject(`${p}.regionFingerprints`, "format", "unexpected region key");
  });

  // ---- applications, intent, requirements, verification
  cap.applications.forEach((a, i) => {
    identifier(`applications.${i}.name`, a.name);
    a.routeFamilies.forEach((r, j) => identifier(`applications.${i}.routeFamilies.${j}`, r));
    for (const f of ["roleClass", "locale", "featureVariant"] as const) {
      const v = a[f];
      if (v !== undefined && !/^[A-Za-z0-9_.:-]{1,40}$/.test(v)) reject(`applications.${i}.${f}`, "format", `${f} must be a short token`);
    }
  });
  cap.intent.description = scrubField("intent.description", cap.intent.description);
  cap.intent.inputSchema.recordFields.forEach((f, i) => identifier(`intent.inputSchema.recordFields.${i}`, f));
  cap.requirements.permissions.forEach((x, i) => identifier(`requirements.permissions.${i}`, x));
  cap.requirements.expectedEffects.forEach((e, i) => {
    procTemplate(`requirements.expectedEffects.${i}.resource`, e.resource);
    identifier(`requirements.expectedEffects.${i}.stepId`, e.stepId);
  });
  cap.verification.rules.forEach((r, i) => {
    identifier(`verification.rules.${i}.stepId`, r.stepId);
    procTemplate(`verification.rules.${i}.url`, r.url);
    r.fields.forEach((f, j) => {
      identifier(`verification.rules.${i}.fields.${j}.name`, f.name);
      identifier(`verification.rules.${i}.fields.${j}.control`, f.control);
      procExpr(`verification.rules.${i}.fields.${j}.equals`, f.equals);
    });
  });

  // ---- hash-valued fields: format only
  const hex = (path: string, v: string | undefined, lens: number[]) => {
    if (v === undefined) return;
    if (!/^[0-9a-f]+$/.test(v) || !lens.includes(v.length)) reject(path, "format", `expected a ${lens.join("/")}-hex hash`);
  };
  hex("provenance.artifactHash", cap.provenance.artifactHash || undefined, [64]);
  hex("intent.canonicalOperation", cap.intent.canonicalOperation, [64]);
  cap.applications.forEach((a, i) => hex(`applications.${i}.interfaceFingerprint`, a.interfaceFingerprint, [16]));
  cap.pages.forEach((pg, i) => {
    hex(`pages.${i}.pageFingerprint`, pg.pageFingerprint, [12]);
    for (const [k, v] of Object.entries(pg.regionFingerprints)) hex(`pages.${i}.regionFingerprints.${k}`, v, [12]);
  });
  cap.controls.forEach((c, i) => {
    hex(`controls.${i}.formSignature`, c.formSignature, [16]);
    hex(`controls.${i}.regionFingerprint`, c.regionFingerprint, [12]);
  });
  for (const [path, v] of [
    ["capabilityId", cap.capabilityId],
    ["publisherId", cap.publisherId],
    ["provenance.validationEvidenceId", cap.provenance.validationEvidenceId],
  ] as const) {
    if (v !== undefined && !/^[A-Za-z0-9_.:-]{1,130}$/.test(v)) reject(path, "format", "identifier has an unexpected format");
  }

  // ---- defense in depth: nothing credential-like may remain anywhere
  walkStrings(cap, "", (path, s) => {
    if (isHashPath(path)) return;
    if (findings.some((f) => f.path === path && f.kind === "credential")) return;
    credentialCheck(path, s);
  });

  const rejected = findings.filter((f) => f.action === "rejected").map((f) => `${f.path}: ${f.detail}`);
  const out = redactions > 0 ? withArtifactHash(cap) : cap;
  return { ok: rejected.length === 0, capability: out, redactions, findings, rejected };
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

function walkStrings(v: unknown, path: string, fn: (path: string, s: string) => void): void {
  if (typeof v === "string") fn(path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, path ? `${path}.${i}` : String(i), fn));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkStrings(x, path ? `${path}.${k}` : k, fn);
}

export class CapabilityRejectedError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Capability rejected by the sanitizer: ${reasons.slice(0, 5).join("; ")}${reasons.length > 5 ? ` (+${reasons.length - 5} more)` : ""}`);
    this.name = "CapabilityRejectedError";
  }
}
