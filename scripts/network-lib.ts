/**
 * Shared helpers for the Overclock Network scripts and tests: locating the `spacetime` CLI,
 * starting a local server, publishing the module, generating bindings, and calling reducers as
 * the database owner. CLI output is filtered so auth tokens are never echoed.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MODULE_PATH = join(REPO_ROOT, "services", "network", "spacetimedb");
export const BINDINGS_DIR = join(REPO_ROOT, "packages", "network-client", "src", "generated");
export const NETWORK_STATE_DIR = join(REPO_ROOT, ".data", "network");

export const LOCAL_ENDPOINT = "ws://127.0.0.1:3000";
export const MAINCLOUD_ENDPOINT = "https://maincloud.spacetimedb.com";

/** `SPACETIME_BIN`, else the official installer location, else `spacetime` on PATH. */
export function spacetimeBin(): string {
  const fromEnv = process.env["SPACETIME_BIN"];
  if (fromEnv) return fromEnv;
  const installed = join(homedir(), ".local", "bin", "spacetime");
  return existsSync(installed) ? installed : "spacetime";
}

/** HTTP base URL for an endpoint (ws -> http, wss -> https). */
export function httpBase(endpoint: string): string {
  const u = new URL(endpoint);
  const protocol = u.protocol === "ws:" ? "http:" : u.protocol === "wss:" ? "https:" : u.protocol;
  return `${protocol}//${u.host}`;
}

/** CLI `--server` value: the configured nickname when one matches, else the HTTP URL. */
export function cliServerFor(endpoint: string): string {
  const base = httpBase(endpoint);
  if (base === "http://127.0.0.1:3000" || base === "http://localhost:3000") return "local";
  if (base === MAINCLOUD_ENDPOINT) return "maincloud";
  return base;
}

export function isLocalEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Drop any line that mentions a token so CLI output can be printed safely. */
export function redact(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/token/i.test(line))
    .join("\n")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "[redacted]");
}

export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd ?? REPO_ROOT, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout: redact(stdout), stderr: redact(stderr) });
    });
  });
}

export async function spacetime(args: string[], opts: { timeoutMs?: number; allowFail?: boolean } = {}): Promise<RunResult> {
  const r = await run(spacetimeBin(), args, { timeoutMs: opts.timeoutMs ?? 180_000 });
  if (r.code !== 0 && !opts.allowFail) {
    throw new Error(`spacetime ${args.filter((a) => !a.startsWith("0x")).slice(0, 3).join(" ")} failed (exit ${r.code}):\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return r;
}

export async function ensureCli(): Promise<void> {
  try {
    const r = await run(spacetimeBin(), ["--version"], { timeoutMs: 20_000 });
    if (r.code === 0) return;
  } catch {
    // fall through
  }
  throw new Error("The spacetime CLI is not installed. Install it with:\n  curl -sSf https://install.spacetimedb.com | sh -s -- -y");
}

export async function pingServer(endpoint: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${httpBase(endpoint)}/v1/ping`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Make sure a local SpacetimeDB server answers on `endpoint`, starting `spacetime start` in the
 * background (logs in .data/network/spacetime-server.log) when it does not.
 */
export async function ensureLocalServer(endpoint = LOCAL_ENDPOINT): Promise<{ started: boolean }> {
  if (await pingServer(endpoint)) return { started: false };
  if (!isLocalEndpoint(endpoint)) throw new Error(`${endpoint} is not reachable and is not a local endpoint`);
  await ensureCli();
  mkdirSync(NETWORK_STATE_DIR, { recursive: true });
  const log = openSync(join(NETWORK_STATE_DIR, "spacetime-server.log"), "a");
  const u = new URL(endpoint);
  const listen = `${u.hostname === "localhost" ? "127.0.0.1" : u.hostname}:${u.port || "3000"}`;
  const child = spawn(spacetimeBin(), ["start", "--listen-addr", listen, "--non-interactive"], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await pingServer(endpoint, 500)) return { started: true };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`SpacetimeDB did not come up on ${listen}; see .data/network/spacetime-server.log`);
}

/** Install the module's own dependencies (it is built by the spacetime CLI, outside the workspace). */
export async function ensureModuleDeps(): Promise<void> {
  if (existsSync(join(MODULE_PATH, "node_modules", "spacetimedb")) && existsSync(join(MODULE_PATH, "node_modules", "typescript"))) return;
  const r = await run("pnpm", ["install", "--ignore-workspace", "--frozen-lockfile"], { cwd: MODULE_PATH, timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`installing module dependencies failed:\n${(r.stderr || r.stdout).slice(-2000)}`);
}

export async function publishModule(o: { database: string; server: string; clean?: boolean }): Promise<string> {
  await ensureModuleDeps();
  const args = ["publish", o.database, "--server", o.server, "--module-path", MODULE_PATH, "--yes", "--no-config"];
  if (o.clean) args.push("--delete-data=always");
  const r = await spacetime(args, { timeoutMs: 300_000 });
  return `${r.stdout}\n${r.stderr}`;
}

export async function deleteDatabase(o: { database: string; server: string }): Promise<boolean> {
  const r = await spacetime(["delete", o.database, "--server", o.server, "--yes", "--no-config"], { allowFail: true, timeoutMs: 60_000 });
  return r.code === 0;
}

export async function generateBindings(): Promise<void> {
  await ensureModuleDeps();
  await spacetime(["generate", "--lang", "typescript", "--out-dir", BINDINGS_DIR, "--module-path", MODULE_PATH, "--yes", "--no-config"], { timeoutMs: 300_000 });
}

/** Call a reducer with the CLI identity (the database owner, bootstrapped as admin by `init`). */
export async function callAsOwner(o: { database: string; server: string; reducer: string; args: string[] }): Promise<void> {
  await spacetime(["call", "--server", o.server, "--yes", "--no-config", o.database, o.reducer, ...o.args], { timeoutMs: 60_000 });
}

/** Authorize `identityHex` with `role` as the database owner. */
export async function authorizeAsOwner(o: { database: string; server: string; identityHex: string; role: string }): Promise<void> {
  const hex = o.identityHex.startsWith("0x") ? o.identityHex : `0x${o.identityHex}`;
  await callAsOwner({ database: o.database, server: o.server, reducer: "authorize_publisher", args: [hex, JSON.stringify(o.role)] });
}

/** Whether the CLI is logged in to spacetimedb.com (the token itself is never read or printed). */
export async function cliLoggedIn(): Promise<{ loggedIn: boolean; identity?: string }> {
  const r = await run(spacetimeBin(), ["login", "show"], { timeoutMs: 20_000 });
  const m = /logged in as ([0-9a-fx]+)/i.exec(r.stdout + r.stderr);
  return m ? { loggedIn: true, identity: m[1]! } : { loggedIn: false };
}

export function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq?.slice(name.length + 1);
}
