import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager, readControl, resolveLocator } from "@overclock/browser-runtime";
import { observe, routePattern, toAppControls } from "@overclock/perception";
import { startMiniApp, type MiniApp } from "../fixtures/mini-app";

let app: MiniApp;
let browser: BrowserManager;
beforeAll(async () => {
  app = await startMiniApp();
  browser = new BrowserManager({ headless: true });
});
afterAll(async () => {
  await browser.close();
  await app.close();
});

describe("perception", () => {
  it("infers route patterns", () => {
    expect(routePattern("http://x/orders/ORD-50012/edit?x=1")).toBe("/orders/:id/edit");
    expect(routePattern("http://x/customers?page=2")).toBe("/customers");
    expect(routePattern("http://x/items/I-7")).toBe("/items/:id");
  });

  it("builds evidence-backed controls whose locators resolve uniquely", async () => {
    const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
    const page = await ctx.newPage();
    await page.goto(`${app.origin}/items/I-3/edit`);
    const obs = await observe(page);
    expect(obs.routePattern).toBe("/items/:id/edit");
    const controls = toAppControls("mini", obs);
    const status = controls.find((c) => c.kind === "select")!;
    expect(status.label).toBe("Status");
    expect(status.options?.map((o) => o.value)).toEqual(["open", "closed"]);
    const save = controls.find((c) => c.kind === "button" && c.name === "Save")!;
    expect(save.effectGuess).toBe("remote-write");
    for (const c of controls) {
      const r = await resolveLocator(page, c.locator, { timeoutMs: 500 });
      expect(await r.locator.count()).toBe(1);
    }
    expect(obs.metrics.snapshotMs).toBeLessThan(500);
    await ctx.close();
  });

  it("extracts tables, pagination, and label/value facts", async () => {
    const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
    const page = await ctx.newPage();
    await page.goto(`${app.origin}/items`);
    const list = await observe(page);
    expect(list.tables[0]!.headers).toEqual(["ID", "Name", "Status"]);
    expect(list.tables[0]!.linkHeaders).toEqual(["ID"]);
    const ctrls = toAppControls("mini", list);
    expect(ctrls.some((c) => c.kind === "pagination" && c.name === "Next page")).toBe(true);
    await page.goto(`${app.origin}/items/I-3`);
    const detail = await observe(page);
    const facts = toAppControls("mini", detail).filter((c) => c.kind === "fact");
    expect(facts.map((f) => f.name)).toEqual(["Status", "Notes"]);
    const st = await resolveLocator(page, facts[0]!.locator, { timeoutMs: 500 });
    expect(await st.locator.innerText()).toBe("closed");
    // Fingerprints ignore data values but change with structure.
    await page.goto(`${app.origin}/items/I-4`);
    const other = await observe(page);
    expect(other.fingerprint.page).toBe(detail.fingerprint.page);
    await ctx.close();
  });

  it("records a titled region as one fact, including its empty state, and reads it the same way", async () => {
    const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
    const page = await ctx.newPage();
    const region = (inner: string) =>
      `<main><section aria-labelledby="h"><h2 id="h">Internal notes</h2>${inner}<form><label for="n">Note</label><textarea id="n"></textarea><button>Add note</button></form></section>` +
      `<section><h2>Details</h2><dl><dt>Status</dt><dd>Open</dd></dl></section></main>`;
    await page.setContent(region(`<ul><li><p>Refund confirmed</p><time>Oct 1</time></li><li><p>Called the customer</p></li></ul>`));
    const facts = toAppControls("mini", await observe(page)).filter((c) => c.kind === "fact");
    // The region with a definition list keeps its per-field facts and gets no region fact.
    expect(facts.map((f) => f.name)).toEqual(["Details › Status", "Internal notes"]);
    const notes = facts.find((f) => f.name === "Internal notes")!;
    expect(notes.sample).toBe("Refund confirmed Oct 1 Called the customer");
    const r = await resolveLocator(page, notes.locator, { timeoutMs: 500 });
    expect(await readControl(r.locator, "text")).toBe("Refund confirmed Oct 1 Called the customer");
    await page.setContent(region(`<p class="muted">No internal notes yet.</p>`));
    const empty = toAppControls("mini", await observe(page)).find((c) => c.name === "Internal notes")!;
    expect(empty.sample).toBe("No internal notes yet.");
    await ctx.close();
  });
});
