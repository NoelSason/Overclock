import { z } from "zod";

/**
 * In-browser tasks ("Ask" in the Chrome extension). The extension carries out one action at a
 * time in a tab in the user's own browser, where they're already signed in; the engine, which
 * holds the model key, chooses each next action from what the tab shows. Both sides share these
 * shapes, and the extension uses `approvalFor` to decide which clicks the user approves first.
 */

export const AGENT_ACTIONS = ["navigate", "click", "type", "press", "scroll", "wait", "read", "ask", "done", "gmail_recent", "gmail_read", "doc_create"] as const;
export type AgentActionType = (typeof AGENT_ACTIONS)[number];

/** Actions the engine carries out itself through the user's connected Google account, not in a tab. */
export const ENGINE_ACTIONS: ReadonlySet<AgentActionType> = new Set(["gmail_recent", "gmail_read", "doc_create"]);

export const AGENT_KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

/** One model decision. Flat object, no maps or recursion (structured-output friendly). */
export const AgentStep = z.object({
  say: z.string().describe('A few words for the user about what you are doing now, e.g. "Opening your inbox".'),
  action: z.enum(AGENT_ACTIONS),
  url: z.string().optional().describe("navigate: the full https URL."),
  ref: z.string().optional().describe('click, type, read: an element id from the page, e.g. "e12". type without ref types at the cursor; read without ref reads the whole page.'),
  text: z.string().optional().describe("type: the text; newlines start new lines or paragraphs. doc_create: the document's content. ask: your question or request for the user. done: your final answer for the user."),
  title: z.string().optional().describe("doc_create: the document's title."),
  count: z.number().optional().describe("gmail_recent: how many of the newest messages, 1 to 25."),
  query: z.string().optional().describe('gmail_recent: optional Gmail search, e.g. "is:unread" or "from:alex". Default: the inbox.'),
  messageId: z.string().optional().describe("gmail_read: a message id from gmail_recent."),
  key: z.enum(AGENT_KEYS).optional().describe("press: the key."),
  direction: z.enum(["down", "up"]).optional().describe("scroll: which way."),
  seconds: z.number().optional().describe("wait: 1 to 10."),
  notes: z.string().optional().describe("Facts you will need later in this task, appended to your notes (your only memory of pages you leave). Omit otherwise."),
});
export type AgentStep = z.infer<typeof AgentStep>;

export const AgentElement = z.object({
  ref: z.string().max(12),
  role: z.string().max(40),
  name: z.string().max(300),
  value: z.string().max(300).optional(),
  href: z.string().max(500).optional(),
  /** Comma-separated: checked, selected, expanded, disabled, offscreen. */
  state: z.string().max(80).optional(),
});
export type AgentElement = z.infer<typeof AgentElement>;

/** What the tab shows after an action. */
export const AgentObservation = z.object({
  url: z.string().max(4000),
  title: z.string().max(500),
  /** The page's visible text, cut to a budget. */
  text: z.string().max(40_000),
  elements: z.array(AgentElement).max(500),
  scroll: z.object({ y: z.number(), height: z.number(), viewport: z.number() }).optional(),
});
export type AgentObservation = z.infer<typeof AgentObservation>;

export const AgentStepRequest = z.object({
  /** null before the task has opened a page. */
  observation: AgentObservation.nullable(),
  /** What happened when the extension carried out the previous action. */
  result: z.string().max(4000).optional(),
  /** Text the previous `read` action returned. */
  read: z.string().max(60_000).optional(),
  /** The user's answer to an `ask`. */
  reply: z.string().max(4000).optional(),
});
export type AgentStepRequest = z.infer<typeof AgentStepRequest>;

/** Something the task produced for the user, checked by reading it back. */
export interface AgentArtifact {
  kind: "google-doc";
  title: string;
  url: string;
  /** true when a fresh read of the document found every line that was written. */
  verified: boolean;
  detail: string;
}

