import type { RecordOutcome, RunEvent, RunView } from "@overclock/contracts";

/** Customer-facing wording for engine events and outcomes. Pure: every line comes from a real event. */

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return "—";
  return usd === 0 ? "$0" : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function outcomeLabel(o: Pick<RecordOutcome, "status" | "writes">): { label: string; tone: Tone } {
  switch (o.status) {
    case "VERIFIED":
      return o.writes > 0 ? { label: "Changed · verified", tone: "ok" } : { label: "Checked · verified", tone: "ok" };
    case "SKIPPED":
      return { label: "No change needed", tone: "muted" };
    case "UNCONFIRMED":
      return { label: "Unconfirmed", tone: "warn" };
    case "NEEDS_APPROVAL":
      return { label: "Needs approval", tone: "warn" };
    case "FAILED":
      return { label: "Failed", tone: "bad" };
  }
}

const STATUS_TEXT: Record<string, string> = {
  pending: "Queued",
  discovering: "Preparing",
  compiling: "Compiling the workflow",
  running: "Running",
  paused: "Paused",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

/** One readable line for an event worth showing in the activity feed, or null. */
export function eventLine(e: RunEvent): { text: string; tone: Tone } | null {
  switch (e.type) {
    case "policy.decision":
      if (e.intelligence === "warm-cache") return { text: "Reusing the workflow learned on this computer: no AI planning.", tone: "ok" };
      if (e.intelligence === "network-import") return { text: "Reusing your team's verified workflow: no AI planning.", tone: "ok" };
      return { text: "Planning a new workflow with AI.", tone: "info" };
    case "network.lookup":
      return e.outcome === "FOUND" ? { text: "Found a verified workflow from your team for exactly this task.", tone: "info" } : e.outcome === "NO_CAPABILITY" ? { text: "No shared workflow for exactly this task.", tone: "muted" } : null;
    case "network.import": {
      if (e.refused?.length) return { text: `Didn't reuse the shared workflow: ${e.refused[0]}`, tone: "warn" };
      const renamed = e.relabeled?.length ?? 0;
      return { text: `Re-checked ${e.bound} controls on the live pages${renamed ? `; ${renamed} renamed button${renamed > 1 ? "s" : ""} matched by the form's structure` : ""}.`, tone: "info" };
    }
    case "receipt":
      if (e.status === "VERIFIED") return { text: `${e.recordKey}: change confirmed by re-reading the page.`, tone: "ok" };
      if (e.status === "SKIPPED") return null;
      return { text: `${e.recordKey}: ${e.status === "UNCONFIRMED" ? "couldn't confirm the change" : "change didn't verify"}.`, tone: e.status === "UNCONFIRMED" ? "warn" : "bad" };
    case "approval.requested":
      return { text: `Waiting for your approval: ${e.description}`, tone: "warn" };
    case "approval.resolved":
      return { text: e.approved ? "Approved." : "Rejected; that step won't run.", tone: e.approved ? "ok" : "warn" };
    case "model.call":
      return { text: `AI call (${e.purpose}) ${e.ok ? fmtUsd(e.costUsd) : "failed"}.`, tone: "info" };
    case "log":
      if (/^write canary passed/.test(e.message)) return { text: "Safety check passed: one record was written and verified before the rest.", tone: "ok" };
      if (/^write canary on/.test(e.message)) return { text: "A button was renamed, so one record goes first and is verified before the rest.", tone: "info" };
      if (e.level === "error") return { text: e.message, tone: "bad" };
      if (e.level === "warn" && !/^network: \d+ skipped/.test(e.message)) return { text: e.message, tone: "warn" };
      return null;
    case "run.status":
      return e.status === "failed" || e.status === "cancelled" ? { text: `${statusText(e.status)}${e.reason ? `: ${e.reason}` : ""}`, tone: "bad" } : null;
    case "run.completed":
      return { text: `Finished in ${fmtMs(e.summary.wallMs)}.`, tone: "ok" };
    default:
      return null;
  }
}

/**
 * Progress over the input records, from the run view. A task's record key is the value of the
 * workflow's record key (for example the order ID), so input records are recognised by their
 * values; records a later phase derives (customers to hold) don't count toward the batch.
 */
export function recordProgress(view: RunView, records: Record<string, string>[]): { finished: number; total: number } {
  const inputValues = new Set(records.flatMap((r) => Object.values(r)));
  const terminal = new Set(["VERIFIED", "COMPLETED", "SKIPPED", "FAILED", "UNCONFIRMED", "CANCELLED", "NEEDS_APPROVAL"]);
  const done = new Map<string, boolean>();
  for (const t of Object.values(view.tasks)) {
    if (!inputValues.has(t.recordKey)) continue;
    done.set(t.recordKey, (done.get(t.recordKey) ?? true) && terminal.has(t.state));
  }
  let finished = 0;
  for (const d of done.values()) if (d) finished++;
  return { finished: Math.min(finished, records.length), total: records.length };
}
