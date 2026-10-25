/**
 * Drives the real Chrome extension against a real engine and the arena, then asks the arena's
 * independent checker whether the result is right:
 *
 *   pnpm extension:smoke --engine http://127.0.0.1:4000 --csv .data/extension-demo/records-seed2222.csv [--headed] [--shots docs/demo]
 *
 * Needs the arena, an engine (its pairing code is read from <dataDir>/extension-pairing-code, or
 * pass --code), and a learned workflow for the CSV's task (pnpm extension:demo sets both up). The
 * extension is built if dist/ is missing, loaded unpacked into Chromium, paired, given the CSV,
 * previewed, approved, and followed to its results. Exits 1 unless the checker finds every record
 * correct with no duplicate or collateral writes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright";
import { Arena } from "@overclock/sdk";
import { argValue, REPO_ROOT } from "./network-lib";

const argv = process.argv.slice(2);
const engine = argValue(argv, "--engine") ?? "http://127.0.0.1:4000";
const csv = argValue(argv, "--csv");
const dataDir = argValue(argv, "--data-dir") ?? (process.env.OVERCLOCK_DATA_DIR || join(REPO_ROOT, ".data", "engine"));
const code = argValue(argv, "--code") ?? readFileSync(join(dataDir, "extension-pairing-code"), "utf8").trim();
const shots = argValue(argv, "--shots");
const headed = argv.includes("--headed");
if (!csv) throw new Error("--csv <file> is required (pnpm extension:demo writes one)");

const dist = join(REPO_ROOT, "apps", "extension", "dist");
if (!existsSync(join(dist, "manifest.json"))) execFileSync(process.execPath, [join(REPO_ROOT, "apps", "extension", "build.mjs")], { stdio: "inherit" });
if (shots) mkdirSync(shots, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "oc-ext-smoke-"));
const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: !headed, viewport: { width: 440, height: 1000 }, args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
let exitCode = 1;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `extension-${name}.png`), fullPage: true });
  };
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.getByLabel("Engine address").fill(engine);
  await page.getByLabel("Pairing code").fill(code);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.locator(".workflow").first().waitFor({ timeout: 20_000 });
  await page.locator(".workflow").first().click();
  await page.locator('input[type="file"]').setInputFiles(csv);
  await page.getByText(basename(csv)).waitFor();
  await shot("1-compose");
  await page.getByRole("button", { name: "Preview the workflow" }).click();
  await page.locator(".source").first().waitFor({ timeout: 30_000 });
  const source = await page.locator(".source strong").first().innerText();
  await shot("2-preview");
  console.log(`preview: ${source}`);
  await page.getByRole("button", { name: /^Approve and run/ }).click();
  await page.locator(".pill").waitFor();
  await page.getByText("change confirmed by re-reading the page").first().waitFor({ timeout: 60_000 });
  await shot("3-running");
  await page.locator(".result-hero").waitFor({ timeout: 120_000 });
  await page.waitForTimeout(300);
  await shot("4-results");
  const hero = (await page.locator(".result-hero").innerText()).replace(/\s+/g, " ");
  const tiles = (await page.locator(".results .tile").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  console.log(`extension: ${hero}; ${tiles.join(" | ")}`);
  const check = await new Arena().check();
  console.log(`arena checker: ${check.correctRecords}/${check.totalRecords} correct, ${check.duplicateWrites} duplicate, ${check.collateralWrites} collateral writes`);
  exitCode = check.accuracy === 1 && check.duplicateWrites === 0 && check.collateralWrites === 0 ? 0 : 1;
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
process.exit(exitCode);
