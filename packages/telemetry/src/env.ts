import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

let loaded = false;

/** Load the nearest `.env` walking up from `start` (default cwd). Existing env vars win. */
export function loadEnv(start: string = process.cwd()): string | null {
  if (loaded) return null;
  loaded = true;
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Repository root: the nearest ancestor containing pnpm-workspace.yaml. */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
