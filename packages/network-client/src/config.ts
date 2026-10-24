import { KnowledgePolicy, type NetworkConfig } from "@overclock/network-contracts";

export const DEFAULT_NETWORK_ENDPOINT = "ws://127.0.0.1:3100";
export const DEFAULT_NETWORK_DATABASE = "overclock-network";
export const DEFAULT_LOOKUP_TIMEOUT_MS = 500;

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Network config from environment variables. Disabled unless OVERCLOCK_NETWORK_ENABLED is set.
 * `dataDir` is the runtime's own state directory (token and artifact cache live under it).
 */
export function networkConfigFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  const mode = KnowledgePolicy.safeParse(env["OVERCLOCK_NETWORK_MODE"]?.trim());
  return {
    enabled: parseBool(env["OVERCLOCK_NETWORK_ENABLED"], false),
    endpoint: env["OVERCLOCK_NETWORK_ENDPOINT"]?.trim() || DEFAULT_NETWORK_ENDPOINT,
    database: env["OVERCLOCK_NETWORK_DATABASE"]?.trim() || DEFAULT_NETWORK_DATABASE,
    mode: mode.success ? mode.data : "network-read",
    publishEnabled: parseBool(env["OVERCLOCK_NETWORK_PUBLISH_ENABLED"], false),
    lookupTimeoutMs: parsePositiveInt(env["OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS"], DEFAULT_LOOKUP_TIMEOUT_MS),
    dataDir,
    runtimeLabel: env["OVERCLOCK_RUNTIME_LABEL"]?.trim() || "runtime",
  };
}
