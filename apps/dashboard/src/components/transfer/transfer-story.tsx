"use client";

import { useState, type ReactNode } from "react";
import { engine, errorMessage, type TransferReport, type TransferRun } from "@/lib/api";
import { fmtMs, fmtUsd } from "@/lib/format";
import { usePolling } from "@/lib/hooks";
import { Badge, cx, Empty, Panel } from "../ui/primitives";

/**
 * `/transfer`: one recorded capability transfer, read from the report `pnpm network:demo` wrote.
 * Every figure comes from that report (run summaries and the arena's independent checker); this
 * page computes nothing beyond display ratios.
 */
export function TransferStory() {
  const { data, error, loading } = usePolling((signal) => engine.transfers(signal), 0, []);
  const [picked, setPicked] = useState<string | null>(null);
  const reports = data ?? [];
  // Default: the newest passing changed-UI recording in which A learned cold (not a regression run).
  const r = reports.find((x) => x.name === picked) ?? reports.find((x) => x.passed && !x.expectRefusal && x.variation && !x.aWarmCache) ?? reports[0];
  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-3 p-3">
      {loading && !data ? (
        <p className="text-xs text-dim">Loading recorded transfers…</p>
      ) : error && !data ? (
        <p className="text-xs text-bad">Engine: {errorMessage(error)}</p>
      ) : !r ? (
        <Empty>No recorded transfers yet. Run the network demo to record one.</Empty>
      ) : (
        <>
          <Header report={r} reports={reports} onPick={setPicked} />
          <Steps r={r} />
          <Comparison r={r} />
          <Checks r={r} />
        </>
      )}
    </div>
  );
}

function Header({ report: r, reports, onPick }: { report: TransferReport; reports: TransferReport[]; onPick: (name: string) => void }) {
  const title = r.expectRefusal ? "Agent B refused a capability it couldn't prove safe" : r.variation ? "The website changed. Agent B still knew what to do." : "Agent B reused what Agent A learned";
  return (
    <section className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-panel px-4 py-3">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
        <p className="mt-1 text-xs text-dim">
          Recorded run, {new Date(r.at).toLocaleString()} · {r.records} records per runtime · seed {r.seed}
          {r.variation ? ` · UI change: ${r.variation}` : " · no UI change"}
        </p>
      </div>
      <Badge tone={r.passed ? "ok" : "bad"} className="text-sm">
        {r.passed ? "Every acceptance check passed" : "Some acceptance checks failed"}
      </Badge>
      {reports.length > 1 && (
        <label className="flex items-center gap-2 text-xs text-muted">
          Recording
          <select className="rounded border border-line bg-raised px-2 py-1 text-xs text-fg" value={r.name} onChange={(e) => onPick(e.target.value)}>
            {reports.map((x) => (
              <option key={x.name} value={x.name}>
                {new Date(x.at).toLocaleString()} · seed {x.seed} · {x.variation ?? "no change"}
                {x.expectRefusal ? " (refusal)" : ""}
                {x.aWarmCache ? " (regression: A reused its cache)" : ""} · {x.passed ? "pass" : "fail"}
              </option>
            ))}
          </select>
        </label>
      )}
    </section>
  );
}

const correct = (x: TransferRun) => `${x.checker.correct}/${x.checker.total}`;
const cleanWrites = (x: TransferRun) => x.checker.duplicateWrites === 0 && x.checker.collateralWrites === 0;

