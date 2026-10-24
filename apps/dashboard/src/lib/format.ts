/** Display formatting. Every formatter renders "—" when there is no real value yet. */

export const DASH = "—";

type Num = number | null | undefined;

const valid = (n: Num): n is number => typeof n === "number" && Number.isFinite(n);

export function fmtInt(n: Num): string {
  return valid(n) ? Math.round(n).toLocaleString("en-US") : DASH;
}

export function fmtNum(n: Num, digits = 1): string {
  return valid(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : DASH;
}

/** Milliseconds as a compact duration: 840 ms, 4.2 s, 3m 07s, 1h 02m. */
export function fmtMs(ms: Num): string {
  if (!valid(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const totalS = Math.round(ms / 1000);
  if (totalS < 3600) return `${Math.floor(totalS / 60)}m ${String(totalS % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalS / 3600)}h ${String(Math.floor((totalS % 3600) / 60)).padStart(2, "0")}m`;
}

/** Clock-style elapsed time: 0:42, 12:05, 1:02:09. */
export function fmtClock(ms: Num): string {
  if (!valid(ms)) return DASH;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function fmtUsd(n: Num): string {
  if (!valid(n)) return DASH;
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  if (Math.abs(n) < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(ratio: Num, digits = 0): string {
  return valid(ratio) ? `${(ratio * 100).toFixed(digits)}%` : DASH;
}

export function fmtTokens(n: Num): string {
  if (!valid(n)) return DASH;
  if (n < 10_000) return fmtInt(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtDate(ts: Num): string {
  if (!valid(ts)) return DASH;
  return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function shortId(id: string | undefined, keep = 8): string {
  if (!id) return DASH;
  return id.length > keep + 1 ? `${id.slice(0, keep)}…` : id;
}
