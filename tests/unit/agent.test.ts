import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { approvalFor, containsLinesInOrder, riskyElement, siteOf, type AgentObservation, type AgentStep } from "@overclock/contracts";
import { BudgetExceededError, type ModelLedger } from "@overclock/models";
import { BrowserAgentService, describeDecision, renderAgentPrompt, type AgentModel } from "../../services/engine/src/agent";
import { docLayout, GOOGLE_SCOPES, GoogleAccount, messageText } from "../../services/engine/src/google";

const page = (elements: AgentObservation["elements"], url = "https://mail.google.com/mail/u/0/#inbox"): AgentObservation => ({ url, title: "Inbox", text: "", elements });

describe("agent: sites and approvals", () => {
  it("groups hosts by site and opens only web pages", () => {
    expect(siteOf("https://mail.google.com/mail/u/0/")).toBe("google.com");
    expect(siteOf("https://docs.google.com/document/create")).toBe("google.com");
    expect(siteOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(siteOf("http://127.0.0.1:4101/")).toBe("127.0.0.1");
    expect(siteOf("chrome://settings")).toBeNull();
    expect(siteOf("javascript:alert(1)")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
  });

  it("opens any web page without asking, and never opens other schemes", () => {
    const nav = (url: string): AgentStep => ({ say: "", action: "navigate", url });
    expect(approvalFor(nav("https://www.google.com/travel/flights"), null)).toBeNull();
    expect(approvalFor(nav("file:///etc/passwd"), null)?.kind).toBe("blocked");
    expect(approvalFor(nav("javascript:alert(1)"), null)?.kind).toBe("blocked");
  });

  it("asks before clicks that send, delete, share, or pay, but not before opening an email about an order", () => {
    expect(riskyElement({ role: "button", name: "Send" })).toBe(true);
    expect(riskyElement({ role: "button", name: "Move to trash" })).toBe(true);
    expect(riskyElement({ role: "menuitem", name: "Delete this message" })).toBe(true);
    expect(riskyElement({ role: "button", name: "Compose" })).toBe(false);
    expect(riskyElement({ role: "row", name: "Shop Your order has shipped" })).toBe(false);
    expect(riskyElement({ role: "link", name: "Read our post about the new pricing for teams and how it changes your plan" })).toBe(false);
    const p = page([
      { ref: "e1", role: "button", name: "Send" },
      { ref: "e2", role: "row", name: "Alice Lunch?" },
    ]);
    expect(approvalFor({ say: "", action: "click", ref: "e1" }, p)).toEqual({ kind: "action", text: "Click “Send” on google.com?" });
    expect(approvalFor({ say: "", action: "click", ref: "e2" }, p)).toBeNull();
  });

  it("checks a written document line by line, in order, ignoring whitespace", () => {
    expect(containsLinesInOrder("﻿Inbox digest\n\nAlice  —  lunch\nBob: invoice", ["Inbox digest", "Alice — lunch", "Bob: invoice"])).toEqual({ ok: true, missing: [] });
    expect(containsLinesInOrder("Bob\nAlice", ["Alice", "Bob"]).missing).toEqual(["Bob"]);
    // Google Docs restyles typed text: curly quotes, list numbering, dashes.
    const typed = ["Summaries", "1. Amazon.com - Out for delivery", "10. noelsopenclaw - run 'Refresh class intel - main' failed"];
    expect(containsLinesInOrder("Summaries\n\n* Amazon.com – Out for delivery\n* noelsopenclaw – run \u2018Refresh class intel – main\u2019 failed\n", typed).ok).toBe(true);
    expect(containsLinesInOrder("Summaries\nsomething else", typed).missing).toHaveLength(2);
  });
});

describe("agent: prompts", () => {
  it("marks page content untrusted, keeps notes, and shows a bounded history", () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ step: i + 1, say: "", action: `click e${i}`, result: "Done." }));
    const user = renderAgentPrompt({ task: "Summarize my inbox", today: "Sat Oct 24 2026", notes: ["Alice: lunch Friday"], history, page: page([{ ref: "e1", role: "button", name: "Compose" }]), reply: "ok", tool: "Message 1 of 1" });
    expect(user).toContain("<task>\nSummarize my inbox\n</task>");
    expect(user).toContain("Alice: lunch Friday");
    expect(user).toContain("(5 earlier steps not shown");
    expect(user).not.toContain("1. click e0");
    expect(user).toContain('e1 button "Compose"');
    expect(user).toContain("<user_reply>\nok\n</user_reply>");
    expect(user).toContain("<tool_result>\nMessage 1 of 1\n</tool_result>");
  });

  it("describes past actions by the element they targeted", () => {
    const p = page([{ ref: "e7", role: "row", name: "Alice Lunch?" }]);
    expect(describeDecision({ say: "", action: "click", ref: "e7" }, p)).toBe('click row "Alice Lunch?"');
    expect(describeDecision({ say: "", action: "type", text: "hello" }, null)).toBe('type "hello" at the cursor');
    expect(describeDecision({ say: "", action: "doc_create", title: "Digest", text: "abc" }, null)).toBe('doc_create "Digest" (3 characters)');
  });
});

