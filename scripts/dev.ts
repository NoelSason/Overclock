/**
 * Start the arena, the engine, and the dashboard together, with prefixed output.
 *
 *   pnpm dev
 *
 * Ctrl+C stops all three. The local Overclock Network (SpacetimeDB) is separate:
 * `pnpm network:dev` starts it when you want network knowledge policies.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { REPO_ROOT } from "./network-lib";

const SERVICES: { name: string; cmd: string; args: string[] }[] = [
  { name: "arena", cmd: process.execPath, args: ["--import", "tsx", "apps/arena/src/main.ts"] },
  { name: "engine", cmd: process.execPath, args: ["--import", "tsx", "services/engine/src/main.ts"] },
  { name: "dashboard", cmd: "pnpm", args: ["--filter", "@overclock/dashboard", "dev"] },
];

const children: ChildProcess[] = [];
let stopping = false;

function prefix(name: string, chunk: Buffer, out: NodeJS.WriteStream): void {
  for (const line of chunk.toString().split("\n")) if (line.trim()) out.write(`[${name.padEnd(9)}] ${line}\n`);
}

function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const s of SERVICES) {
  const child = spawn(s.cmd, s.args, { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => prefix(s.name, d, process.stdout));
  child.stderr?.on("data", (d: Buffer) => prefix(s.name, d, process.stderr));
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[${s.name.padEnd(9)}] exited with code ${code ?? "null"}; stopping the others`);
      stopAll(code ?? 1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
