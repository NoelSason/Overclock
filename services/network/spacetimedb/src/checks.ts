/**
 * Cheap structural checks run inside reducers. Deep validation (rebinding, execution in a
 * sandbox) happens in the validation worker; these checks only make sure nothing obviously unsafe
 * or malformed is ever stored or broadcast.
 *
 * Constants mirror packages/network-contracts (the module cannot import workspace packages).
 */

import { SenderError } from "spacetimedb/server";

/** Mirrors MAX_CAPABILITY_BYTES in @overclock/network-contracts. */
export const MAX_CAPABILITY_BYTES = 256 * 1024;
/** Mirrors CAPABILITY_SCHEMA_VERSION in @overclock/network-contracts. */
export const CAPABILITY_SCHEMA_VERSION = "1";

export const PUBLICATION_STATES = ["PROPOSED", "VALIDATING", "VERIFIED", "CANARY", "ACTIVE", "QUARANTINED", "REVOKED"] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const PUBLISHER_ROLES = ["publisher", "validator", "repairer", "admin"] as const;
export type PublisherRole = (typeof PUBLISHER_ROLES)[number];

export const FAILURE_CATEGORIES = [
  "control-missing",
  "control-ambiguous",
  "dialog",
  "hidden-control",
  "fingerprint-drift",
  "verification-mismatch",
  "precondition",
  "other",
] as const;

/**
 * Publication state machine (see publication.ts in network-contracts):
 *   PROPOSED -> VALIDATING -> VERIFIED -> CANARY -> ACTIVE
 *   any non-terminal -> QUARANTINED -> VERIFIED (after re-validation) | REVOKED
 * REVOKED is terminal. Every non-terminal state may also be revoked by an admin.
 */
const TRANSITIONS: Record<PublicationState, readonly PublicationState[]> = {
  PROPOSED: ["VALIDATING", "QUARANTINED", "REVOKED"],
  VALIDATING: ["VERIFIED", "QUARANTINED", "REVOKED"],
  VERIFIED: ["CANARY", "QUARANTINED", "REVOKED"],
  CANARY: ["ACTIVE", "QUARANTINED", "REVOKED"],
  ACTIVE: ["QUARANTINED", "REVOKED"],
  QUARANTINED: ["VERIFIED", "REVOKED"],
  REVOKED: [],
};

export function isPublicationState(s: string): s is PublicationState {
  return (PUBLICATION_STATES as readonly string[]).includes(s);
}

export function canTransition(from: string, to: PublicationState): boolean {
  if (!isPublicationState(from)) return false;
  return TRANSITIONS[from].includes(to);
}

export function isRole(s: string): s is PublisherRole {
  return (PUBLISHER_ROLES as readonly string[]).includes(s);
}

// ---------------------------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------------------------

const ORIGIN_RE = /^(https?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::(\d{1,5}))?$/;

/** Normalize to scheme://host[:port] (lowercase, default ports dropped). Returns null if invalid. */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/\/+$/, "");
  const m = ORIGIN_RE.exec(s);
  if (!m) return null;
  const scheme = m[1]!;
  const host = m[2]!;
  const port = m[3];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
    if ((scheme === "http" && n === 80) || (scheme === "https" && n === 443)) return `${scheme}://${host}`;
    return `${scheme}://${host}:${n}`;
  }
  return `${scheme}://${host}`;
}

export function hostOf(origin: string): string {
  const rest = origin.slice(origin.indexOf("://") + 3);
  if (rest.startsWith("[")) return rest.slice(0, rest.indexOf("]") + 1);
  const colon = rest.indexOf(":");
  return colon === -1 ? rest : rest.slice(0, colon);
}

