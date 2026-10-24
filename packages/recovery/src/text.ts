/**
 * Deterministic text similarity for matching renamed controls: token overlap over a small
 * synonym-canonicalized vocabulary, plus normalized edit distance on the whole string.
 */

const STOPWORDS = new Set(["the", "a", "an", "of", "to", "for", "on", "in", "and", "or", "this", "that", "your", "my", "is", "be", "with", "by", "at", "as"]);

/** Common UI vocabulary that apps rename between. Values are canonical tokens. */
const SYNONYMS: Record<string, string> = {
  save: "save",
  update: "save",
  apply: "save",
  commit: "save",
  submit: "save",
  store: "save",
  status: "status",
  state: "status",
  stage: "status",
  owner: "owner",
  assignee: "owner",
  assigned: "owner",
  note: "note",
  notes: "note",
  comment: "note",
  comments: "note",
  remark: "note",
  change: "change",
  changes: "change",
  edit: "change",
  edits: "change",
  modify: "change",
  delete: "delete",
  remove: "delete",
  dismiss: "close",
  close: "close",
  confirm: "confirm",
  proceed: "confirm",
  continue: "confirm",
  email: "email",
  mail: "email",
  phone: "phone",
  telephone: "phone",
  category: "category",
  type: "category",
  priority: "priority",
  urgency: "priority",
};

export function normalize(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'&×✕]+/g, " ")
    .trim();
}

export function tokens(s: string | undefined | null): string[] {
  const out: string[] = [];
  for (const raw of normalize(s).split(" ")) {
    if (!raw || STOPWORDS.has(raw)) continue;
    const syn = SYNONYMS[raw];
    if (syn) {
      out.push(syn);
      continue;
    }
    out.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

export function editSim(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export function jaccard<T>(a: readonly T[], b: readonly T[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Similarity of two control names in [0, 1]. */
export function nameSim(a: string, b: string): number {
  if (!normalize(a) || !normalize(b)) return 0;
  if (normalize(a) === normalize(b)) return 1;
  return 0.7 * jaccard(tokens(a), tokens(b)) + 0.3 * editSim(a, b);
}

export function bestNameSim(as: readonly string[], bs: readonly (string | undefined)[]): number {
  let best = 0;
  for (const a of as) for (const b of bs) if (b) best = Math.max(best, nameSim(a, b));
  return best;
}

export function eqi(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Actions that cannot be undone. Recovery never confirms, guesses, or vision-locates these. */
export const IRREVERSIBLE = /\b(delete|remove|destroy|erase|purge|wipe|refund|pay|purchase|buy|charge|send|publish|transfer|deactivate|discard|close account|cancel order|cancel subscription)\b/i;
