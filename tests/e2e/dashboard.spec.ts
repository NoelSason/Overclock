import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { applyEvent, createRunView, deriveMetrics } from "@overclock/contracts";
import type { EventsPage, RunEvent, RunListItem, RunStatusResponse, RunView, TaskState } from "@overclock/contracts";
import { ENGINE_URL, EXTERNAL_ENGINE, RUN_ID } from "./env";

/**
 * The dashboard must show exactly what the shared reducer computes from the engine's events, and
 * rebuild identical state after a reload in the middle of a stream.
 *
 * Against the replay fixture the stream is held at a seq number mid-execution, so "mid-stream"
 * is deterministic. Against a real engine (OVERCLOCK_E2E_ENGINE_URL) the test waits for the run
 * to finish and checks the final state, then reloads and checks again.
 */

interface ReplayState {
  runId: string;
  releasedSeq: number;
  total: number;
}

interface Shown {
  seq: number;
  verified: string;
  modelCalls: string;
  firstVerified: string;
  firstAction: string;
  overlap: string;
  timelineOverlap: string;
  taskCounts: Record<string, string>;
}

async function replayState(request: APIRequestContext): Promise<ReplayState | null> {
  if (EXTERNAL_ENGINE) return null;
  const res = await request.get(`${ENGINE_URL}/__replay/state`);
  return res.ok() ? ((await res.json()) as ReplayState) : null;
}

async function fetchEvents(request: APIRequestContext, runId: string): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for (;;) {
    const res = await request.get(`${ENGINE_URL}/api/runs/${encodeURIComponent(runId)}/events?after=${out.at(-1)?.seq ?? 0}&limit=1000`);
    expect(res.ok()).toBe(true);
    const page = (await res.json()) as EventsPage;
    if (page.events.length === 0) return out;
    out.push(...page.events);
  }
}

function reduce(events: RunEvent[], runId: string): RunView {
  const view = createRunView(runId);
  for (const e of events) applyEvent(view, e);
  return view;
}

/** What the dashboard should display for a view (raw data-value strings). */
function expected(view: RunView): Shown {
  const m = deriveMetrics(view);
  const hasExecution = view.stages.some((s) => s.stage === "execution");
  const overlap = hasExecution ? String(m.overlapMs) : "";
  return {
    seq: view.lastSeq,
    verified: String(m.verified),
    modelCalls: String(view.modelCalls.count),
    firstVerified: m.firstVerifiedMs === null ? "" : String(m.firstVerifiedMs),
    firstAction: m.firstActionMs === null ? "" : String(m.firstActionMs),
    overlap,
    timelineOverlap: overlap,
    taskCounts: Object.fromEntries(
      (Object.entries(view.taskCounts) as [TaskState, number][])
        .filter(([, n]) => n > 0)
        .map(([s, n]): [string, string] => [s, String(n)])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
}

async function shown(page: Page): Promise<Shown> {
  const value = async (testId: string) => (await page.getByTestId(testId).first().getAttribute("data-value")) ?? "";
  const counts = await page.locator('[data-testid^="task-count-"]').evaluateAll((els) =>
    els.map((el) => [el.getAttribute("data-testid")!.replace("task-count-", ""), el.getAttribute("data-value") ?? ""] as [string, string]),
  );
  return {
    seq: Number(await value("event-count")),
    verified: await value("stat-verified"),
    modelCalls: await value("stat-model-calls"),
    firstVerified: await value("stat-first-verified"),
    firstAction: await value("stat-first-action"),
    overlap: await value("stat-overlap"),
    timelineOverlap: await value("timeline-overlap"),
    taskCounts: Object.fromEntries(counts.sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** Wait until the page has applied exactly `view.lastSeq` events, then compare everything. */
async function expectMatches(page: Page, view: RunView): Promise<void> {
  const want = expected(view);
  await expect.poll(async () => (await shown(page)).seq, { message: "dashboard applied every event" }).toBe(want.seq);
  // Panels re-render on a short throttle after the last event; poll until they settle.
  await expect.poll(async () => shown(page), { message: "displayed numbers equal the reducer" }).toEqual(want);
}

async function resolveRunId(request: APIRequestContext, replay: ReplayState | null): Promise<string> {
  if (replay) return replay.runId;
  if (RUN_ID) return RUN_ID;
  const res = await request.get(`${ENGINE_URL}/api/runs`);
  const runs = (await res.json()) as RunListItem[];
  const latest = [...runs].sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!latest) throw new Error("The engine has no runs; start one or set OVERCLOCK_E2E_RUN_ID");
  return latest.runId;
}

test("displayed counts equal the reducer, live and after a reload mid-stream", async ({ page, request }) => {
  const replay = await replayState(request);
  const runId = await resolveRunId(request, replay);

  if (replay) {
    // Hold the stream mid-execution: after the first verified write and while discovery overlaps.
    const all = (await (await request.get(`${ENGINE_URL}/__replay/events`)).json()) as RunEvent[];
    const holdAt = all.find((e) => e.t >= 12_000)?.seq ?? Math.floor(all.length / 2);
    await request.post(`${ENGINE_URL}/__replay/control`, { data: { action: "reset", speed: 8, holdAt } });
    await expect.poll(async () => (await replayState(request))?.releasedSeq).toBe(holdAt);
  } else {
    // Real engine: let the run finish so the event list is stable.
    await expect
      .poll(async () => ((await (await request.get(`${ENGINE_URL}/api/runs/${encodeURIComponent(runId)}`)).json()) as RunStatusResponse).status, { timeout: 600_000, intervals: [2000] })
      .toMatch(/completed|failed|cancelled/);
  }

  const partial = await fetchEvents(request, runId);
  expect(partial.length).toBeGreaterThan(0);
  const partialView = reduce(partial, runId);
  if (replay) {
    expect(partialView.summary, "held before completion").toBeUndefined();
    expect(deriveMetrics(partialView).firstVerifiedMs, "held after the first verified write").not.toBeNull();
  }

  await page.goto(`/runs/${encodeURIComponent(runId)}`);
  await expectMatches(page, partialView);

  // A reload rebuilds identical state from /events + /stream.
  await page.reload();
  await expectMatches(page, partialView);

  if (!replay) return;

  // Release the rest of the stream; the live page must converge on the final reducer state.
  await request.post(`${ENGINE_URL}/__replay/control`, { data: { action: "release" } });
  await expect.poll(async () => (await replayState(request))?.releasedSeq, { timeout: 60_000 }).toBe(replay.total);
  const final = reduce(await fetchEvents(request, runId), runId);
  expect(final.summary?.status).toBe("completed");
  await expectMatches(page, final);
  await expect(page.getByTestId("run-status")).toHaveText("completed");
  await expect(page.getByTestId("stat-total-wall")).toHaveAttribute("data-value", String(deriveMetrics(final).elapsedMs));

  await page.reload();
  await expectMatches(page, final);
});
