/**
 * Where the extension keeps its connection: the engine address and the session token, in
 * chrome.storage.local, so reloading the extension or restarting the browser doesn't ask for a
 * code again. The token only works from this extension, against an engine on this computer. No
 * API keys or site credentials are ever stored: the engine holds those.
 */
export interface Connection {
  origin: string;
  token: string;
  expiresAt: number;
}

const DEFAULT_ORIGIN = "http://127.0.0.1:4000";
const hasChrome = typeof chrome !== "undefined" && !!chrome.storage;
const memory = new Map<string, unknown>();

async function read(area: "local" | "session", key: string): Promise<unknown> {
  if (!hasChrome) return memory.get(`${area}:${key}`);
  return (await chrome.storage[area].get(key))[key];
}

async function write(area: "local" | "session", key: string, value: unknown): Promise<void> {
  if (!hasChrome) {
    memory.set(`${area}:${key}`, value);
    return;
  }
  await chrome.storage[area].set({ [key]: value });
}

export async function savedOrigin(): Promise<string> {
  const v = await read("local", "engineOrigin");
  return typeof v === "string" ? v : DEFAULT_ORIGIN;
}

export async function loadConnection(): Promise<Connection | null> {
  const v = (await read("local", "connection")) as Connection | undefined;
  return v && typeof v.token === "string" && v.expiresAt > Date.now() ? v : null;
}

export async function saveConnection(c: Connection): Promise<void> {
  await write("local", "engineOrigin", c.origin);
  await write("local", "connection", c);
}

export async function clearConnection(): Promise<void> {
  if (!hasChrome) memory.delete("local:connection");
  else await chrome.storage.local.remove("connection");
}
