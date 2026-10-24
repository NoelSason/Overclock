import { VariationConfig } from "@overclock/contracts";

/**
 * Live UI/infra variations. The judge changes these mid-run; every app request reads the
 * current config, so a change applies from the next request on.
 */

export type AppName = "CRM" | "Orders" | "Support";
export const APP_NAMES: readonly AppName[] = ["CRM", "Orders", "Support"];

export function isAppName(v: unknown): v is AppName {
  return v === "CRM" || v === "Orders" || v === "Support";
}

export const SURPRISE_KINDS = [
  "rename-save",
  "confirm-modal",
  "announcement",
  "latency",
  "partial-failure",
  "fields-in-tab",
  "shuffle-fields",
  "concurrency-limit",
  "clear",
] as const;
export type SurpriseKind = (typeof SURPRISE_KINDS)[number];

export function isSurpriseKind(v: unknown): v is SurpriseKind {
  return typeof v === "string" && (SURPRISE_KINDS as readonly string[]).includes(v);
}

/** Edit-form submit buttons and the text the "rename-save" surprise gives them. */
export const SAVE_BUTTON_RENAMES: Record<AppName, { from: string; to: string }> = {
  CRM: { from: "Save changes", to: "Update record" },
  Orders: { from: "Update order", to: "Apply changes" },
  Support: { from: "Save ticket", to: "Commit ticket" },
};

const PER_APP_KEYS = ["renameButtons", "shuffleFields", "confirmModal", "announcementModal", "pageSize", "editInTab", "latency", "failures", "concurrencyLimit"] as const;

export function defaultVariations(): VariationConfig {
  return VariationConfig.parse({});
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep merge for PATCH: objects merge recursively, other values replace, `null` deletes the key. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (v === null) delete out[k];
    else out[k] = deepMerge(out[k], v);
  }
  return out;
}

export class VariationStore {
  private cfg: VariationConfig = defaultVariations();
  /** Bumped whenever an app's announcement is switched on, so it reappears for existing sessions. */
  private readonly epochs: Record<AppName, number> = { CRM: 0, Orders: 0, Support: 0 };

  get(): VariationConfig {
    return this.cfg;
  }

  /** Replace the whole config. Throws a ZodError when the input is invalid. */
  set(input: unknown): VariationConfig {
    const next = VariationConfig.parse(input);
    for (const app of APP_NAMES) if (!this.cfg.announcementModal[app] && next.announcementModal[app]) this.epochs[app]++;
    this.cfg = next;
    return next;
  }

  patch(patch: unknown): VariationConfig {
    return this.set(deepMerge(structuredClone(this.cfg), patch));
  }

  reset(): VariationConfig {
    return this.set({});
  }

  announcementEpoch(app: AppName): number {
    return this.epochs[app];
  }
}

/** Preset surprises for the judge console. Returns a new config; does not mutate the input. */
export function applySurprise(cfg: VariationConfig, kind: SurpriseKind, target: AppName | "all"): VariationConfig {
  if (kind === "clear" && target === "all") return defaultVariations();
  const next = structuredClone(cfg);
  const apps = target === "all" ? APP_NAMES : [target];
  for (const app of apps) {
    switch (kind) {
      case "rename-save": {
        const r = SAVE_BUTTON_RENAMES[app];
        next.renameButtons[app] = { ...(next.renameButtons[app] ?? {}), [r.from]: r.to };
        break;
      }
      case "confirm-modal":
        next.confirmModal[app] = true;
        break;
      case "announcement":
        next.announcementModal[app] = true;
        break;
      case "latency":
        next.latency[app] = { baseMs: 250, jitterMs: 250, slowRate: 0.1, slowMs: 2000 };
        break;
      case "partial-failure":
        next.failures[app] = { beforeCommitRate: 0.1, afterCommitRate: 0.1 };
        break;
      case "fields-in-tab":
        next.editInTab[app] = true;
        break;
      case "shuffle-fields":
        next.shuffleFields[app] = 1 + Math.floor(Math.random() * 999_999);
        break;
      case "concurrency-limit":
        next.concurrencyLimit[app] = 6;
        break;
      case "clear":
        for (const key of PER_APP_KEYS) delete (next[key] as Record<string, unknown>)[app];
        break;
    }
  }
  return next;
}

/** Response delay for one request under the app's latency variation (0 when none). */
export function latencyFor(cfg: VariationConfig, app: AppName): number {
  const l = cfg.latency[app];
  if (!l) return 0;
  const slow = l.slowRate > 0 && Math.random() < l.slowRate ? l.slowMs : 0;
  return Math.max(0, l.baseMs + Math.random() * l.jitterMs + slow);
}

export function renameFor(cfg: VariationConfig, app: AppName): (text: string) => string {
  const map = cfg.renameButtons[app] ?? {};
  return (text) => map[text] ?? text;
}
