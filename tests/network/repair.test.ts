import type { RepairJobView } from "@overclock/network-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkClient } from "../../packages/network-client/src/index";
import { adminClient, authorizedClient, client, passValidation, proposeVerified, sampleCapability, testOrigin, uid, waitFor } from "./helpers";

/** Repair leases: single holder, fencing tokens, expiry, dedupe, and finish -> promotion. */

let admin: NetworkClient;
let publisher: NetworkClient;
let validator: NetworkClient;
let repairer1: NetworkClient;
let repairer2: NetworkClient;
let watcher: NetworkClient;
const origin = testOrigin();

beforeAll(async () => {
  admin = await adminClient();
  [publisher, validator, repairer1, repairer2] = await Promise.all([
    authorizedClient(admin, "rp-publisher", "publisher"),
    authorizedClient(admin, "rp-validator", "validator"),
    authorizedClient(admin, "rp-repairer-1", "repairer"),
    authorizedClient(admin, "rp-repairer-2", "repairer"),
  ]);
  watcher = await client("rp-watcher", { publishEnabled: false });
  await publisher.registerApplication(origin, ["/orders/:id"]);
  await watcher.watchOrigins([origin]);
});

afterAll(async () => {
  await Promise.all([admin, publisher, validator, repairer1, repairer2, watcher].map((c) => c?.close()));
});

async function activeCapability(): Promise<{ capabilityId: string; versionId: string }> {
  const capabilityId = `repair-${uid()}`;
  const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
  await admin.promote(versionId);
  return { capabilityId, versionId };
}

describe("failure reports", () => {
  it("dedupe by signature into one job and count distinct reporters", async () => {
    const { capabilityId } = await activeCapability();
    const sig = { capabilityId, version: 1, category: "control-missing" as const, subject: "Shop:/orders/:id:select:status", observedFingerprint: "rfp-drifted" };
    const first = await publisher.reportFailure(sig);
    const second = await repairer1.reportFailure(sig);
    const third = await publisher.reportFailure(sig);
    expect(first.existing).toBe(false);
    expect(second).toEqual({ jobId: first.jobId, existing: true });
    expect(third).toEqual({ jobId: first.jobId, existing: true });
    await waitFor(() => watcher.repairJob(first.jobId)?.reporters === 2, 5000, "reporter count");
    const job = watcher.repairJob(first.jobId)!;
    expect(job.status).toBe("open");
    expect(job.fencingToken).toBe(0);

    const other = await publisher.reportFailure({ ...sig, subject: "Shop:/orders/:id:button:save" });
    expect(other.jobId).not.toBe(first.jobId);
  });

  it("rejects reports for unknown versions and from unregistered identities", async () => {
    const { capabilityId } = await activeCapability();
    await expect(publisher.reportFailure({ capabilityId, version: 9, category: "dialog", subject: "Shop:/orders/:id" })).rejects.toThrow(/unknown capability version/);
    const stranger = await client("rp-stranger");
    await expect(stranger.reportFailure({ capabilityId, version: 1, category: "dialog", subject: "Shop:/orders/:id" })).rejects.toThrow(/not registered/);
    await stranger.close();
  });
});

