"use client";

import { RunConfigSchema, TaskTemplateId, type ExecutionMode, type IntelligenceMode, type ConcurrencyMode, type PublicScenario, type RunConfigInput } from "@overclock/contracts";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { arena, engine, errorMessage } from "@/lib/api";
import { parseRecords } from "@/lib/records";
import { useHealth } from "../health";
import { Field, Input, Select, TextArea, Toggle } from "../ui/form";
import { Badge, Button, cx } from "../ui/primitives";

const MODES: { value: ExecutionMode; label: string; needsClaude?: boolean }[] = [
  { value: "overclock", label: "Overclock (streaming)" },
  { value: "overclock-staged", label: "Swarm, stage-gated" },
  { value: "compiled-parallel", label: "Compiled · fixed parallel" },
  { value: "compiled-single", label: "Compiled · single worker" },
  { value: "sequential-agent", label: "Sequential agent (baseline)", needsClaude: true },
];
const INTELLIGENCE: { value: IntelligenceMode; label: string }[] = [
  { value: "adaptive", label: "Adaptive" },
  { value: "single-planner", label: "Single planner" },
  { value: "parallel-scout", label: "Parallel scout swarm" },
];
const CONCURRENCY: { value: ConcurrencyMode; label: string }[] = [
  { value: "adaptive", label: "Adaptive" },
  { value: "fixed", label: "Fixed" },
];

interface AppRow {
  name: string;
  origin: string;
}

type Notice = { tone: "ok" | "bad" | "neutral"; text: string } | null;