export interface AgentStepResponse {
  step: number;
  decision: AgentStep;
  /** Set when the engine already carried out the decision (an ENGINE_ACTIONS action): what happened. The extension does nothing in the tab and asks for the next step. */
  engineResult?: string;
  artifacts: AgentArtifact[];
  /** Model spend for this task so far. */
  costUsd: number;
  /** true when the engine ended the task (done, step limit, or budget). */
  finished: boolean;
}

export interface AgentTaskInfo {
  taskId: string;
  model: string;
  maxSteps: number;
  budgetUsd: number;
  /** The Google account the engine's Gmail and Docs actions use, or null when none is connected. */
  google: string | null;
}

/** Second-level labels under country-code domains that act like a TLD (example.co.uk). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or", "go"]);

/**
 * The site an address belongs to: the host's last two labels
 * (three under a country-code second level such as co.uk), so mail.google.com and
 * docs.google.com are both google.com. IP addresses and localhost are their own site. Only
 * http(s) addresses have one.
 */
export function siteOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.startsWith("[")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const tld = parts[parts.length - 1]!;
  const sld = parts[parts.length - 2]!;
  return parts.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join(".");
}

/** Words that mean a click can send, delete, share, pay, or publish something. */
const RISKY_WORDS = /\b(send|delete|trash|remove|discard|share|pay|buy|purchase|order|checkout|check out|publish|post|submit|transfer|unsubscribe|archive|spam|block|forward|confirm|accept|sign out|log out)\b/i;
const CLICKABLE_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "tab", "checkbox", "switch", "radio"]);

/**
 * Whether a click target looks like it sends, deletes, shares, pays, or publishes. Only short
 * names of buttons and similar controls count: an email row whose subject says "order" isn't a
 * risky click, but a button named "Send" or "Move to trash" is.
 */
export function riskyElement(el: Pick<AgentElement, "role" | "name">): boolean {
  return CLICKABLE_ROLES.has(el.role) && el.name.length <= 48 && RISKY_WORDS.test(el.name);
}

export type AgentApproval = { kind: "action"; text: string } | { kind: "blocked"; text: string };

/**
 * What the user must approve before the extension carries out a decision, or why it can't: any
 * click that looks like it sends, deletes, shares, pays, or publishes needs a yes, every time.
 * Any web page may be opened without asking; addresses other than http(s) are never opened.
 */
export function approvalFor(d: AgentStep, page: AgentObservation | null): AgentApproval | null {
  if (d.action === "navigate") {
    if (!(d.url && siteOf(d.url))) return { kind: "blocked", text: `Overclock only opens web pages (http or https), not ${JSON.stringify(d.url ?? "")}.` };
    return null;
  }
  if (d.action === "click" && page) {
    const el = page.elements.find((e) => e.ref === d.ref);
    if (el && riskyElement(el)) return { kind: "action", text: `Click “${el.name}” on ${siteOf(page.url) ?? "this page"}?` };
  }
  return null;
}

/**
 * Text reduced to letters and digits, lowercased: editors restyle what's typed (curly quotes,
 * dashes, list numbering, bullets, spacing), so a written line is compared by its words alone.
 */
const normText = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/** A line without a leading list marker ("1.", "-", "•"), which editors turn into list formatting. */
const withoutMarker = (l: string) => l.replace(/^\s*(?:[-*\u2022]|\d{1,3}[.)])\s+/, "");

/** Whether every written line appears in a document's text, in order, compared by words alone: how a written document is checked after a fresh read. */
export function containsLinesInOrder(docText: string, lines: string[]): { ok: boolean; missing: string[] } {
  const hay = normText(docText);
  let from = 0;
  const missing: string[] = [];
  for (const l of lines) {
    const needle = normText(withoutMarker(l));
    if (!needle) continue;
    const at = hay.indexOf(needle, from);
    if (at < 0) missing.push(l);
    else from = at + needle.length;
  }
  return { ok: missing.length === 0, missing };
}
