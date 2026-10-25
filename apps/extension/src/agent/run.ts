import { approvalFor, containsLinesInOrder, ENGINE_ACTIONS, type AgentArtifact, type AgentObservation, type AgentStep, type AgentStepRequest } from "@overclock/contracts";
import type { OverclockApi } from "../api";
import { TabDriver } from "./tab";

/**
 * Runs one in-browser task from the side panel: asks the engine for each next action, asks the
 * user before clicks that send, delete, share, or pay, carries the action out in Overclock's tab (or lets the engine
 * carry out its Gmail and Docs actions), and reports what the tab shows. Closing the side panel,
 * the tab, or the browser's control bar stops the task.
 */

export interface AgentHooks {
  step(s: { step: number; say: string; detail: string; engine: boolean }): void;
  result(text: string, failed: boolean): void;
  progress(p: { costUsd: number; step: number }): void;
  approve(a: { kind: "action"; text: string }): Promise<boolean>;
  ask(question: string): Promise<string | null>;
}

export interface AgentOutcome {
  status: "done" | "stopped" | "failed";
  message: string;
  artifacts: AgentArtifact[];
  costUsd: number;
  steps: number;
  /** Where Overclock's tab ended up, if it opened one. */
  tabUrl: string | null;
}

const DOC_URL = /^https:\/\/docs\.google\.com\/document\/d\/([\w-]{20,})/;

/** A decision in a few words for the activity feed. */
export function detailOf(d: AgentStep): string {
  const clip = (s: string | undefined, n: number) => ((s ?? "").length > n ? `${(s ?? "").slice(0, n)}…` : (s ?? ""));
  switch (d.action) {
    case "navigate":
      return d.url ? clip(d.url.replace(/^https?:\/\//, ""), 60) : "";
    case "type":
      return `“${clip(d.text, 60)}”`;
    case "press":
      return d.key ?? "";
    case "gmail_recent":
      return `${d.count ?? 10} newest messages${d.query ? ` matching ${d.query}` : ""}`;
    case "doc_create":
      return `“${clip(d.title, 60)}”`;
    default:
      return "";
  }
}

export async function runAgentTask(api: OverclockApi, task: string, hooks: AgentHooks, signal: AbortSignal): Promise<AgentOutcome> {
  const info = await api.agentStart(task);
  let tab: TabDriver | null = null;
  let gone: string | null = null;
  let page: AgentObservation | null = null;
  let req: AgentStepRequest = { observation: null };
  let costUsd = 0;
  let steps = 0;
  let artifacts: AgentArtifact[] = [];
  /** Text typed into a Google Doc in the tab, by document id, to check it was saved. */
  const typedInDoc = new Map<string, string[]>();
  const stopped = (message: string): AgentOutcome => ({ status: "stopped", message, artifacts, costUsd, steps, tabUrl: null });
  let finished = false;
  try {
    for (;;) {
      if (signal.aborted) return stopped("You stopped the task.");
      if (gone) return stopped(gone);
      const r = await api.agentStep(info.taskId, req, signal);
      costUsd = r.costUsd;
      steps = r.step;
      artifacts = r.artifacts;
      hooks.progress({ costUsd, step: steps });
      const d = r.decision;
      hooks.step({ step: r.step, say: d.say, detail: detailOf(d), engine: ENGINE_ACTIONS.has(d.action) });
      if (r.engineResult !== undefined) {
        hooks.result(r.engineResult, /^That didn't work|^No Google account/.test(r.engineResult));
        req = { observation: page };
        continue;
      }
      if (d.action === "done") {
        finished = true;
        if (tab) artifacts = [...artifacts, ...(await checkTypedDocs(tab, typedInDoc, artifacts))];
        return { status: "done", message: d.text ?? "", artifacts, costUsd, steps, tabUrl: tab ? await tab.currentUrl().catch(() => null) : null };
      }
      if (d.action === "ask") {
        const reply = await hooks.ask(d.text ?? "");
        if (reply === null) return stopped("You stopped the task.");
        page = tab ? await tab.snapshot().catch(() => page) : null;
        req = { observation: page, result: "Asked the user.", reply };
        continue;
      }
      const approval = approvalFor(d, page);
      if (approval?.kind === "blocked") {
        hooks.result(approval.text, true);
        req = { observation: page, result: approval.text };
        continue;
      }
      if (approval && !(await hooks.approve(approval))) {
        hooks.result("You declined that click.", true);
        req = { observation: page, result: "The user declined this click. Don't try it again; finish without it, or ask the user." };
        continue;
      }
      let result = "Done.";
      let read: string | undefined;
      try {
        if (d.action === "navigate") {
          if (!tab) {
            tab = await TabDriver.open(d.url!, (why) => {
              gone = why;
            });
          } else await tab.navigate(d.url!);
          result = "Opened.";
        } else if (!tab) result = "No page is open yet. Use navigate first.";
        else if (d.action === "click") await tab.click(d.ref ?? "");
        else if (d.action === "type") {
          const docId = DOC_URL.exec(await tab.currentUrl())?.[1];
          // The editor draws its text, so the model can't see what's already there: never type
          // the same text into a document twice.
          const already = docId ? await docText(tab, docId) : null;
          if (docId && already !== null && containsLinesInOrder(already, linesOf(d.text ?? "")).ok) {
            result = `Not typed: a fresh download of the document shows it already contains this text (${already.trim().length} characters). Don't type it again; finish with done.`;
          } else {
            await tab.type(d.ref, d.text ?? "");
            if (docId) {
              typedInDoc.set(docId, [...(typedInDoc.get(docId) ?? []), d.text ?? ""]);
              result = await docFeedback(tab, docId, d.text ?? "");
            }
          }
        } else if (d.action === "press") await tab.press(d.key ?? "Enter");
        else if (d.action === "scroll") await tab.scroll(d.direction ?? "down");
        else if (d.action === "wait") await tab.wait(d.seconds ?? 2);
        else if (d.action === "read") {
          read = await tab.read(d.ref);
          result = `Read ${read.length} characters.`;
        }
      } catch (err) {
        result = `That didn't work: ${err instanceof Error ? err.message : String(err)}`;
        hooks.result(result, true);
      }
      if (tab && !gone) {
        try {
          page = await tab.snapshot();
        } catch (err) {
          page = null;
          result += ` The page can't be read (${err instanceof Error ? err.message : String(err)}).`;
        }
      }
      req = { observation: page, result, ...(read !== undefined ? { read } : {}) };
    }
  } catch (err) {
    if (signal.aborted) return stopped("You stopped the task.");
    return { status: "failed", message: err instanceof Error ? err.message : String(err), artifacts, costUsd, steps, tabUrl: null };
  } finally {
    await tab?.detach();
    if (!finished) await api.agentStop(info.taskId).catch(() => undefined);
  }
}

/**
 * What a Google Doc holds after typing, from a fresh download of it: the editor draws its text,
 * so the page itself never shows what was typed, and without this the model would type again.
 */
async function docFeedback(tab: TabDriver, docId: string, typed: string): Promise<string> {
  const lines = linesOf(typed);
  let last: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 1_500));
    last = await docText(tab, docId);
    if (last !== null && containsLinesInOrder(last, lines).ok) return `Typed. A fresh download of the document shows the text is there (${last.trim().length} characters in all). Don't type it again; finish with done.`;
  }
  if (last === null) return "Typed, but the document couldn't be downloaded to check it. Don't type it again; finish with done and say it wasn't checked.";
  const missing = containsLinesInOrder(last, lines).missing;
  return `Typed. A fresh download of the document has ${last.trim().length} characters, but ${missing.length} of ${lines.length} lines don't match yet (first: ${JSON.stringify(missing[0]?.slice(0, 80) ?? "")}). Don't type the whole text again: that adds a second copy. Finish with done.`;
}

