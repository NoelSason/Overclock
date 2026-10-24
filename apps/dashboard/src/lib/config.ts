/** Engine and arena endpoints. NEXT_PUBLIC_* values are inlined at build time. */
export const ENGINE_URL = trimSlash(process.env.NEXT_PUBLIC_OVERCLOCK_URL ?? "http://127.0.0.1:4000");
export const ARENA_ADMIN_URL = trimSlash(process.env.NEXT_PUBLIC_ARENA_ADMIN_URL ?? "http://127.0.0.1:4100");

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Resolve a path the engine hands out (e.g. a worker thumbnail) against the engine base URL. */
export function engineAsset(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  return `${ENGINE_URL}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
}
