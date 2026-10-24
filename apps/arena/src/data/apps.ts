import { HOLDOUT_APP, type HoldoutApp } from "../holdout/meta";

/** The arena's applications. The three classic apps are server-rendered; the fourth is the holdout. */

export type ClassicApp = "CRM" | "Orders" | "Support";
export type AppName = ClassicApp | HoldoutApp;

export const CLASSIC_APPS: readonly ClassicApp[] = ["CRM", "Orders", "Support"];
export const APP_NAMES: readonly AppName[] = [...CLASSIC_APPS, HOLDOUT_APP];

export function isAppName(v: unknown): v is AppName {
  return typeof v === "string" && (APP_NAMES as readonly string[]).includes(v);
}
