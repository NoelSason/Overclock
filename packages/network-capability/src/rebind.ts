import type { AppBinding, AppControl, AppModel, DslPlan, ExecutionProgram } from "@overclock/contracts";
import { settle, type BrowserManager, type StorageState } from "@overclock/browser-runtime";
import { hasErrors, lowerPlan, validateProgram, type Issue } from "@overclock/compiler";
import { buildAppModel } from "@overclock/discovery";
import type { CompatibilityOutcome, PortableCapability, PortableControl, PortablePage, RebindReport } from "@overclock/network-contracts";
import { observe, routePattern, type Observation } from "@overclock/perception";
import type { Page } from "playwright";
import { describeControl, normLabel, pageOf, regionMap, type ControlDescriptor } from "./describe";
import { mapControlRefs, submitContexts } from "./plan";

/**
 * Import-side rebinding. Observation-local control ids are not portable, so a runtime that
 * downloads a capability visits the route families it needs (a targeted mini-crawl in a
 * mutation-blocked context), builds its own app model from those observations, and binds every
 * PortableControl to one of its own controls with deterministic rules. Only then is the plan
 * rewritten to local ids and compiled against the local models.
 */

export type Evidence = "label" | "similar" | "structural" | "none";

export interface Binding {
  key: string;
  localId: string | null;
  evidence: Evidence;
  score: number;
  /** Candidates of the same app, route family, and kind that were considered. */
  candidates: number;
  reason?: string | undefined;
}

export interface MissingRoute {
  app: string;
  routeFamily: string;
  reason: string;
}

export interface FingerprintCheck {
  app: string;
  routeFamily: string;
  page: boolean;
  regions: { key: string; match: boolean }[];
}

export interface RebindArgs {
  capability: PortableCapability;
  /** The caller's app bindings (name -> origin). Names must match the capability's applications. */
  apps: AppBinding[];
  browser: BrowserManager;
  /**
   * Session to observe with. Pass the session the plan will execute with: the context blocks
   * every mutation, so observing with it is safe, and only its view shows what it may write.
   */
  storageState?: StorageState | undefined;
  signal?: AbortSignal | undefined;
  /** Caller's input records; a path param named like a record field takes its value from records[0]. */
  records?: Record<string, unknown>[] | undefined;
  /** Declared coarse role class of the session per app (or one for all); a mismatch makes the capability incompatible. */
  sessionRoleClass?: string | Record<string, string> | undefined;
  /** Normalized-similarity threshold for fuzzy label matches (default 0.8). */
  threshold?: number | undefined;
  navTimeoutMs?: number | undefined;
}

export interface RebindResult {
  report: RebindReport;
  /** The capability's plan with fresh local control ids. */
  plan: DslPlan;
  /** Local app models built from this runtime's own observations. */
  models: AppModel[];
  /** portable key -> local control id (only unique bindings). */
  bindings: Map<string, string>;
  /** Lowered IR when the rebound plan compiled; null otherwise. */
  program: ExecutionProgram | null;
  /** Compiler issues from lowering and validating the rebound plan. */
  issues: Issue[];
  details: {
    bindings: Binding[];
    /** Problems that make writes unsafe even when every control bound (e.g. `hidden-in-tab:<key>`). */
    flags: string[];
    /** Submit buttons bound structurally that writes may use behind a write canary (see RebindReport.writeCanary). */
    structuralWrites: string[];
    /** Bindings whose label differs from the publisher's: what changed in the interface. */
    relabeled: { key: string; from: string; to: string; evidence: Evidence }[];
    missingRoutes: MissingRoute[];
    fingerprints: FingerprintCheck[];
    /**
     * Concrete path parameters found during the mini-crawl, per app (e.g. a list page's first
     * record link). Local only: these are data and must never be shared.
     */
    paramValues: Record<string, Record<string, string>>;
    /** navigateMs and observeMs sum over pages; apps are crawled concurrently, so they can exceed totalMs. */
    timings: { totalMs: number; navigateMs: number; observeMs: number; matchMs: number; compileMs: number; perPage: { app: string; routeFamily: string; ms: number }[] };
  };
}