/** New-run form: goal, records, apps, execution options, and scenario loading from the arena. */
export function CommandBar({ defaultOpen }: { defaultOpen: boolean }) {
  const router = useRouter();
  const ids = useId();
  const { health } = useHealth();
  const [open, setOpen] = useState(defaultOpen);
  const [goal, setGoal] = useState("");
  const [recordsText, setRecordsText] = useState("");
  const [apps, setApps] = useState<AppRow[]>([]);
  const [mode, setMode] = useState<ExecutionMode>("overclock");
  const [intelligence, setIntelligence] = useState<IntelligenceMode>("adaptive");
  const [concurrency, setConcurrency] = useState<ConcurrencyMode>("adaptive");
  const [maxWorkers, setMaxWorkers] = useState(8);
  const [useJev, setUseJev] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [thumbnails, setThumbnails] = useState(true);
  const [seed, setSeed] = useState(4242);
  const [template, setTemplate] = useState<TaskTemplateId>("t1-order-reconcile");
  const [recordCount, setRecordCount] = useState(100);
  const [busy, setBusy] = useState<"scenario" | "generate" | "start" | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [scenario, setScenario] = useState<PublicScenario | null>(null);

  const parsed = useMemo(() => parseRecords(recordsText), [recordsText]);
  const claude = health?.capabilities.anthropic;
  const jev = health?.capabilities.typesafe;
  const browser = health?.capabilities.browser;
  const jevOn = useJev && jev?.available !== false;

  const fill = (s: PublicScenario) => {
    setOpen(true);
    setScenario(s);
    setGoal(s.goal);
    setRecordsText(JSON.stringify(s.records, null, 2));
    setApps(s.applications.map((a) => ({ name: a.name, origin: a.origin })));
  };

  const loadScenario = async () => {
    setBusy("scenario");
    setNotice(null);
    try {
      const s = await arena.scenario();
      fill(s);
      setNotice({ tone: "ok", text: `Loaded ${s.title} (${s.records.length} records, seed ${s.seed})` });
    } catch (e) {
      setNotice({ tone: "bad", text: `Arena: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy("generate");
    setNotice(null);
    try {
      const s = await arena.createScenario({ seed, template, records: recordCount });
      fill(s);
      setNotice({ tone: "ok", text: `Generated ${s.scenarioId} (${s.records.length} records)` });
    } catch (e) {
      setNotice({ tone: "bad", text: `Arena: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    if (!parsed.ok) {
      setNotice({ tone: "bad", text: parsed.error });
      return;
    }
    const config: RunConfigInput = { goal: goal.trim(), applications: apps.filter((a) => a.name || a.origin), records: parsed.records, mode, intelligence, concurrency, maxWorkers, useJev: jevOn, dryRun, thumbnails };
    const check = RunConfigSchema.safeParse(config);
    if (!check.success) {
      setNotice({ tone: "bad", text: check.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ") });
      return;
    }
    setBusy("start");
    setNotice(null);
    try {
      const res = await engine.createRun(config);
      setOpen(false);
      router.push(`/runs/${encodeURIComponent(res.runId)}`);
    } catch (e) {
      setNotice({ tone: "bad", text: `Engine: ${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  };

  const recordsHint = parsed.ok ? (parsed.format === "empty" ? "JSON array or CSV with header" : `${parsed.records.length} records · ${parsed.format.toUpperCase()}`) : parsed.error;

  return (
    <section aria-label="New run" className="rounded-lg border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={`${ids}-form`} className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase hover:text-fg">
          <span aria-hidden className={cx("inline-block text-[10px] transition-transform", open && "rotate-90")}>
            ▸
          </span>
          New run
        </button>
        {scenario && !open && <span className="truncate text-xs text-dim">Scenario {scenario.scenarioId} ready</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={() => void loadScenario()} disabled={busy !== null}>
            {busy === "scenario" ? "Loading…" : "Load arena scenario"}
          </Button>
          {!open && (
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              Configure
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div id={`${ids}-form`} className="grid gap-3 border-t border-line p-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(260px,0.8fr)]">
          <div className="flex min-w-0 flex-col gap-3">
            <Field label="Goal" htmlFor={`${ids}-goal`} hint="Natural-language task across the apps">
              <TextArea id={`${ids}-goal`} rows={7} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Reconcile these customer orders across CRM, Orders, and Support…" />
            </Field>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[11px] font-medium text-muted">
                Applications
                <button type="button" className="ml-auto text-accent-soft hover:underline" onClick={() => setApps((a) => [...a, { name: "", origin: "" }])}>
                  Add app
                </button>
              </div>
              {apps.length === 0 && <div className="rounded-md border border-dashed border-line px-2 py-2 text-xs text-dim">No apps yet. Load an arena scenario or add one.</div>}
              {apps.map((a, i) => (
                <div key={i} className="grid grid-cols-[110px_minmax(0,1fr)_auto] gap-1.5">
                  <Input aria-label={`App ${i + 1} name`} value={a.name} placeholder="Name" onChange={(e) => setApps((rows) => rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} />
                  <Input aria-label={`App ${i + 1} origin`} value={a.origin} placeholder="http://127.0.0.1:4101" className="font-mono text-xs" onChange={(e) => setApps((rows) => rows.map((r, j) => (j === i ? { ...r, origin: e.target.value } : r)))} />
                  <Button size="sm" variant="ghost" aria-label={`Remove app ${i + 1}`} onClick={() => setApps((rows) => rows.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <Field label="Records" htmlFor={`${ids}-records`} hint={<span className={cx(!parsed.ok && "text-bad")}>{recordsHint}</span>}>
              <TextArea id={`${ids}-records`} rows={9} value={recordsText} onChange={(e) => setRecordsText(e.target.value)} spellCheck={false} className="font-mono text-xs" placeholder={'[{"orderId": "ORD-1001"}, …]\n\nor CSV:\norderId,email\nORD-1001,a@example.com'} />
            </Field>
            <fieldset className="rounded-md border border-line p-2">
              <legend className="px-1 text-[11px] font-medium text-muted">Generate arena scenario</legend>
              <div className="grid grid-cols-[80px_minmax(0,1fr)_80px_auto] items-end gap-1.5">
                <Field label="Seed" htmlFor={`${ids}-seed`}>
                  <Input id={`${ids}-seed`} type="number" min={0} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
                </Field>
                <Field label="Template" htmlFor={`${ids}-template`}>
                  <Select id={`${ids}-template`} value={template} onChange={(e) => setTemplate(TaskTemplateId.parse(e.target.value))}>
                    {TaskTemplateId.options.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Records" htmlFor={`${ids}-count`}>
                  <Input id={`${ids}-count`} type="number" min={1} max={500} value={recordCount} onChange={(e) => setRecordCount(Math.min(500, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
                </Field>
                <Button size="sm" className="h-8" onClick={() => void generate()} disabled={busy !== null}>
                  {busy === "generate" ? "Generating…" : "Generate"}
                </Button>
              </div>
            </fieldset>
          </div>

          <div className="flex min-w-0 flex-col gap-2.5">
            <Field label="Mode" htmlFor={`${ids}-mode`}>
              <Select id={`${ids}-mode`} value={mode} onChange={(e) => setMode(e.target.value as ExecutionMode)}>
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                    {m.needsClaude && claude && !claude.available ? " (Claude unavailable)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Intelligence" htmlFor={`${ids}-intel`}>
                <Select id={`${ids}-intel`} value={intelligence} onChange={(e) => setIntelligence(e.target.value as IntelligenceMode)}>
                  {INTELLIGENCE.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Concurrency" htmlFor={`${ids}-conc`}>
                <Select id={`${ids}-conc`} value={concurrency} onChange={(e) => setConcurrency(e.target.value as ConcurrencyMode)}>
                  {CONCURRENCY.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Max workers" htmlFor={`${ids}-workers`} hint="1–32">
              <Input id={`${ids}-workers`} type="number" min={1} max={32} value={maxWorkers} onChange={(e) => setMaxWorkers(Math.min(32, Math.max(1, Math.floor(Number(e.target.value) || 1))))} />
            </Field>
            <div className="flex flex-col gap-1.5 pt-1">
              <Toggle id={`${ids}-jev`} label="Jev reflex model" checked={jevOn} disabled={jev?.available === false} hint={jev?.available === false ? "unavailable" : undefined} onChange={setUseJev} />
              <Toggle id={`${ids}-dry`} label="Dry run" hint="no writes" checked={dryRun} onChange={setDryRun} />
              <Toggle id={`${ids}-thumbs`} label="Worker thumbnails" checked={thumbnails} onChange={setThumbnails} />
            </div>
            {claude && !claude.available && <p className="text-[11px] text-warn">Claude is unavailable{claude.reason ? ` (${claude.reason})` : ""}: planning, scouts and the sequential baseline cannot run.</p>}
            {browser && !browser.available && <p className="text-[11px] text-bad">Browser runtime unavailable{browser.reason ? ` (${browser.reason})` : ""}.</p>}
            <Button variant="primary" className="mt-auto" onClick={() => void start()} disabled={busy !== null || !goal.trim()}>
              {busy === "start" ? "Starting…" : "Start run"}
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <div role="status" className={cx("border-t border-line px-3 py-1.5 text-xs", notice.tone === "bad" ? "text-bad" : notice.tone === "ok" ? "text-ok" : "text-muted")}>
          {notice.text}
        </div>
      )}
    </section>
  );
}

export function ModeBadge({ mode }: { mode: string | undefined }) {
  if (!mode) return null;
  return <Badge tone={mode === "overclock" ? "accent" : "neutral"}>{mode}</Badge>;
}