const linesOf = (text: string) => text.split("\n").filter((l) => l.trim());

/** The document's current text, downloaded with the user's session; null when it can't be read. */
async function docText(tab: TabDriver, docId: string): Promise<string | null> {
  const res = await tab.fetchText(`https://docs.google.com/document/d/${docId}/export?format=txt`).catch(() => null);
  return res?.ok ? res.text : null;
}

/**
 * For text typed into a Google Doc in the tab: download the document as plain text with the
 * user's session and check every typed line is in it, in order. The editor draws text on a
 * canvas, so the page itself can't be read for this.
 */
async function checkTypedDocs(tab: TabDriver, typed: Map<string, string[]>, already: AgentArtifact[]): Promise<AgentArtifact[]> {
  const out: AgentArtifact[] = [];
  for (const [id, texts] of typed) {
    const url = `https://docs.google.com/document/d/${id}/edit`;
    if (already.some((a) => a.url === url)) continue;
    const lines = texts.flatMap((t) => t.split("\n")).filter((l) => l.trim());
    // Give the editor a moment to save before reading the document back.
    await new Promise((r) => setTimeout(r, 2_000));
    const res = await tab.fetchText(`https://docs.google.com/document/d/${id}/export?format=txt`).catch(() => ({ ok: false, status: 0, text: "" }));
    const check = res.ok ? containsLinesInOrder(res.text, lines) : { ok: false, missing: lines };
    const title = (await tab.snapshot().catch(() => null))?.title.replace(/ - Google Docs$/, "") ?? "Google Doc";
    out.push({
      kind: "google-doc",
      title,
      url,
      verified: check.ok,
      detail: !res.ok ? `Couldn't read the document back (${res.status || "no response"}).` : check.ok ? `Read the document back: all ${lines.length} typed lines are there.` : `Read the document back: ${check.missing.length} of ${lines.length} typed lines are missing.`,
    });
  }
  return out;
}