export const DEFAULT_THRESHOLD = 0.8;

// ---------------------------------------------------------------------------------------------
// Deterministic matching

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** 1 - edit distance / longer length, on normalized labels. */
export function similarity(a: string, b: string): number {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x && !y) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const optionSet = (o: { value: string }[] | undefined) =>
  (o ?? [])
    .map((x) => x.value)
    .sort()
    .join("\u0001");
const headerSet = (h: string[] | undefined) => (h ?? []).map((x) => normLabel(x)).sort();
const primaryText = (x: { label?: string | undefined; name: string }) => x.label ?? x.name;
const FIELD_KINDS = new Set<PortableControl["kind"]>(["input", "select", "textarea", "checkbox"]);
const isWriteEffect = (e: string | undefined) => e === "remote-write" || e === "irreversible";

export interface LocalCandidate {
  control: AppControl;
  descriptor: ControlDescriptor;
}

/**
 * Bind one portable control to one local control. Candidates must already share app, route
 * family, and kind. Rules, in order (the first rule with any candidate decides):
 *  1. label: normalized label/name equal (tables: header set equal), option-value set equal for
 *     selects; ties broken by form signature, param, dialog, tab, type agreement.
 *  2. similar: normalized similarity >= threshold (tables: header Jaccard >= 0.6), unique best
 *     by a margin of at least 0.05.
 *  3. structural: fields with the same param, type, and option set; the single submit button of
 *     a form with the same form signature; tables with header Jaccard >= 0.5.
 * Unique -> bound; several -> ambiguous (never guessed); none -> unbound with a reason.
 */
export function matchControl(p: PortableControl, cands: LocalCandidate[], threshold = DEFAULT_THRESHOLD): Binding {
  const base = { key: p.key, candidates: cands.length };
  if (!cands.length) return { ...base, localId: null, evidence: "none", score: 0, reason: `no ${p.kind} on ${p.routeFamily}` };
  const pText = normLabel(primaryText(p));
  const pOpts = optionSet(p.options);
  const pHeaders = headerSet(p.headers);

  const labelEq = cands.filter(({ descriptor: d }) => {
    if (p.kind === "table") return pHeaders.length > 0 && headerSet(d.headers).join("|") === pHeaders.join("|");
    if (normLabel(primaryText(d)) !== pText || !pText) return false;
    if (p.options && d.options && optionSet(d.options) !== pOpts) return false;
    return true;
  });
  if (labelEq.length) {
    if (labelEq.length === 1) return { ...base, localId: labelEq[0]!.control.id, evidence: "label", score: 1 };
    const agree = (d: ControlDescriptor) =>
      (p.formSignature !== undefined && d.formSignature === p.formSignature ? 4 : 0) +
      (p.param !== undefined && d.param === p.param ? 2 : 0) +
      ((p.inDialog ?? false) === (d.inDialog ?? false) ? 1 : 0) +
      ((p.tabPanel ?? "") === (d.tabPanel ?? "") ? 1 : 0) +
      ((p.type ?? "") === (d.type ?? "") ? 1 : 0) +
      (p.kind === "table" && normLabel(p.name) === normLabel(d.name) ? 1 : 0);
    const scored = labelEq.map((c) => ({ c, s: agree(c.descriptor) })).sort((a, b) => b.s - a.s);
    if (scored[0]!.s > scored[1]!.s) return { ...base, localId: scored[0]!.c.control.id, evidence: "label", score: 1 };
    return { ...base, localId: null, evidence: "none", score: 1, reason: `ambiguous: ${labelEq.length} ${p.kind}s labelled "${primaryText(p)}" on ${p.routeFamily}` };
  }

  // 2. fuzzy label (never write-safe)
  const sims = cands
    .map((c) => {
      const d = c.descriptor;
      let s: number;
      if (p.kind === "table") s = jaccard(pHeaders, headerSet(d.headers)) >= 0.6 ? jaccard(pHeaders, headerSet(d.headers)) : 0;
      else {
        s = pText ? similarity(primaryText(p), primaryText(d)) : 0;
        if (p.options && d.options && jaccard(p.options.map((o) => o.value), d.options.map((o) => o.value)) < 0.5) s = 0;
      }
      return { c, s };
    })
    .filter((x) => x.s >= (p.kind === "table" ? 0.6 : threshold))
    .sort((a, b) => b.s - a.s || a.c.control.id.localeCompare(b.c.control.id));
  if (sims.length) {
    const top = sims[0]!;
    if (sims.length === 1 || top.s - sims[1]!.s >= 0.05) return { ...base, localId: top.c.control.id, evidence: "similar", score: Math.round(top.s * 1000) / 1000 };
    return { ...base, localId: null, evidence: "none", score: top.s, reason: `ambiguous: ${sims.length} ${p.kind}s with labels similar to "${primaryText(p)}"` };
  }

  // 3. structural
  let structural: LocalCandidate[] = [];
  if (FIELD_KINDS.has(p.kind) && p.param) {
    structural = cands.filter(({ descriptor: d }) => d.param === p.param && (d.type ?? "") === (p.type ?? "") && (!p.options || !d.options || optionSet(d.options) === pOpts));
  } else if (p.kind === "button" && p.formSignature && isWriteEffect(p.effect)) {
    structural = cands.filter(({ descriptor: d }) => d.formSignature === p.formSignature && isWriteEffect(d.effect));
  } else if (p.kind === "table") {
    structural = cands.filter(({ descriptor: d }) => jaccard(pHeaders, headerSet(d.headers)) >= 0.5);
  }
  if (structural.length === 1) return { ...base, localId: structural[0]!.control.id, evidence: "structural", score: 0.5 };
  if (structural.length > 1) return { ...base, localId: null, evidence: "none", score: 0.5, reason: `ambiguous: ${structural.length} structurally equivalent ${p.kind}s on ${p.routeFamily}` };
  return { ...base, localId: null, evidence: "none", score: 0, reason: `no ${p.kind} on ${p.routeFamily} matches by label, similarity, param, or form` };
}

