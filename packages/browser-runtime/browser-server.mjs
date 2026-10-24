// A Playwright browser server in its own process (BrowserManager with OVERCLOCK_BROWSER_SERVERS).
// The server side of Playwright (protocol handling, frame and context tracking) then runs here,
// on its own core, instead of on the engine's main thread. Prints the WebSocket endpoint, then
// serves until the parent closes stdin, exits, or sends SIGTERM.
import { chromium } from "playwright";

// Loopback only: by default Playwright listens on every interface, guarded just by a random path.
const server = await chromium.launchServer({ headless: process.env.OVERCLOCK_HEADLESS !== "0", host: "127.0.0.1" });
process.stdout.write(`${server.wsEndpoint()}\n`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close().finally(() => process.exit(0));
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
process.stdin.on("end", close);
process.stdin.on("error", close);
process.stdin.resume();
