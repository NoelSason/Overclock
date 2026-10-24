// Temporary diagnostic (deleted after use): do form saves persist through the Stagehand session setup?
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena } from "@overclock/arena";
import { arenaCredentialsFromEnv, loadFramework, openStagehandSession } from "./src/index";

const dir = mkdtempSync(join(tmpdir(), "oc-probe-"));
const arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 101, template: "t1-order-reconcile", records: 3 } });
const s = arena.manager.publicScenario()!;
const session = await openStagehandSession({ framework: await loadFramework(), applications: s.applications, credentials: arenaCredentialsFromEnv(), model: "claude-haiku-5-5", apiKey: "unused" });
try {
  const orders = s.applications.find((a) => a.name === "Orders")!.origin;
  const support = s.applications.find((a) => a.name === "Support")!.origin;
  // 1. Playwright page: text field + submit.
  const page = session.context.pages()[0]!;
  await page.goto(`${orders}/orders/ORD-51065/edit`);
  await page.getByLabel("Customer ID").fill("C-1316");
  await Promise.all([page.waitForEvent("domcontentloaded"), page.getByRole("button", { name: "Update order" }).click()]);
  console.log("playwright fill+submit ->", page.url(), "store:", arena.store.orders.get("ORD-51065")!.customer_id);
  // 2. Stagehand's own page/locator API: select + submit on a ticket.
  const sp = await session.stagehand.context.awaitActivePage();
  await sp.goto(`${support}/tickets/TCK-72206/edit`);
  const before = arena.store.support.get("TCK-72206")!;
  console.log("ticket before:", before.status, before.category);
  const selects = await sp.evaluate(() => [...document.querySelectorAll("select")].map((el) => ({ name: el.name, options: [...el.options].map((o) => `${o.value}|${o.text}`) })));
  console.log("selects:", JSON.stringify(selects));
  await sp.locator("select[name=status]").selectOption("resolved");
  await sp.locator("#edit-form button[type=submit]").click();
  await sp.waitForLoadState("domcontentloaded").catch(() => undefined);
  await new Promise((r) => setTimeout(r, 1000));
  const after = arena.store.support.get("TCK-72206")!;
  console.log("stagehand select+submit ->", sp.url(), "store status:", after.status);
  console.log("guard:", session.guard.requests, "requests,", session.guard.blocked, "blocked");
} finally {
  await session.close();
  await arena.close();
  rmSync(dir, { recursive: true, force: true });
}
