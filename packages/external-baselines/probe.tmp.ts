// Temporary diagnostic (deleted after use): does attaching Playwright slow or hang Stagehand screenshots?
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena } from "@overclock/arena";
import { arenaCredentialsFromEnv, installOriginGuard, loadFramework, login } from "./src/index";

const dir = mkdtempSync(join(tmpdir(), "oc-probe-"));
const arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 101, template: "t1-order-reconcile", records: 3 } });
const s = arena.manager.publicScenario()!;
const fw = await loadFramework();
const headless = process.argv[2] !== "headed";
const sh = new fw.Stagehand({ env: "LOCAL", model: { modelName: "anthropic/claude-haiku-5-5", apiKey: "unused" }, localBrowserLaunchOptions: { executablePath: fw.executablePath, headless, viewport: { width: 1280, height: 860 } }, verbose: 0, disablePino: true, logger: () => undefined });
const time = async (label: string, f: () => Promise<unknown>) => {
  const t = performance.now();
  try {
    await Promise.race([f(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 15s")), 15_000))]);
    console.log(label, Math.round(performance.now() - t), "ms");
  } catch (e) {
    console.log(label, "FAILED", (e as Error).message);
  }
};
try {
  await sh.init();
  const sp = await sh.context.awaitActivePage();
  await sp.goto(`${s.applications[0]!.origin}/login`);
  await time("screenshot, stagehand only:", () => sp.screenshot());
  const pw = await fw.chromium.connectOverCDP(sh.connectURL());
  const ctx = pw.contexts()[0]!;
  await time("screenshot, playwright attached:", () => sp.screenshot());
  await installOriginGuard(ctx, s.applications.map((a) => a.origin));
  await time("screenshot, guard installed:", () => sp.screenshot());
  await login(ctx.pages()[0]!, s.applications, arenaCredentialsFromEnv());
  await sp.goto(`${s.applications[1]!.origin}/orders`);
  await time("screenshot, after login + goto:", () => sp.screenshot());
  await sp.goto(`${s.applications[2]!.origin}/tickets/TCK-72206/edit`);
  await time("screenshot, ticket edit page:", () => sp.screenshot());
  await pw.close();
} finally {
  await sh.close();
  await arena.close();
  rmSync(dir, { recursive: true, force: true });
}
