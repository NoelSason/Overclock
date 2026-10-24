import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { RunConfigSchema } from "@overclock/contracts";
import { canonicalOperation as capabilityOperation, isExactOperationIdentity, normalizeGoal } from "@overclock/network-capability";
import { cacheKey, canonicalOperation as localOperation } from "@overclock/swarm";
import { FileProgramCache } from "../../services/engine/src/runtime";

/**
 * Operation identity decides whether a learned plan may run for a new request, locally (warm
 * cache) or across runtimes (network capabilities). Two requests share it only when their
 * instructions are the same text over the same record fields; record ids and values don't matter.
 */

const base = 'For each order: if the ticket is a damage ticket, set its status to "escalated" and the owner to Tier 2. Customers with 2 or more refunded orders get status "on_hold" unless they are vip.';
const fields = ["orderId"];
const identities = (goal: string, f = fields) => [capabilityOperation(goal, f), localOperation(goal, f)];

describe("operation identity", () => {
  it("differs for a different target literal (approved vs rejected)", () => {
    const approved = 'Set each ticket\'s status to "approved".';
    const rejected = 'Set each ticket\'s status to "rejected".';
    // The display normalization is lossy on purpose; it used to be the identity, which let these collide.
    expect(normalizeGoal(approved)).toBe(normalizeGoal(rejected));
    const [a1, a2] = identities(approved);
    const [r1, r2] = identities(rejected);
    expect(a1).not.toBe(r1);
    expect(a2).not.toBe(r2);
  });

  it("differs for a different numeric threshold", () => {
    expect(identities(base)[0]).not.toBe(identities(base.replace("2 or more", "3 or more"))[0]);
    expect(identities(base)[1]).not.toBe(identities(base.replace("2 or more", "3 or more"))[1]);
  });

  it("differs for different target values written by the same rule", () => {
    for (const [from, to] of [
      ["Tier 2", "Tier 3"],
      ['"escalated"', '"resolved"'],
      ['"on_hold"', '"closed"'],
    ] as const) {
      expect(identities(base.replace(from, to))[0]).not.toBe(identities(base)[0]);
      expect(identities(base.replace(from, to))[1]).not.toBe(identities(base)[1]);
    }
  });

  it("differs for semantically different conditions", () => {
    for (const changed of [base.replace("unless they are vip", "unless they are new"), base.replace("2 or more", "more than 2"), base.replace("damage ticket", "shipping ticket"), base.replace("if the ticket", "unless the ticket")]) {
      expect(identities(changed)[0]).not.toBe(identities(base)[0]);
      expect(identities(changed)[1]).not.toBe(identities(base)[1]);
    }
  });

  it("differs for a different record schema", () => {
    expect(identities(base, ["orderId"])[0]).not.toBe(identities(base, ["orderId", "email"])[0]);
  });

  it("is the same for the same instructions: presentation-only differences, field order, and any record values", () => {
    const crlf = `  ${base.replace(". ", ".   \r\n")}\n\n`;
    expect(identities(crlf)[0]).toBe(identities(base.replace(". ", ".\n"))[0]);
    expect(identities(base, ["b", "a", "a"])).toEqual(identities(base, ["a", "b"]));
    const apps = [{ name: "Orders", origin: "http://127.0.0.1:4102" }];
    const one = RunConfigSchema.parse({ goal: base, applications: apps, records: [{ orderId: "ORD-1001" }, { orderId: "ORD-1002" }] });
    const other = RunConfigSchema.parse({ goal: base, applications: apps, records: [{ orderId: "ORD-9" }] });
    expect(cacheKey(one)).toBe(cacheKey(other));
    // Whitespace inside a line is part of the text: it is not collapsed.
    expect(identities(base.replace("Tier 2", "Tier  2"))[0]).not.toBe(identities(base)[0]);
  });

  it("marks the exact scheme, so identities from the superseded lossy scheme are recognizable", () => {
    expect(isExactOperationIdentity(capabilityOperation(base, fields))).toBe(true);
    expect(isExactOperationIdentity("a".repeat(64))).toBe(false);
  });
});

describe("local plan cache", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-cache-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const apps = [{ name: "Support", origin: "http://127.0.0.1:4103" }];
  const config = (goal: string) => RunConfigSchema.parse({ goal, applications: apps, records: [{ ticketId: "T-1" }] });
  const entry = { plan: { strategy: { name: "s", summary: "", rationale: "" }, phases: [], outcomes: [], assumptions: [], risks: [] }, models: [] };

  it("never serves a plan stored for a different operation, or an entry without its key", () => {
    const cache = new FileProgramCache(dir);
    const approved = cacheKey(config('Set each ticket\'s status to "approved".'));
    const rejected = cacheKey(config('Set each ticket\'s status to "rejected".'));
    cache.put(approved, entry);
    expect(cache.get(approved)?.key).toBe(approved);
    expect(cache.get(rejected)).toBeUndefined();
    // A legacy entry (written before keys were stored) under a matching file name is ignored.
    cache.put(rejected, entry);
    expect(cache.get(rejected)?.key).toBe(rejected);
    for (const f of readdirSync(dir)) {
      const stored = JSON.parse(readFileSync(join(dir, f), "utf8")) as { key?: string };
      if (stored.key === rejected) writeFileSync(join(dir, f), JSON.stringify({ ...stored, key: undefined }));
    }
    expect(cache.get(rejected)).toBeUndefined();
  });
});