/** Extract the origin of an absolute URL-ish string, or null if it is not absolute. */
function absoluteOrigin(url: string): { scheme: string; origin: string | null } | null {
  const m = /^\s*([a-z][a-z0-9+.-]*):(\/\/)?([^/?#\s]*)/i.exec(url);
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  if (m[2] === undefined) return { scheme, origin: null };
  const authority = m[3]!.replace(/^[^@]*@/, "");
  return { scheme, origin: normalizeOrigin(`${scheme}://${authority}`) };
}

// ---------------------------------------------------------------------------------------------
// Secrets and text sanitization
// ---------------------------------------------------------------------------------------------

/** Obvious credential shapes. Matching any of these in a payload rejects it outright. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bsk-[a-z0-9_-]{12,}/i,
  /\b(?:password|passwd|pwd)\s*=(?!=)/i,
  /\b(?:set-)?cookie\s*[:=]\s*[^\s;"]+=/i,
  /\b(?:session(?:id)?|sessid|sid|csrf(?:token)?|xsrf-token)\s*=\s*[a-z0-9%._~+/-]{8,}/i,
  /\bauthorization\s*:\s*\S+/i,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s"]{6,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{6,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function findSecret(s: string): string | null {
  for (const re of SECRET_PATTERNS) {
    if (re.test(s)) return re.source.slice(0, 40);
  }
  return null;
}

/**
 * Sanitize free text for rows other clients can read (activity feed, reasons, details):
 * strip control characters, redact credential shapes, emails and long digit runs, reduce URLs to
 * their host, collapse whitespace, cap the length.
 */
export function sanitizeText(raw: string, max = 200): string {
  let s = raw.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const re of SECRET_PATTERNS) s = s.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]");
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>]+)[^\s"'<>]*/gi, (_m, host: string) => host.replace(/^[^@]*@/, ""));
  s = s.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[email]");
  s = s.replace(/\d{6,}/g, "[number]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Short machine token (environment, category, route family keys). */
export function requireToken(name: string, raw: string, max = 64): string {
  const s = raw.trim();
  if (s.length === 0 || s.length > max) throw new SenderError(`${name} must be 1-${max} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(s)) throw new SenderError(`${name} contains invalid characters`);
  return s;
}

export function requireId(name: string, raw: string, max = 128): string {
  if (raw.length === 0 || raw.length > max) throw new SenderError(`${name} must be 1-${max} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)) throw new SenderError(`${name} contains invalid characters`);
  return raw;
}

export function requireDigest(raw: string): string {
  if (!/^(?:[a-z0-9-]{1,16}:)?[A-Za-z0-9+/=_-]{16,128}$/.test(raw)) {
    throw new SenderError("evidenceDigest must be a digest (hex/base64, 16-128 chars), not raw evidence");
  }
  return raw;
}

export function requireRouteFamily(raw: string): string {
  if (raw.length === 0 || raw.length > 128 || !/^\/[A-Za-z0-9_:\-./{}*]*$/.test(raw)) {
    throw new SenderError("route families must be path patterns like /orders/:id (max 128 chars)");
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------
// Payload structural checks
// ---------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isObj(v: unknown): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new SenderError(`payload.${path} must be a string`);
  return v;
}

function arr(v: unknown, path: string): Json[] {
  if (!Array.isArray(v)) throw new SenderError(`payload.${path} must be an array`);
  return v as Json[];
}

function obj(v: unknown, path: string): Record<string, Json> {
  if (!isObj(v)) throw new SenderError(`payload.${path} must be an object`);
  return v;
}

export interface PayloadSummary {
  capabilityId: string;
  version: number;
  schemaVersion: string;
  compilerVersion: string;
  publisherId: string;
  canonicalOperation: string;
  description: string;
  applications: Array<{ name: string; origin: string; routeFamilies: string[]; interfaceFingerprint: string; roleClass: string; locale: string; featureVariant: string }>;
  allowedOrigins: string[];
  permissions: string[];
  interfaceFingerprints: string[];
  parentVersion: number;
}

/**
 * Parse and structurally check a PortableCapability payload. Throws SenderError on the first
 * problem. `isRegistered` reports whether a normalized origin has a registered application.
 */
export function checkPayload(payload: string, isRegistered: (origin: string) => boolean): PayloadSummary {
  let root: Json;
  try {
    root = JSON.parse(payload) as Json;
  } catch {
    throw new SenderError("payload is not valid JSON");
  }
  const c = obj(root, "(root)");
  if (c["schemaVersion"] !== CAPABILITY_SCHEMA_VERSION) throw new SenderError(`payload.schemaVersion must be "${CAPABILITY_SCHEMA_VERSION}"`);
  const capabilityId = requireId("capabilityId", str(c["capabilityId"], "capabilityId"));
  const version = c["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 0xffffffff) {
    throw new SenderError("payload.version must be a positive integer");
  }
  const publisherId = str(c["publisherId"], "publisherId");

  const apps = arr(c["applications"], "applications");
  if (apps.length === 0 || apps.length > 16) throw new SenderError("payload.applications must have 1-16 entries");
  const applications: PayloadSummary["applications"] = [];
  for (const [i, raw] of apps.entries()) {
    const a = obj(raw, `applications[${i}]`);
    const origin = str(a["origin"], `applications[${i}].origin`);
    const norm = normalizeOrigin(origin);
    if (norm === null || norm !== origin) throw new SenderError(`payload.applications[${i}].origin must be a normalized origin (scheme://host[:port])`);
    if (!isRegistered(norm)) throw new SenderError(`application origin ${norm} is not registered`);
    const routeFamilies = arr(a["routeFamilies"], `applications[${i}].routeFamilies`).map((r, j) => str(r, `applications[${i}].routeFamilies[${j}]`));
    const optional = (k: string) => (a[k] === undefined ? "" : str(a[k], `applications[${i}].${k}`));
    applications.push({
      name: str(a["name"], `applications[${i}].name`),
      origin: norm,
      routeFamilies,
      interfaceFingerprint: str(a["interfaceFingerprint"], `applications[${i}].interfaceFingerprint`),
      roleClass: optional("roleClass"),
      locale: optional("locale"),
      featureVariant: optional("featureVariant"),
    });
  }

  const intent = obj(c["intent"], "intent");
  const canonicalOperation = str(intent["canonicalOperation"], "intent.canonicalOperation");
  if (canonicalOperation.length === 0 || canonicalOperation.length > 256) throw new SenderError("intent.canonicalOperation must be 1-256 characters");
  const description = str(intent["description"], "intent.description");

  const procedure = obj(c["procedure"], "procedure");
  if (procedure["format"] !== "overclock-procedure-dsl") throw new SenderError('payload.procedure.format must be "overclock-procedure-dsl"');
  const compilerVersion = str(procedure["compilerVersion"], "procedure.compilerVersion");
  const plan = obj(procedure["plan"], "procedure.plan");

  const requirements = obj(c["requirements"], "requirements");
  const permissions = arr(requirements["permissions"], "requirements.permissions").map((p, i) => str(p, `requirements.permissions[${i}]`));
  const allowedOrigins: string[] = [];
  for (const [i, o] of arr(requirements["allowedOrigins"], "requirements.allowedOrigins").entries()) {
    const s = str(o, `requirements.allowedOrigins[${i}]`);
    const norm = normalizeOrigin(s);
    if (norm === null || norm !== s) throw new SenderError(`requirements.allowedOrigins[${i}] must be a normalized origin`);
    if (!isRegistered(norm)) throw new SenderError(`allowed origin ${norm} is not registered`);
    allowedOrigins.push(norm);
  }
  const allowed = new Set<string>([...allowedOrigins, ...applications.map((a) => a.origin)]);

  // Templates (navigation and verification URLs, page paths) must stay on allowed origins.
  const checkTemplate = (t: string, where: string) => {
    if (t.startsWith("/") && !t.startsWith("//")) return;
    const abs = absoluteOrigin(t);
    if (abs !== null && abs.origin !== null && allowed.has(abs.origin)) {
      const rest = t.trim().slice(abs.origin.length);
      if (rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#")) return;
    }
    throw new SenderError(`${where} must be a path ("/...") or an absolute URL on an allowed origin`);
  };
  for (const [pi, phaseRaw] of arr(plan["phases"], "procedure.plan.phases").entries()) {
    const phase = obj(phaseRaw, `procedure.plan.phases[${pi}]`);
    for (const [si, stepRaw] of arr(phase["steps"], `procedure.plan.phases[${pi}].steps`).entries()) {
      const step = obj(stepRaw, `procedure.plan.phases[${pi}].steps[${si}]`);
      if (step["op"] === "goto") checkTemplate(str(step["url"], `phases[${pi}].steps[${si}].url`), `goto step ${pi}.${si} url`);
      if (step["op"] === "submit" && isObj(step["verify"])) checkTemplate(str(step["verify"]["url"], `phases[${pi}].steps[${si}].verify.url`), `submit step ${pi}.${si} verify.url`);
    }
  }
  const verification = obj(c["verification"], "verification");
  for (const [i, ruleRaw] of arr(verification["rules"], "verification.rules").entries()) {
    const rule = obj(ruleRaw, `verification.rules[${i}]`);
    checkTemplate(str(rule["url"], `verification.rules[${i}].url`), `verification rule ${i} url`);
  }
  const fps = new Set<string>(applications.map((a) => a.interfaceFingerprint));
  for (const [i, pageRaw] of arr(c["pages"], "pages").entries()) {
    const page = obj(pageRaw, `pages[${i}]`);
    checkTemplate(str(page["pathTemplate"], `pages[${i}].pathTemplate`), `page ${i} pathTemplate`);
    fps.add(str(page["pageFingerprint"], `pages[${i}].pageFingerprint`));
    const regions = obj(page["regionFingerprints"], `pages[${i}].regionFingerprints`);
    for (const v of Object.values(regions)) if (typeof v === "string") fps.add(v);
  }
  arr(c["controls"], "controls");

  const provenance = obj(c["provenance"], "provenance");
  const pv = provenance["parentVersion"];
  let parentVersion = 0;
  if (pv !== undefined) {
    if (typeof pv !== "number" || !Number.isInteger(pv) || pv < 1 || pv >= version) throw new SenderError("provenance.parentVersion must be a positive integer below version");
    parentVersion = pv;
  }

  // Every string anywhere in the artifact: no script URLs, no absolute URLs to other origins, no
  // credential shapes. Walking parsed strings (not the raw text) defeats JSON escape tricks.
  let budget = 100_000;
  const stack: Json[] = [root];
  while (stack.length > 0) {
    if (--budget < 0) throw new SenderError("payload is too deeply structured");
    const v = stack.pop()!;
    if (typeof v === "string") {
      checkString(v, allowed);
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        checkString(k, allowed);
        stack.push(x);
      }
    }
  }

  const interfaceFingerprints = [...fps].filter((f) => f.length > 0 && f.length <= 128).slice(0, 256);
  return {
    capabilityId,
    version,
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    compilerVersion: compilerVersion.slice(0, 64),
    publisherId,
    canonicalOperation,
    description,
    applications,
    allowedOrigins,
    permissions: permissions.slice(0, 64),
    interfaceFingerprints,
    parentVersion,
  };
}

const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'<>\\/?#]+)/gi;

function checkString(s: string, allowed: ReadonlySet<string>): void {
  if (/(?:java|vb)script\s*:/i.test(s) || /\bdata\s*:\s*text\/html/i.test(s)) {
    throw new SenderError("payload contains a script URL");
  }
  const secret = findSecret(s);
  if (secret !== null) throw new SenderError("payload contains what looks like a credential or secret");
  URL_IN_TEXT.lastIndex = 0;
  for (let m = URL_IN_TEXT.exec(s); m !== null; m = URL_IN_TEXT.exec(s)) {
    const origin = normalizeOrigin(`${m[1]!.toLowerCase()}://${m[2]!.replace(/^[^@]*@/, "")}`);
    if (origin === null || !allowed.has(origin)) {
      throw new SenderError(`payload references an absolute URL outside the allowed origins (${sanitizeText(m[2]!, 64)})`);
    }
  }
}