describe("repair leases", () => {
  it("exactly one of two racing claims wins", async () => {
    const { capabilityId } = await activeCapability();
    const { jobId } = await publisher.reportFailure({ capabilityId, version: 1, category: "dialog", subject: "Shop:/orders/:id" });
    const results = await Promise.all([repairer1.claimRepair(jobId, 30_000), repairer2.claimRepair(jobId, 30_000)]);
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0]!.fencingToken).toBe(1);
    expect(losers[0]!.reason).toMatch(/held by another holder/);
    const holder = winners[0]!.holder;
    expect([repairer1.identity, repairer2.identity]).toContain(holder);
    await waitFor(() => watcher.repairJob(jobId)?.holder === holder, 5000, "holder visible to watchers");
  });

  it("an expired lease is reclaimable and the old holder is fenced out", async () => {
    const { capabilityId } = await activeCapability();
    const { jobId } = await publisher.reportFailure({ capabilityId, version: 1, category: "fingerprint-drift", subject: "/orders/:id" });
    const jobEvents: RepairJobView[] = [];
    const off = watcher.onRepairJob((j) => {
      if (j.jobId === jobId) jobEvents.push(j);
    });

    const a = await repairer1.claimRepair(jobId, 300);
    expect(a.ok).toBe(true);
    const renewed = await repairer1.renewRepair(jobId, a.fencingToken!, 300);
    expect(renewed.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 450));

    expect((await repairer1.renewRepair(jobId, a.fencingToken!, 300)).reason).toMatch(/expired/);
    const b = await repairer2.claimRepair(jobId, 30_000);
    expect(b.ok).toBe(true);
    expect(b.fencingToken).toBe(a.fencingToken! + 1);

    // The stale holder cannot finish, renew, or release after someone else re-claimed.
    const v2 = (await repairer1.proposeCapability(sampleCapability({ capabilityId, version: 2, origin, parentVersion: 1 }))).versionId;
    const staleFinish = await repairer1.finishRepair(jobId, a.fencingToken!, v2);
    expect(staleFinish.ok).toBe(false);
    expect(staleFinish.reason).toMatch(/stale fencing token/);
    await expect(repairer1.releaseRepair(jobId, a.fencingToken!)).rejects.toThrow(/stale fencing token/);
    // Even with the current token, a non-holder is rejected.
    await expect(repairer1.releaseRepair(jobId, b.fencingToken!)).rejects.toThrow(/does not hold the repair lease/);

    // The current holder publishes a repair (v3, parent v1) and finishes the job with it.
    const v3 = (await repairer2.proposeCapability(sampleCapability({ capabilityId, version: 3, origin, parentVersion: 1 }))).versionId;
    expect((await repairer2.finishRepair(jobId, b.fencingToken!, v2)).reason).toMatch(/must have published the proposed version/);
    expect(await repairer2.finishRepair(jobId, b.fencingToken!, v3)).toEqual({ ok: true });
    await waitFor(() => watcher.repairJob(jobId)?.status === "proposed", 5000, "job proposed");
    expect(watcher.repairJob(jobId)?.proposedVersionId).toBe(v3);

    // Validation and promotion of the repaired version close the job.
    await validator.recordValidation(passValidation(v3));
    await waitFor(() => watcher.repairJob(jobId)?.status === "validated", 5000, "job validated");
    await admin.promote(v3);
    await waitFor(() => watcher.repairJob(jobId)?.status === "promoted", 5000, "job promoted");
    expect(watcher.activeVersion(capabilityId)?.versionId).toBe(v3);
    off();
    expect(jobEvents.map((j) => j.status)).toEqual(expect.arrayContaining(["leased", "proposed", "validated", "promoted"]));
    expect(Math.max(...jobEvents.map((j) => j.fencingToken))).toBe(b.fencingToken);
  });

  it("release returns the job to the queue and validators cannot claim", async () => {
    const { capabilityId } = await activeCapability();
    const { jobId } = await publisher.reportFailure({ capabilityId, version: 1, category: "precondition", subject: "/orders/:id" });
    await expect(validator.claimRepair(jobId, 1000)).resolves.toMatchObject({ ok: false, reason: expect.stringMatching(/role validator is not allowed/) });
    const lease = await repairer1.claimRepair(jobId, 10_000);
    await repairer1.releaseRepair(jobId, lease.fencingToken!);
    await waitFor(() => watcher.repairJob(jobId)?.status === "open", 5000, "job reopened");
    const again = await repairer2.claimRepair(jobId, 10_000);
    expect(again.fencingToken).toBe(lease.fencingToken! + 1);
  });
});
