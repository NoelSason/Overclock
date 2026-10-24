import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena, type Arena as ArenaServer } from "@overclock/arena";
import { CheckResult, PublicScenario, RunConfigSchema, VariationConfig } from "@overclock/contracts";
import { Arena, OverclockError, configFromScenario } from "@overclock/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../apps/cli/src/main";

/** The SDK's Arena client and the CLI's arena commands against the real arena admin server. */

let server: ArenaServer;
let dir: string;
let arena: Arena;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-sdk-arena-"));
  server = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 7, template: "t1-order-reconcile", records: 20 } });
  arena = new Arena({ endpoint: server.adminOrigin });
});

afterAll(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { OVERCLOCK_ARENA_URL: server.adminOrigin, OVERCLOCK_URL: "http://127.0.0.1:9" },
    cwd: dir,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("Arena client against the real arena", () => {
  it("loads scenarios whose shape matches the contract and builds a valid run config", async () => {
    const s = PublicScenario.parse(await arena.scenario());
    expect(s.records).toHaveLength(20);
    const loaded = PublicScenario.parse(await arena.loadScenario({ seed: 11, records: 10 }));
    expect(loaded.scenarioId).toBe("t1-order-reconcile-s11-n10");
    const config = configFromScenario(loaded, { maxWorkers: 8 });
    expect(RunConfigSchema.safeParse(config).success).toBe(true);
    expect(config.applications?.map((a) => a.origin)).toEqual(expect.arrayContaining([server.origins.Orders]));
    expect(PublicScenario.parse(await arena.reset()).scenarioId).toBe(loaded.scenarioId);
  });

  it("checks ground truth and manages variations", async () => {
    const check = CheckResult.parse(await arena.check());
    expect(check.totalRecords).toBe(10);
    expect(VariationConfig.parse(await arena.setVariations({ theme: "dense" })).theme).toBe("dense");
    expect((await arena.patchVariations({ confirmModal: { CRM: true } })).confirmModal).toEqual({ CRM: true });
    expect((await arena.variations()).theme).toBe("dense");
    const surprised = await arena.surprise("rename-save", "Orders");
    expect(Object.keys(surprised.renameButtons)).toEqual(["Orders"]);
    expect((await arena.resetVariations()).theme).toBe("default");
    const e = await arena.surprise("meteor").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(OverclockError);
    expect((e as OverclockError).status).toBe(400);
    expect(await arena.editUnprocessed()).toMatchObject({ recordKey: expect.any(String) });
    expect(await arena.stats()).toBeTypeOf("object");
    expect(await arena.health()).toMatchObject({ ok: true });
  });
});

describe("CLI arena commands against the real arena", () => {
  it("reset, check, surprise, and edit-unprocessed", async () => {
    const reset = await cli(["reset", "--seed", "4242", "--records", "12", "--template", "t2-ticket-triage"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("Scenario t2-ticket-triage-s4242-n12");

    const check = await cli(["check", "--json"]);
    expect(check.code).toBe(0);
    expect(CheckResult.parse(JSON.parse(check.out)).totalRecords).toBe(12);
    expect((await cli(["check"])).out).toMatch(/Accuracy\s+\d/);

    const surprise = await cli(["surprise", "latency", "--app", "Orders"]);
    expect(surprise.code).toBe(0);
    expect(surprise.out).toContain("Active variations: latency");
    expect((await cli(["surprise", "clear"])).out).toContain("Active variations: none");
    expect((await cli(["surprise", "rename-save", "--app", "Nope"])).code).toBe(1);

    const edit = await cli(["edit-unprocessed"]);
    expect(edit.code).toBe(0);
    expect(edit.out).toMatch(/^Edited \w+ \S+ \(record \S+\): \w+=/);

    expect((await cli(["reset"])).code).toBe(0);
  });
});
