/**
 * Minimal, strict HTML templating. Every interpolated value is escaped unless it is a
 * `SafeHtml` produced by `html` (or by `raw`, which is reserved for constant CSS/JS written in
 * this codebase). Ticket bodies and notes are untrusted text, so nothing reaches the page
 * without passing through `escapeHtml`.
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);
}

function render(v: Interpolation): string {
  if (v === null || v === undefined || v === false || v === true) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map((x: Interpolation) => render(x)).join("");
  return escapeHtml(v);
}

/** Tagged template: `html\`<td>${value}</td>\`` escapes `value`; nested `html` fragments pass through. */
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new SafeHtml(out);
}

/** Trusted constant markup (inline CSS and JS authored here). Never pass request or DB data. */
export function raw(trusted: string): SafeHtml {
  return new SafeHtml(trusted);
}

export function join(parts: readonly SafeHtml[], sep = ""): SafeHtml {
  return new SafeHtml(parts.map((p) => p.value).join(sep));
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
const dayTime = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function formatMoney(n: number): string {
  return money.format(n);
}

function parseDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `<time>` element with a short date (e.g. "Sep 12, 2026"). */
export function dateEl(iso: string): SafeHtml {
  const d = parseDate(iso);
  return d ? html`<time datetime="${iso}">${day.format(d)}</time>` : html`${iso}`;
}

/** `<time>` element with date and UTC time (e.g. "Sep 12, 2026, 14:05 UTC"). */
export function dateTimeEl(iso: string): SafeHtml {
  const d = parseDate(iso);
  return d ? html`<time datetime="${iso}">${dayTime.format(d)} UTC</time>` : html`${iso}`;
}
