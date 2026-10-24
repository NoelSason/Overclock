import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** sha256 hex of the UTF-8 bytes of `s` (matches the module's content hash). */
export function sha256Hex(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}

export function utf8Length(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

async function writeAtomic(path: string, data: string, mode: number): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, path);
}

/**
 * Per-runtime auth token store at `<dataDir>/network-token` (mode 0600). Tokens are keyed by
 * endpoint host, because a token issued by one SpacetimeDB host is not valid on another.
 */
export class TokenStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "network-token");
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && "tokens" in parsed) {
        const tokens = (parsed as { tokens: unknown }).tokens;
        if (typeof tokens === "object" && tokens !== null) {
          return Object.fromEntries(Object.entries(tokens).filter((e): e is [string, string] => typeof e[1] === "string"));
        }
      }
      return {};
    } catch {
      return {};
    }
  }

  async load(host: string): Promise<string | undefined> {
    return (await this.readAll())[host];
  }

  async save(host: string, token: string): Promise<void> {
    const all = await this.readAll();
    if (all[host] === token) return;
    all[host] = token;
    await mkdir(dirname(this.path), { recursive: true });
    await writeAtomic(this.path, `${JSON.stringify({ version: 1, tokens: all })}\n`, 0o600);
  }
}

/** Content-addressed artifact cache at `<dataDir>/capabilities/<sha256>.json`. */
export class ArtifactCache {
  readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "capabilities");
  }

  pathFor(hash: string): string {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("artifact cache keys must be sha256 hex");
    return join(this.dir, `${hash}.json`);
  }

  /** Returns the cached payload if present and its bytes hash to `hash`; drops corrupt entries. */
  async read(hash: string): Promise<string | null> {
    const path = this.pathFor(hash);
    let data: string;
    try {
      data = await readFile(path, "utf8");
    } catch {
      return null;
    }
    if (sha256Hex(data) !== hash) {
      await rm(path, { force: true });
      return null;
    }
    return data;
  }

  async write(hash: string, payload: string): Promise<void> {
    if (sha256Hex(payload) !== hash) throw new Error("refusing to cache a payload under the wrong hash");
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(this.pathFor(hash), payload, 0o600);
  }
}
