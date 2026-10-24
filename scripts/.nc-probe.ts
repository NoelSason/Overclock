import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena } from "@overclock/arena";
import { BrowserManager, SessionManager } from "@overclock/browser-runtime";
import { crawlApp } from "@overclock/discovery";
const dir = mkdtempSync(join(tmpdir(), "oc-nc-probe-"));
const arena = await startArena({ ports: { CRM: 0, Orders: 0, Support: 0 }, adminPort: 0, dataDir: dir, defaultScenario: { seed: 7, template: "t1-order-reconcile", records: 5 } });
const browser = new BrowserManager({ headless: true });
const sessions = new SessionManager(browser, () => ({ username: "operator", password: "overclock-arena" }));
try {
  for (const name of ["Orders", "Support"] as const) {
    const app = { name, origin: arena.origins[name] };
    const ss = await sessions.storageStateFor([app]);
    const t = performance.now();
    const { model } = await crawlApp({ browser, app, storageState: ss });
    console.log(`== ${name} crawl ${Math.round(performance.now() - t)}ms pages=${model.pages.length}`);
    for (const p of model.pages) {
      console.log(`  PAGE ${p.routePattern} fp=${p.fingerprint} forms=${JSON.stringify(p.forms.map(f=>({m:f.method, n:f.fieldIds.length, s:f.submitIds})))}`);
      for (const id of p.controlIds) { const c = model.controls[id]!; console.log(`    ${c.kind.padEnd(10)} ${id}  name=${JSON.stringify(c.name)} label=${JSON.stringify(c.label)} param=${c.param} effect=${c.effectGuess} form=${c.formId} strat=${c.locator.strategies.map(s=>s.kind).join(",")}`); }
    }
  }
  console.log(JSON.stringify(arena.manager.publicScenario()?.records));
} finally { await browser.close(); await arena.close(); rmSync(dir, { recursive: true, force: true }); }
