const SENSITIVE_KEY = /(password|passwd|secret|token|cookie|authorization|api[-_]?key|session|set-cookie|credential)/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const KEYLIKE = /\b(sk-[A-Za-z0-9_-]{12,}|ts_[A-Za-z0-9_-]{12,})\b/g;

/** Deep-redact values whose keys look sensitive, and token-like substrings in strings. */
export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return value.replace(BEARER, "$1 [REDACTED]").replace(KEYLIKE, "[REDACTED]") as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    return out as T;
  }
  return value;
}