class Scripted implements AgentModel {
  constructor(private readonly steps: (AgentStep | Error)[]) {}
  modelFor = () => "claude-haiku-5-5";
  parse = (async () => {
    const s = this.steps.shift();
    if (!s) throw new Error("script ran out");
    if (s instanceof Error) throw s;
    return { data: s, ms: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, model: "claude-haiku-5-5", speed: "standard" };
  }) as unknown as AgentModel["parse"];
}

describe("agent: engine service", () => {
  it("needs a model key to start", () => {
    const svc = new BrowserAgentService({ model: () => new Scripted([]), available: () => false });
    expect(() => svc.start("x")).toThrow(/API key/);
  });

  it("stops at the step limit and at the spending limit", async () => {
    const svc = new BrowserAgentService({ model: () => new Scripted([{ say: "a", action: "scroll" }, { say: "b", action: "scroll" }]), available: () => true, maxSteps: 1 });
    const t = svc.start("x");
    expect((await svc.step(t.taskId, { observation: null })).decision.action).toBe("scroll");
    const end = await svc.step(t.taskId, { observation: null, result: "Done." });
    expect(end).toMatchObject({ finished: true, decision: { action: "done" } });
    await expect(svc.step(t.taskId, { observation: null })).rejects.toThrow(/ended/);

    const broke = new BrowserAgentService({ model: (l: ModelLedger) => new Scripted([new BudgetExceededError(l.spentUsd, 0.5)]), available: () => true });
    const t2 = broke.start("x");
    expect((await broke.step(t2.taskId, { observation: null })).decision.text).toMatch(/spending limit of \$0\.50/);
  });

  it("answers Gmail and Docs actions itself only when a Google account is connected", async () => {
    const svc = new BrowserAgentService({ model: () => new Scripted([{ say: "Reading", action: "gmail_recent", count: 10 }]), available: () => true });
    const t = svc.start("x");
    expect(t.google).toBeNull();
    const r = await svc.step(t.taskId, { observation: null });
    expect(r.engineResult).toBe("No Google account is connected. Use the browser instead.");
  });
});

describe("google: messages and documents", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  it("reads a message's plain text, or its HTML reduced to text", () => {
    expect(messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Hi Noel,\r\nLunch?") } }, { mimeType: "text/html", body: { data: b64("<p>x</p>") } }] })).toBe("Hi Noel,\nLunch?");
    expect(messageText({ mimeType: "text/html", body: { data: b64("<style>p{}</style><p>Your &amp; statement</p><br>Total: $5") } })).toBe("Your & statement\nTotal: $5");
  });

  it("lays out headings and bullets with Docs indexes", () => {
    const l = docLayout("# Inbox digest\n- Alice: lunch\nPlain line\n## Action items\n");
    expect(l.text).toBe("Inbox digest\nAlice: lunch\nPlain line\nAction items\n");
    expect(l.headings).toEqual([
      { start: 1, end: 14, level: 1 },
      { start: 38, end: 51, level: 2 },
    ]);
    expect(l.bullets).toEqual([{ start: 14, end: 27 }]);
    expect(l.text.slice(14 - 1, 27 - 1)).toBe("Alice: lunch\n");
  });
});