// ---------------------------------------------------------------------------------------------
// Targeted mini-crawl

const DISMISS = /^(dismiss|close|got it|ok|okay|no thanks|continue|×|✕|x)$/i;

async function clearDialogs(page: Page, obs: Observation): Promise<boolean> {
  const open = obs.dialogs.find((d) => d.open);
  if (!open) return false;
  for (const id of open.controlIds) {
    const c = obs.controls.find((x) => x.id === id);
    if (c && c.role === "button" && DISMISS.test(c.name)) {
      await page.locator(c.cssPath).click({ timeout: 2000 }).catch(() => undefined);
      return true;
    }
  }
  return false;
}

function hrefRoute(href: string, base: string): { url: URL; route: string } | null {
  try {
    const url = new URL(href, base);
    return { url, route: routePattern(url.toString()) };
  } catch {
    return null;
  }
}

/** A concrete link to `routeFamily` on an observed page: list-table links first, then any link. */
function linkTo(obs: Observation, routeFamily: string, origin: string, headers?: string[]): string | null {
  const tables = [...obs.tables].sort((a, b) => {
    if (!headers) return 0;
    const want = headerSet(headers).join("|");
    return Number(headerSet(b.headers).join("|") === want) - Number(headerSet(a.headers).join("|") === want);
  });
  for (const t of tables)
    for (const l of t.sampleLinks) {
      const r = hrefRoute(l, obs.url);
      if (r && r.url.origin === origin && r.route === routeFamily) return r.url.toString();
    }
  for (const c of obs.raw.controls) {
    if (c.role !== "link" || !c.href) continue;
    const r = hrefRoute(c.href, obs.url);
    if (r && r.url.origin === origin && r.route === routeFamily) return r.url.toString();
  }
  return null;
}

function templateSegs(t: string): string[] {
  return t.split("/");
}