function Steps({ r }: { r: TransferReport }) {
  const t = r.transfer;
  const renames = Object.entries(t?.variations?.renameButtons ?? {}).flatMap(([app, m]) => Object.entries(m).map(([from, to]) => `${app}: “${from}” → “${to}”`));
  const tabs = Object.entries(t?.variations?.editInTab ?? {}).filter(([, on]) => on).map(([app]) => `${app}: edit fields moved into a tab`);
  const clicks = t?.actionsB.click ?? 0;
  return (
    <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <Step n={1} title="Agent A learned" big={correct(r.a)} ok={r.a.checker.accuracy === 1 && cleanWrites(r.a)}>
        Runtime A <Mono>{t?.identities.a ?? "?"}</Mono> started cold, planned the workflow ({r.plannerCalls.a} planning call{r.plannerCalls.a === 1 ? "" : "s"}), and wrote through the browser in {fmtMs(r.a.wallMs)}.
      </Step>
      <Step n={2} title="SpacetimeDB accepted" big={r.validation?.outcome === "pass" ? "ACTIVE" : (r.validation?.outcome ?? "?")} ok={r.validation?.outcome === "pass"}>
        A published <Mono>{r.versionId}</Mono>. An independent validator re-checked it in read-only browsers ({fmtMs(r.validation?.ms ?? null)}, no writes), then it was promoted.
      </Step>
      <Step n={3} title="Website changed" big={renames.length || tabs.length ? `${renames.length + tabs.length} change${renames.length + tabs.length === 1 ? "" : "s"}` : "none"} ok={!!r.variation}>
        {renames.length || tabs.length ? (
          <ul className="mt-1 space-y-0.5">
            {[...renames, ...tabs].map((x) => (
              <li key={x} className="font-mono text-[11px] text-fg">
                {x}
              </li>
            ))}
          </ul>
        ) : (
          "The interface was the same for both runtimes."
        )}
      </Step>
      <Step n={4} title={r.expectRefusal ? "Agent B refused" : "Agent B rebound"} big={r.expectRefusal ? (t?.importOutcome ?? "?") : `${t?.relabeled.length ?? 0} rebound`} ok={r.expectRefusal ? (t?.refused.length ?? 0) > 0 : (t?.refused.length ?? 0) === 0}>
        Runtime B <Mono>{t?.identities.b ?? "?"}</Mono> (own identity, {t?.bCacheBefore === 0 ? "empty cache" : `${t?.bCacheBefore} cached plans`}) fetched the capability and matched it against what it saw itself.
        {r.expectRefusal ? (
          <span className="mt-1 block text-warn">Refused: {(t?.refused ?? []).slice(0, 2).join("; ")}</span>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {(t?.relabeled ?? []).map((x) => (
              <li key={x.key} className="font-mono text-[11px] text-fg">
                “{x.from}” → “{x.to}” <span className="text-dim">({x.evidence})</span>
              </li>
            ))}
            {t?.writeCanary && <li className="text-[11px] text-ok">Write canary: one record wrote and verified before the rest ({t.canaryPassed} passed)</li>}
          </ul>
        )}
      </Step>
      <Step n={5} title={r.expectRefusal ? "B planned cold" : "Zero planning calls"} big={`${r.plannerCalls.b}`} ok={r.expectRefusal ? r.plannerCalls.b > 0 : r.plannerCalls.b === 0}>
        {r.expectRefusal ? "Nothing was guessed: B discovered and planned the workflow itself." : `B ran A's workflow without writing a new one: ${r.plannerCalls.b} planning calls (A made ${r.plannerCalls.a}), model cost ${fmtUsd(r.b.modelCostUsd)}.`}
      </Step>
      <Step n={6} title="Verified success" big={correct(r.b)} ok={r.b.checker.accuracy === 1 && cleanWrites(r.b)}>
        {clicks} browser clicks and {t?.verifiedB ?? 0} writes, each confirmed by a fresh read. The arena&apos;s own checker, which the agents never see, found {correct(r.b)} records correct, {r.b.checker.duplicateWrites} duplicate and {r.b.checker.collateralWrites} collateral writes.
      </Step>
    </ol>
  );
}

function Step({ n, title, big, ok, children }: { n: number; title: string; big: ReactNode; ok: boolean; children: ReactNode }) {
  return (
    <li className={cx("flex min-w-0 flex-col gap-1 rounded-lg border bg-panel px-3 py-3", ok ? "border-ok/40" : "border-bad/50")}>
      <div className="flex items-center gap-2">
        <span className="tnum flex h-5 w-5 items-center justify-center rounded-full bg-raised font-mono text-[11px] text-muted">{n}</span>
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{title}</h2>
      </div>
      <div className={cx("tnum font-mono text-2xl font-semibold", ok ? "text-ok" : "text-bad")}>{big}</div>
      <div className="text-xs leading-5 text-muted">{children}</div>
    </li>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-fg">{children}</span>;
}

function Comparison({ r }: { r: TransferReport }) {
  const c = r.c;
  const speed = r.comparison.wallSpeedup;
  return (
    <Panel id="transfer-compare" title="Same records, same interface" subtitle={c ? "B (imported) against C (a third fresh runtime that plans from scratch)" : "no cold comparison arm in this recording"}>
      {c ? (
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Cell label="B wall time" value={fmtMs(r.b.wallMs)} />
          <Cell label="C wall time (cold)" value={fmtMs(c.wallMs)} />
          <Cell label="B model cost" value={fmtUsd(r.b.modelCostUsd)} />
          <Cell label="C model cost" value={fmtUsd(c.modelCostUsd)} />
          <Cell label="C correct" value={correct(c)} />
          <Cell label="B correct" value={correct(r.b)} />
          <Cell label="Wall-time ratio C/B" value={speed !== undefined ? `${speed}×` : (r.comparison.note ?? "n/a")} />
          <Cell label="Import overhead (lookup + fetch + rebind)" value={fmtMs((r.overhead.bLookupMs ?? 0) + (r.overhead.bFetchMs ?? 0) + (r.overhead.bRebindMs ?? 0))} />
          {r.warm && <Cell label="C replaying its own cache (not a transfer)" value={`${fmtMs(r.warm.wallMs)} · ${correct(r.warm)}`} />}
        </div>
      ) : (
        <p className="text-xs text-dim">Run the demo without --no-cold-arm to record a cold comparison.</p>
      )}
    </Panel>
  );
}

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11px] text-muted">{label}</div>
      <div className="tnum truncate font-mono text-base text-fg">{value}</div>
    </div>
  );
}

function Checks({ r }: { r: TransferReport }) {
  return (
    <Panel id="transfer-checks" title="Acceptance checks" subtitle={`${r.checks.filter((c) => c.ok).length}/${r.checks.length} passed`} bodyClassName="p-0">
      <ul className="divide-y divide-line">
        {r.checks.map((c) => (
          <li key={c.check} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-3 py-1.5 text-xs">
            <Badge tone={c.ok ? "ok" : "bad"}>{c.ok ? "PASS" : "FAIL"}</Badge>
            <span className="min-w-0">
              <span className="text-fg">{c.check}</span>
              <span className="block truncate font-mono text-[11px] text-dim" title={c.detail}>
                {c.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