describe("google: sign-in and API calls", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-google-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  type Call = { url: string; init?: RequestInit };
  const fakeGoogle = (scope: string = GOOGLE_SCOPES.join(" ")) => {
    const calls: Call[] = [];
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body));
        if (body.get("grant_type") === "authorization_code") return json({ access_token: "at1", expires_in: 3600, refresh_token: "rt1", scope });
        return json({ access_token: "at2", expires_in: 3600 });
      }
      if (url.endsWith("/users/me/profile")) return json({ emailAddress: "noel@example.com" });
      if (url.startsWith("https://docs.googleapis.com/v1/documents") && init?.method === "POST" && url.endsWith("/documents")) return json({ documentId: "doc123" });
      if (url.endsWith(":batchUpdate")) return json({});
      if (url.endsWith("/documents/doc123")) return json({ title: "Digest", body: { content: [{ paragraph: { elements: [{ textRun: { content: "Inbox digest\n" } }, { textRun: { content: "Alice: lunch\n" } }] } }] } });
      return json({ error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;
    return { calls, f };
  };

  it("signs in with PKCE and a single-use state, stores tokens privately, and refreshes them", async () => {
    let now = 1_000_000;
    const g = fakeGoogle();
    const acct = new GoogleAccount({ clientId: "cid", clientSecret: "secret", file: join(dir, "a.json"), redirectUri: () => "http://127.0.0.1:4000/oauth/google/callback", fetch: g.f, now: () => now });
    const url = new URL(acct.beginConnect());
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    await expect(acct.finishConnect({ code: "c", state: "wrong" })).rejects.toThrow(/expired or was already used/);
    expect(await acct.finishConnect({ code: "c", state })).toBe("noel@example.com");
    await expect(acct.finishConnect({ code: "c", state })).rejects.toThrow(/already used/);
    const tokenBody = new URLSearchParams(String(g.calls.find((c) => c.url.includes("/token"))!.init!.body));
    expect(tokenBody.get("code_verifier")).toMatch(/^[\w-]{40,}$/);
    expect(statSync(join(dir, "a.json")).mode & 0o777).toBe(0o600);
    expect(acct.status()).toEqual({ configured: true, email: "noel@example.com" });

    now += 2 * 3600_000;
    await acct.createDoc("Digest", "# Inbox digest\n- Alice: lunch");
    expect(g.calls.some((c) => new URLSearchParams(String(c.init?.body ?? "")).get("grant_type") === "refresh_token")).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "a.json"), "utf8")).accessToken).toBe("at2");
  });

  it("refuses a sign-in that didn't grant both scopes", async () => {
    const g = fakeGoogle(GOOGLE_SCOPES[0]);
    const acct = new GoogleAccount({ clientId: "cid", clientSecret: "secret", file: join(dir, "b.json"), redirectUri: () => "http://127.0.0.1:4000/cb", fetch: g.f });
    const state = new URL(acct.beginConnect()).searchParams.get("state")!;
    await expect(acct.finishConnect({ code: "c", state })).rejects.toThrow(/drive\.file/);
    expect(acct.status().email).toBeNull();
  });

  it("creates a document, styles it, and reads it back before calling it checked", async () => {
    const g = fakeGoogle();
    const acct = new GoogleAccount({ clientId: "cid", clientSecret: "secret", file: join(dir, "c.json"), redirectUri: () => "http://127.0.0.1:4000/cb", fetch: g.f });
    await acct.finishConnect({ code: "c", state: new URL(acct.beginConnect()).searchParams.get("state")! });
    const ok = await acct.createDoc("Digest", "# Inbox digest\n- Alice: lunch");
    expect(ok).toMatchObject({ kind: "google-doc", url: "https://docs.google.com/document/d/doc123/edit", verified: true });
    const batch = JSON.parse(String(g.calls.find((c) => c.url.endsWith(":batchUpdate"))!.init!.body)) as { requests: object[] };
    expect(batch.requests[0]).toEqual({ insertText: { location: { index: 1 }, text: "Inbox digest\nAlice: lunch\n" } });
    expect(batch.requests).toHaveLength(3);
    const missing = await acct.createDoc("Digest", "# Inbox digest\n- Alice: lunch\n- Bob: invoice");
    expect(missing.verified).toBe(false);
    expect(missing.detail).toMatch(/1 of 3 lines are missing/);
  });

  it("isn't available until a client is configured", () => {
    const acct = new GoogleAccount({ file: join(dir, "d.json"), redirectUri: () => "" });
    expect(acct.status()).toEqual({ configured: false, email: null });
    expect(() => acct.beginConnect()).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
  });
});