function paramsFrom(template: string, pathname: string): Record<string, string> {
  const out: Record<string, string> = {};
  const ts = templateSegs(template);
  const ps = pathname.split("/");
  if (ts.length !== ps.length) return out;
  ts.forEach((s, i) => {
    const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s);
    if (m) {
      try {
        out[m[1]!] = decodeURIComponent(ps[i]!);
      } catch {
        out[m[1]!] = ps[i]!;
      }
    }
  });
  return out;
}

interface Visited {
  page: PortablePage;
  obs: Observation;
  params: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------

export async function rebindCapability(args: RebindArgs): Promise<RebindResult> {
  const t0 = performance.now();
  const cap = args.capability;
  const threshold = args.threshold ?? DEFAULT_THRESHOLD;
  const timings: RebindResult["details"]["timings"] = { totalMs: 0, navigateMs: 0, observeMs: 0, matchMs: 0, compileMs: 0, perPage: [] };
  const flags: string[] = [];
  const missingRoutes: MissingRoute[] = [];
  const fingerprints: FingerprintCheck[] = [];
  const paramValues: Record<string, Record<string, string>> = {};
  const bindingsList: Binding[] = [];
  const bindings = new Map<string, string>();
  const models: AppModel[] = [];
  let pagesVisited = 0;

  const structuralWrites: string[] = [];
  const relabeled: RebindResult["details"]["relabeled"] = [];
  const done = (outcome: CompatibilityOutcome, extra: { plan?: DslPlan; program?: ExecutionProgram | null; issues?: Issue[]; writesSafe?: boolean } = {}): RebindResult => {
    timings.totalMs = Math.round(performance.now() - t0);
    const unbound = bindingsList.filter((b) => !b.localId && !b.reason?.startsWith("ambiguous")).map((b) => ({ key: b.key, reason: b.reason ?? "unbound" }));
    const ambiguous = bindingsList.filter((b) => !b.localId && b.reason?.startsWith("ambiguous")).map((b) => b.key);
    const fpMatch = fingerprints.reduce((n, f) => n + (f.page ? 1 : 0) + f.regions.filter((r) => r.match).length, 0);
    const fpMismatch = fingerprints.reduce((n, f) => n + (f.page ? 0 : 1) + f.regions.filter((r) => !r.match).length, 0);
    for (const m of missingRoutes) unbound.push(...cap.controls.filter((c) => c.app === m.app && c.routeFamily === m.routeFamily && !unbound.some((u) => u.key === c.key)).map((c) => ({ key: c.key, reason: `route ${m.routeFamily} unavailable: ${m.reason}` })));
    return {
      report: {
        outcome,
        bound: bindings.size,
        unbound,
        ambiguous,
        writesSafe: extra.writesSafe ?? false,
        writeCanary: (extra.writesSafe ?? false) && structuralWrites.length > 0,
        pagesVisited,
        ms: timings.totalMs,
        fingerprintMatches: fpMatch,
        fingerprintMismatches: fpMismatch,
      },
      plan: extra.plan ?? cap.procedure.plan,
      models,
      bindings,
      program: extra.program ?? null,
      issues: extra.issues ?? [],
      details: { bindings: bindingsList, flags, structuralWrites, relabeled, missingRoutes, fingerprints, paramValues, timings },
    };
  };

  // ---- origins: every capability app must be bound to exactly its declared origin
  const appByName = new Map(args.apps.map((a) => [a.name, a]));
  const bound: AppBinding[] = [];
  for (const a of cap.applications) {
    const local = appByName.get(a.name);
    let localOrigin: string | null = null;
    try {
      localOrigin = local ? new URL(local.origin).origin : null;
    } catch {
      localOrigin = null;
    }
    if (!local || localOrigin !== a.origin || !cap.requirements.allowedOrigins.includes(a.origin)) {
      flags.push(`origin:${a.name}`);
      missingRoutes.push(...a.routeFamilies.map((routeFamily) => ({ app: a.name, routeFamily, reason: local ? `bound to ${localOrigin ?? "an invalid origin"}, capability requires ${a.origin}` : "app not bound by the caller" })));
    } else bound.push({ name: a.name, origin: a.origin });
  }
  if (flags.length) return done("INCOMPATIBLE");

  // ---- declared role class
  for (const a of cap.applications) {
    const declared = typeof args.sessionRoleClass === "string" ? args.sessionRoleClass : args.sessionRoleClass?.[a.name];
    if (declared && a.roleClass && declared !== a.roleClass) flags.push(`role-class:${a.name}:${declared}!=${a.roleClass}`);
  }

  // ---- targeted mini-crawl (mutation-blocked)
  const recordFields = cap.intent.inputSchema.recordFields;
  const record = args.records?.[0];
  const navTimeout = args.navTimeoutMs ?? 15_000;
  const ctx = await args.browser.newContext({ allowedOrigins: bound.map((a) => a.origin), blockMutations: true, storageState: args.storageState });
  const observationsByApp = new Map<string, Visited[]>();
  const loads = new Map<string, Map<string, number[]>>();
  const tableHeadersOf = (key: string | undefined) => (key ? cap.controls.find((c) => c.key === key)?.headers : undefined);
  let blockedMutations = 0;
  try {
    // Apps are crawled concurrently, one page each, so no origin sees more than one navigation at
    // a time. Each crawl reads and writes only its own app's state; the lists it reports are merged
    // in capability order afterwards, so the result doesn't depend on which app finishes first.
    const crawl = async (app: PortableCapability["applications"][number]) => {
      const page = await ctx.newPage();
      page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
      const own = { missingRoutes: [] as MissingRoute[], flags: [] as string[], perPage: [] as typeof timings.perPage };
      const origin = app.origin;
      const visited: Visited[] = [];
      const appLoads = new Map<string, number[]>();
      observationsByApp.set(app.name, visited);
      loads.set(app.name, appLoads);
      const pages = cap.pages.filter((p) => p.app === app.name);
      const missing = new Set<string>();

      const resolve = (pg: PortablePage): string | null => {
        const segs = templateSegs(pg.pathTemplate);
        const out: string[] = [];
        for (let i = 0; i < segs.length; i++) {
          const m = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(segs[i]!);
          if (!m) {
            out.push(segs[i]!);
            continue;
          }
          const name = m[1]!;
          // A param proven on a visited page whose template agrees on every segment up to it wins;
          // otherwise a record field of the same name supplies it.
          let v: string | undefined = visited.find((x) => templateSegs(x.page.pathTemplate).slice(0, i + 1).join("/") === segs.slice(0, i + 1).join("/"))?.params[name];
          const rv = record?.[name];
          if (v === undefined && recordFields.includes(name) && (typeof rv === "string" || typeof rv === "number")) v = String(rv);
          if (v === undefined) return null;
          out.push(encodeURIComponent(v));
        }
        return origin + out.join("/");
      };

      /** Navigate and check where we landed. Login redirects and 401/403 are permission signals. */
      const tryNavigate = async (pg: PortablePage, url: string): Promise<{ ok: true; finalUrl: string; navMs: number; tNav: number } | { ok: false; reason: string; permission: boolean }> => {
        const tNav = performance.now();
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout }).catch(() => null);
        const navMs = performance.now() - tNav;
        await settle(page, { maxMs: 2500 });
        timings.navigateMs += performance.now() - tNav;
        pagesVisited++;
        const finalUrl = page.url();
        let finalRoute = "";
        try {
          finalRoute = new URL(finalUrl).origin === origin ? routePattern(finalUrl) : "";
        } catch {
          finalRoute = "";
        }
        const status = resp?.status() ?? 0;
        if (resp && status < 400 && finalRoute === pg.routeFamily) return { ok: true, finalUrl, navMs, tNav };
        const permission = status === 401 || status === 403 || finalRoute === "/login";
        const reason = !resp ? "navigation failed" : status >= 400 ? `HTTP ${status}${permission ? " (session lacks permission)" : ""}` : finalRoute === "/login" ? "redirected to /login (session lacks access)" : `landed on ${finalRoute || "another origin"}`;
        return { ok: false, reason, permission };
      };

      const visit = async (pg: PortablePage, depth: number): Promise<void> => {
        args.signal?.throwIfAborted();
        if (visited.some((v) => v.page.routeFamily === pg.routeFamily) || missing.has(pg.routeFamily)) return;
        const fail = (reason: string, permission = false) => {
          missing.add(pg.routeFamily);
          own.missingRoutes.push({ app: app.name, routeFamily: pg.routeFamily, reason });
          if (permission) own.flags.push(`permission:${app.name}:${pg.routeFamily}`);
        };
        /** A concrete instance found by browsing: the reach-via page's list table, then any observed link. */
        const discover = async (): Promise<string | null> => {
          if (pg.reachVia && depth < 4) {
            const viaRoute = pg.reachVia.routeFamily;
            const via = pages.find((q) => q.routeFamily === viaRoute) ?? (viaRoute.includes(":id") ? undefined : { app: app.name, routeFamily: viaRoute, pathTemplate: viaRoute, pageFingerprint: "", regionFingerprints: {} });
            if (via) await visit(via, depth + 1);
            const vo = visited.find((v) => v.page.routeFamily === viaRoute);
            const l = vo ? linkTo(vo.obs, pg.routeFamily, origin, tableHeadersOf(pg.reachVia.tableKey)) : null;
            if (l) return l;
          }
          for (const v of visited) {
            const l = linkTo(v.obs, pg.routeFamily, origin);
            if (l) return l;
          }
          return null;
        };
        // Record values / shared params first; if that instance does not exist here, browse for one.
        const first = resolve(pg);
        let nav = first ? await tryNavigate(pg, first) : null;
        if (nav && !nav.ok && nav.permission) return fail(nav.reason, true);
        if (!nav?.ok) {
          const found = await discover();
          if (found && found !== first) nav = await tryNavigate(pg, found);
        }
        if (!nav) return fail("no concrete instance found (no record value for its params and no observed link to it)");
        if (!nav.ok) return fail(nav.reason, nav.permission);
        const { finalUrl, navMs, tNav } = nav;
        const tObs = performance.now();
        let obs = await observe(page);
        if (await clearDialogs(page, obs)) {
          await settle(page, { maxMs: 1000 });
          obs = await observe(page);
        }
        obs.metrics.navMs = Math.round(navMs);
        timings.observeMs += performance.now() - tObs;
        own.perPage.push({ app: app.name, routeFamily: pg.routeFamily, ms: Math.round(performance.now() - tNav) });
        (appLoads.get(obs.routePattern) ?? appLoads.set(obs.routePattern, []).get(obs.routePattern)!).push(navMs);
        const params = paramsFrom(pg.pathTemplate, new URL(finalUrl).pathname);
        visited.push({ page: pg, obs, params });
        if (Object.keys(params).length) paramValues[app.name] = { ...(paramValues[app.name] ?? {}), ...params };
      };

      const ordered = [...pages].sort((a, b) => Number(a.routeFamily.includes(":id")) - Number(b.routeFamily.includes(":id")) || a.routeFamily.split("/").length - b.routeFamily.split("/").length || a.routeFamily.localeCompare(b.routeFamily));
      for (const pg of ordered) await visit(pg, 0);
      return own;
    };
    const crawls = await Promise.allSettled(cap.applications.map(crawl));
    for (const c of crawls) if (c.status === "rejected") throw c.reason;
    for (const c of crawls) {
      if (c.status !== "fulfilled") continue;
      missingRoutes.push(...c.value.missingRoutes);
      flags.push(...c.value.flags);
      timings.perPage.push(...c.value.perPage);
    }
  } finally {
    blockedMutations = args.browser.guardStats.get(ctx)?.blockedMutations ?? 0;
    await ctx.close().catch(() => undefined);
  }

  // ---- fresh local models from this runtime's own observations
  for (const app of bound) {
    const visited = observationsByApp.get(app.name) ?? [];
    models.push(buildAppModel(app, visited.map((v) => v.obs), loads.get(app.name) ?? new Map(), performance.now() - t0, blockedMutations));
  }
  if (missingRoutes.length) return done("INCOMPATIBLE");

  // ---- fingerprints
  for (const p of cap.pages) {
    const m = models.find((x) => x.app === p.app);
    const lp = m ? pageOf(m, p.routeFamily) : undefined;
    if (!m || !lp) continue;
    const local = regionMap(m, lp);
    fingerprints.push({ app: p.app, routeFamily: p.routeFamily, page: lp.fingerprint === p.pageFingerprint, regions: Object.entries(p.regionFingerprints).map(([key, v]) => ({ key, match: local[key] === v })) });
  }

  // ---- bind every portable control
  const tMatch = performance.now();
  const descriptorCache = new Map<string, LocalCandidate[]>();
  const candidatesFor = (pc: PortableControl): LocalCandidate[] => {
    const k = `${pc.app}\u0000${pc.routeFamily}\u0000${pc.kind}`;
    let list = descriptorCache.get(k);
    if (!list) {
      const m = models.find((x) => x.app === pc.app);
      list = m
        ? Object.values(m.controls)
            .filter((c) => c.page === pc.routeFamily && c.kind === pc.kind)
            .map((c) => ({ control: c, descriptor: describeControl(c, m) }))
        : [];
      descriptorCache.set(k, list);
    }
    return list;
  };
  for (const pc of cap.controls) bindingsList.push(matchControl(pc, candidatesFor(pc), threshold));
  // One local control can back only one portable control.
  const owners = new Map<string, string[]>();
  for (const b of bindingsList) if (b.localId) (owners.get(b.localId) ?? owners.set(b.localId, []).get(b.localId)!).push(b.key);
  for (const b of bindingsList) {
    if (b.localId && (owners.get(b.localId)?.length ?? 0) > 1) {
      b.reason = `ambiguous: local control is also the best match for ${owners.get(b.localId)!.filter((k) => k !== b.key).join(", ")}`;
      b.localId = null;
      b.evidence = "none";
    }
  }
  for (const b of bindingsList) if (b.localId) bindings.set(b.key, b.localId);
  timings.matchMs = Math.round(performance.now() - tMatch);

  // ---- write safety signals
  const pcByKey = new Map(cap.controls.map((c) => [c.key, c]));
  const bindingOf = new Map(bindingsList.map((b) => [b.key, b]));
  const localOf = (key: string): { c: AppControl; d: ControlDescriptor; m: AppModel } | null => {
    const id = bindings.get(key);
    const pc = pcByKey.get(key);
    const m = pc ? models.find((x) => x.app === pc.app) : undefined;
    const c = id && m ? m.controls[id] : undefined;
    return c && m ? { c, d: describeControl(c, m), m } : null;
  };
  const writeCritical = new Set<string>();
  const submits = submitContexts(cap.procedure.plan);
  for (const sc of submits) {
    writeCritical.add(sc.step.control);
    for (const f of sc.fills) writeCritical.add(f.control);
    for (const g of sc.step.guards) writeCritical.add(g.control);
  }
  for (const sc of submits) {
    const declared = cap.requirements.expectedEffects.filter((e) => e.stepId === sc.step.id).map((e) => e.effect);
    const local = localOf(sc.step.control);
    if (local) {
      const localEffect = sc.step.irreversible || local.c.effectGuess === "irreversible" ? "irreversible" : local.c.effectGuess;
      if (!isWriteEffect(local.c.effectGuess) || declared.some((e) => e !== localEffect)) flags.push(`effect-mismatch:${sc.step.control}`);
      if (isDisabled(local.c, observationsByApp.get(local.c.app) ?? [])) flags.push(`submit-disabled:${sc.step.control}`);
    }
    for (const f of sc.fills) {
      const pc = pcByKey.get(f.control);
      const lf = localOf(f.control);
      if (pc && lf && (lf.d.tabPanel ?? "") !== (pc.tabPanel ?? "")) flags.push(`hidden-in-tab:${f.control}`);
      if (lf && isDisabled(lf.c, observationsByApp.get(lf.c.app) ?? [])) flags.push(`field-disabled:${f.control}`);
    }
  }

  // A submit button that bound structurally (sole write button of a form with the identical field
  // schema) may carry writes only when every field and guard of its writes bound by label and none
  // is irreversible. The label changed, the form did not; the executor then requires a write canary.
  for (const sc of submits) {
    const b = bindingOf.get(sc.step.control);
    if (b?.evidence !== "structural" || sc.step.irreversible) continue;
    if (cap.requirements.expectedEffects.some((e) => e.stepId === sc.step.id && e.effect === "irreversible")) continue;
    const sameKey = submits.filter((x) => x.step.control === sc.step.control);
    const fieldsByLabel = sameKey.every((x) => [...x.fills.map((f) => f.control), ...x.step.guards.map((g) => g.control)].every((k) => bindingOf.get(k)?.evidence === "label"));
    if (fieldsByLabel && !structuralWrites.includes(sc.step.control)) structuralWrites.push(sc.step.control);
  }
  for (const b of bindingsList) {
    if (!b.localId || b.evidence === "label") continue;
    const pc = pcByKey.get(b.key);
    const lc = localOf(b.key);
    if (pc && lc) relabeled.push({ key: b.key, from: primaryText(pc), to: primaryText(lc.d), evidence: b.evidence });
  }

  // ---- rewrite to fresh local ids and compile against the local models
  const plan = mapControlRefs(cap.procedure.plan, (ref) => bindings.get(ref) ?? ref);
  const tCompile = performance.now();
  const lowered = lowerPlan({ plan, models, apps: bound, goal: cap.intent.description, inputs: { records: args.records ?? [] }, programId: `net-${cap.capabilityId}-v${cap.version}`, strategyId: `${cap.capabilityId}@${cap.version}` });
  const issues = [...lowered.issues, ...validateProgram(lowered.program)];
  timings.compileMs = Math.round(performance.now() - tCompile);
  const compiled = !hasErrors(issues);

  // ---- outcome
  const unboundOrAmbiguous = bindingsList.some((b) => !b.localId);
  const permission = flags.some((f) => f.startsWith("permission:") || f.startsWith("role-class:") || f.startsWith("submit-disabled:") || f.startsWith("field-disabled:"));
  const needsRepair = flags.some((f) => f.startsWith("hidden-in-tab:") || f.startsWith("effect-mismatch:"));
  const fuzzy = bindingsList.some((b) => b.localId && b.evidence !== "label");
  const fpMismatch = fingerprints.some((f) => !f.page || f.regions.some((r) => !r.match));
  let outcome: CompatibilityOutcome;
  if (permission) outcome = "INCOMPATIBLE";
  else if (unboundOrAmbiguous || !compiled || needsRepair) outcome = "REQUIRES_REPAIR";
  else if (fuzzy) outcome = "REQUIRES_REBINDING";
  else if (fpMismatch) outcome = "STRUCTURALLY_COMPATIBLE";
  else outcome = "EXACT_COMPATIBLE";

  // Writes are safe only on unique, label-level bindings with matching declared effects, plus the
  // structurally bound submit buttons above (which put the writes behind a write canary).
  const writesSafe =
    submits.length === 0 ||
    ((outcome === "EXACT_COMPATIBLE" || outcome === "STRUCTURALLY_COMPATIBLE" || outcome === "REQUIRES_REBINDING") &&
      [...writeCritical].every((k) => bindingOf.get(k)?.localId && (bindingOf.get(k)?.evidence === "label" || structuralWrites.includes(k))) &&
      !flags.length &&
      compiled);

  return done(outcome, { plan, program: compiled ? lowered.program : null, issues, writesSafe });
}

function isDisabled(c: AppControl, visited: Visited[]): boolean {
  const ev = c.locator.evidence[0];
  if (!ev) return false;
  const obs = visited.find((v) => v.obs.id === ev.observationId)?.obs;
  return obs?.controls.find((x) => x.id === ev.controlId)?.disabled === true;
}
