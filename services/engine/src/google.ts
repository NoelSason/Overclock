import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { containsLinesInOrder, type AgentArtifact } from "@overclock/contracts";

/**
 * The user's Google account for in-browser tasks: OAuth 2.0 for a desktop app (PKCE, with a
 * loopback redirect to this engine) and the two narrow scopes the Gmail → Docs task needs:
 *
 * - gmail.readonly: read messages. Overclock can't send, delete, or change email.
 * - drive.file: create documents, and reach only the files Overclock created.
 *
 * Tokens stay on the engine in `<dataDir>/google-account.json` (mode 0600). The extension starts
 * the sign-in and sees the account's address, never a token.
 */

export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive.file"] as const;
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DOCS = "https://docs.googleapis.com/v1/documents";
const PENDING_TTL_MS = 10 * 60_000;

interface Stored {
  email: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface GoogleStatus {
  /** A Google OAuth client is set on the engine (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET). */
  configured: boolean;
  email: string | null;
}

export class GoogleError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

export interface GmailMessage {
  id: string;
  from: string;
  to: string;
  date: string;
  subject: string;
  unread: boolean;
  snippet: string;
  body: string;
}

/** Decoded text of a message: its text/plain part, or its HTML part reduced to text. */
export function messageText(payload: GmailPayload | undefined): string {
  const parts: GmailPayload[] = [];
  const walk = (p: GmailPayload | undefined) => {
    if (!p) return;
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const decode = (p: GmailPayload) => (p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "");
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (!html) return "";
  return decode(html)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export interface GmailPayload {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string };
  parts?: GmailPayload[];
}

/**
 * Paragraph structure for a new document: "# " and "## " lines become headings, "- " and "* "
 * lines become bullets. Returns the text to insert and the ranges to style, in the Docs API's
 * UTF-16 indexes (the body starts at index 1).
 */
export function docLayout(text: string): { text: string; headings: { start: number; end: number; level: 1 | 2 }[]; bullets: { start: number; end: number }[]; lines: string[] } {
  const out: string[] = [];
  const headings: { start: number; end: number; level: 1 | 2 }[] = [];
  const bullets: { start: number; end: number }[] = [];
  let index = 1;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw.trimEnd();
    let kind: "h1" | "h2" | "bullet" | null = null;
    if (/^##\s+/.test(line)) [kind, line] = ["h2", line.replace(/^##\s+/, "")];
    else if (/^#\s+/.test(line)) [kind, line] = ["h1", line.replace(/^#\s+/, "")];
    else if (/^\s*[-*]\s+/.test(line)) [kind, line] = ["bullet", line.replace(/^\s*[-*]\s+/, "")];
    const start = index;
    const end = index + line.length + 1;
    if (line && kind === "h1") headings.push({ start, end, level: 1 });
    if (line && kind === "h2") headings.push({ start, end, level: 2 });
    if (line && kind === "bullet") bullets.push({ start, end });
    out.push(line);
    index = end;
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return { text: `${out.join("\n")}\n`, headings, bullets, lines: out.filter((l) => l.trim()) };
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export class GoogleAccount {
  private pending = new Map<string, { verifier: string; expiresAt: number }>();
  private stored: Stored | null = null;
  private readonly fetch: Fetch;

  constructor(
    private readonly o: {
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      file: string;
      redirectUri: () => string;
      fetch?: Fetch;
      now?: () => number;
    },
  ) {
    this.fetch = o.fetch ?? ((input, init) => fetch(input, init));
    if (existsSync(o.file)) {
      try {
        this.stored = JSON.parse(readFileSync(o.file, "utf8")) as Stored;
      } catch {
        this.stored = null;
      }
    }
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  configured(): boolean {
    return !!(this.o.clientId && this.o.clientSecret);
  }

  status(): GoogleStatus {
    return { configured: this.configured(), email: this.configured() ? (this.stored?.email ?? null) : null };
  }

  /** The address the user opens to sign in and grant the two scopes. */
  beginConnect(): string {
    if (!this.configured()) throw new GoogleError(409, "Google isn't set up on this engine yet: add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to its .env and restart it.");
    for (const [k, v] of this.pending) if (v.expiresAt < this.now()) this.pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, expiresAt: this.now() + PENDING_TTL_MS });
    const q = new URLSearchParams({
      client_id: this.o.clientId!,
      redirect_uri: this.o.redirectUri(),
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Handles Google's redirect: checks the state, trades the code for tokens, and stores them. */
  async finishConnect(q: { code?: string | undefined; state?: string | undefined; error?: string | undefined }): Promise<string> {
    const p = q.state ? this.pending.get(q.state) : undefined;
    if (!p || p.expiresAt < this.now()) throw new GoogleError(400, "This sign-in link expired or was already used. Start again from the side panel.");
    this.pending.delete(q.state!);
    if (q.error) throw new GoogleError(400, q.error === "access_denied" ? "You didn't grant access, so nothing was connected." : `Google returned an error: ${q.error}`);
    if (!q.code) throw new GoogleError(400, "Google didn't return a sign-in code.");
    const tok = await this.token({ grant_type: "authorization_code", code: q.code, redirect_uri: this.o.redirectUri(), code_verifier: p.verifier });
    const granted = (tok.scope ?? "").split(" ");
    const missing = GOOGLE_SCOPES.filter((s) => !granted.includes(s));
    if (missing.length) throw new GoogleError(400, `Overclock needs both permissions; this sign-in didn't grant ${missing.map((s) => s.split("/").pop()).join(" and ")}. Start again and keep both boxes checked.`);
    if (!tok.refresh_token) throw new GoogleError(400, "Google didn't return a refresh token. Start again from the side panel.");
    const profile = (await (await this.fetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${tok.access_token}` } })).json()) as { emailAddress?: string };
    this.stored = { email: profile.emailAddress ?? "your Google account", refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: this.now() + (tok.expires_in - 60) * 1000, scopes: granted };
    writeFileSync(this.o.file, JSON.stringify(this.stored), { mode: 0o600 });
    return this.stored.email;
  }

  async disconnect(): Promise<void> {
    const s = this.stored;
    this.stored = null;
    rmSync(this.o.file, { force: true });
    if (s) await this.fetch(`${REVOKE_URL}?token=${encodeURIComponent(s.refreshToken)}`, { method: "POST" }).catch(() => undefined);
  }

  private async token(body: Record<string, string>): Promise<{ access_token: string; expires_in: number; refresh_token?: string; scope?: string }> {
    const res = await this.fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...body, client_id: this.o.clientId!, client_secret: this.o.clientSecret! }) });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new GoogleError(502, `Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
    return { access_token: json.access_token, expires_in: json.expires_in ?? 3600, ...(json.refresh_token ? { refresh_token: json.refresh_token } : {}), ...(json.scope ? { scope: json.scope } : {}) };
  }

  private async accessToken(): Promise<string> {
    const s = this.stored;
    if (!s || !this.configured()) throw new GoogleError(409, "No Google account is connected.");
    if (s.expiresAt > this.now()) return s.accessToken;
    const tok = await this.token({ grant_type: "refresh_token", refresh_token: s.refreshToken });
    s.accessToken = tok.access_token;
    s.expiresAt = this.now() + (tok.expires_in - 60) * 1000;
    writeFileSync(this.o.file, JSON.stringify(s), { mode: 0o600 });
    return s.accessToken;
  }

  private async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(url, { ...init, headers: { authorization: `Bearer ${await this.accessToken()}`, ...(init.body ? { "content-type": "application/json" } : {}) } });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new GoogleError(res.status === 401 || res.status === 403 ? 409 : 502, `Google ${res.status}: ${err.error?.message ?? res.statusText}`);
    }
    return (await res.json()) as T;
  }

  /** The newest messages in the inbox (or matching a Gmail search), newest first. */
  async recentMessages(count: number, query?: string): Promise<GmailMessage[]> {
    const q = new URLSearchParams({ maxResults: String(Math.min(25, Math.max(1, Math.round(count)))) });
    if (query?.trim()) q.set("q", query.trim());
    else q.set("labelIds", "INBOX");
    const list = await this.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${q}`);
    return Promise.all((list.messages ?? []).map((m) => this.message(m.id)));
  }

  async message(id: string): Promise<GmailMessage> {
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) throw new GoogleError(400, `${JSON.stringify(id)} isn't a message id from gmail_recent.`);
    const m = await this.api<{ id: string; snippet?: string; labelIds?: string[]; payload?: GmailPayload }>(`${GMAIL}/messages/${id}?format=full`);
    const h = (name: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === name)?.value ?? "";
    return { id: m.id, from: h("from"), to: h("to"), date: h("date"), subject: h("subject"), unread: (m.labelIds ?? []).includes("UNREAD"), snippet: m.snippet ?? "", body: messageText(m.payload) };
  }

  /** Creates a Google Doc with this content, then reads it back to check every line is there. */
  async createDoc(title: string, content: string): Promise<AgentArtifact> {
    const layout = docLayout(content);
    if (!layout.lines.length) throw new GoogleError(400, "The document has no content.");
    const doc = await this.api<{ documentId: string }>(DOCS, { method: "POST", body: JSON.stringify({ title: title.trim().slice(0, 200) || "Untitled" }) });
    const requests: object[] = [{ insertText: { location: { index: 1 }, text: layout.text } }];
    for (const h of layout.headings) requests.push({ updateParagraphStyle: { range: { startIndex: h.start, endIndex: h.end }, paragraphStyle: { namedStyleType: h.level === 1 ? "HEADING_1" : "HEADING_2" }, fields: "namedStyleType" } });
    for (const b of layout.bullets) requests.push({ createParagraphBullets: { range: { startIndex: b.start, endIndex: b.end }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } });
    await this.api(`${DOCS}/${doc.documentId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
    const back = await this.api<{ title?: string; body?: { content?: { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] } }>(`${DOCS}/${doc.documentId}`);
    const docText = (back.body?.content ?? []).flatMap((c) => c.paragraph?.elements ?? []).map((e) => e.textRun?.content ?? "").join("");
    const check = containsLinesInOrder(docText, layout.lines);
    return {
      kind: "google-doc",
      title: back.title ?? title,
      url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
      verified: check.ok,
      detail: check.ok ? `Read the document back: all ${layout.lines.length} lines are there (${norm(docText).length} characters).` : `Read the document back: ${check.missing.length} of ${layout.lines.length} lines are missing, starting with ${JSON.stringify(check.missing[0]!.slice(0, 80))}.`,
    };
  }
}
