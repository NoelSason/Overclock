/**
 * Latency probe for an Overclock Network endpoint (local or Maincloud).
 *
 *   tsx scripts/network-probe.ts [--endpoint <url>] [--database <name>] [--iterations 30]
 *                                [--temp | --read-only] [--payload-kib 240]
 *
 * Measures, with two independent client identities A and B:
 *   - connect time (raw SDK connection, and the NetworkClient path incl. its base subscription)
 *   - subscription-applied time (a single-row query, and the origin-scoped watch query set)
 *   - reducer round trip (A awaits a reducer)
 *   - propagation A -> B (B receives A's committed row update; same local clock, so no skew)
 *
 * By default the reducer and propagation measurements re-register A as a pending publisher
 * (one reused `probe-*` row per endpoint, no registry writes). --read-only skips them and only
 * connects and subscribes, for a live database you do not want touched. --temp publishes a
 * throwaway database on the endpoint's server, also measures a large capability (propose round
 * trip, propagation, fetch), and deletes the database afterwards; for Maincloud it needs the CLI
 * to be logged in.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NetworkConfig, PortableCapability } from "@overclock/network-contracts";
import { NetworkClient, TokenStore, sha256Hex } from "../packages/network-client/src/index";
import { DbConnection, tables, type EventContext } from "../packages/network-client/src/generated/index";
import type { Publishers } from "../packages/network-client/src/generated/types";
import {
  LOCAL_ENDPOINT,
  NETWORK_STATE_DIR,
  argValue,
  authorizeAsOwner,
  cliServerFor,
  deleteDatabase,
  ensureLocalServer,
  isLocalEndpoint,
  publishModule,
} from "./network-lib";

const now = () => performance.timeOrigin + performance.now();

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: s.length, min: r(s[0] ?? 0), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0) };
}

async function rawConnect(endpoint: string, database: string, dataDir: string): Promise<{ conn: DbConnection; ms: number }> {
  const store = new TokenStore(dataDir);
  const host = new URL(endpoint).host;
  const token = await store.load(host);
  const t0 = now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect to ${endpoint} timed out`)), 20_000);
    DbConnection.builder()
      .withUri(endpoint)
      .withDatabaseName(database)
      .withToken(token)
      .onConnect((conn, _identity, newToken) => {
        clearTimeout(timer);
        const ms = now() - t0;
        store.save(host, newToken).then(
          () => resolve({ conn, ms }),
          () => resolve({ conn, ms }),
        );
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
      })
      .build();
  });
}

function probeCapability(capabilityId: string, origin: string, publisherId: string, padKiB: number): PortableCapability {
  const control = "Probe:/items/:id:button:save";
  return {
    schemaVersion: "1",
    capabilityId,
    version: 1,
    publisherId,
    applications: [{ name: "Probe", origin, routeFamilies: ["/items/:id"], interfaceFingerprint: `ifp-${capabilityId}` }],
    intent: { canonicalOperation: `op:${capabilityId}`, description: `latency probe ${"p".repeat(padKiB * 1024)}`, inputSchema: { recordFields: ["id"] } },
    procedure: {
      format: "overclock-procedure-dsl",
      compilerVersion: "probe-1",
      plan: {
        strategy: { name: "probe", summary: "probe", rationale: "probe" },
        phases: [{ id: "p", kind: "once", dependsOn: [], steps: [{ id: "open", op: "goto", app: "Probe", url: "/items/1" }] }],
        outcomes: [],
        assumptions: [],
        risks: [],
      },
    },
    controls: [{ key: control, app: "Probe", routeFamily: "/items/:id", kind: "button", role: "button", name: "Save", strategies: [{ kind: "role", role: "button", name: "Save" }] }],
    pages: [{ app: "Probe", routeFamily: "/items/:id", pathTemplate: "/items/{id}", pageFingerprint: `pfp-${capabilityId}`, regionFingerprints: {} }],
    requirements: { permissions: [], allowedOrigins: [origin], expectedEffects: [] },
    verification: { rules: [] },
    provenance: { artifactHash: sha256Hex(capabilityId), createdAt: Date.now(), verifiedReceipts: 0 },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const endpoint = argValue(argv, "--endpoint") ?? (process.env["OVERCLOCK_NETWORK_ENDPOINT"]?.trim() || LOCAL_ENDPOINT);
  const iterations = Number(argValue(argv, "--iterations") ?? 30);
  const temp = argv.includes("--temp");
  const readOnly = argv.includes("--read-only") && !temp;
  const payloadKiB = Number(argValue(argv, "--payload-kib") ?? 240);
  const server = cliServerFor(endpoint);
  const host = new URL(endpoint).host;
  const run = randomBytes(3).toString("hex");
  let database = argValue(argv, "--database") ?? (process.env["OVERCLOCK_NETWORK_DATABASE"]?.trim() || "overclock-network");

  if (isLocalEndpoint(endpoint)) await ensureLocalServer(endpoint);
  if (temp) {
    database = `overclock-probe-${run}`;
    const t0 = now();
    await publishModule({ database, server, clean: true });
    console.log(`published temporary database ${database} on ${server} in ${Math.round(now() - t0)} ms`);
  }
  // Probe identities are reused per endpoint (so repeated probes do not pile up registrations),
  // except for --temp runs, which use fresh identities in a throwaway directory.
  const baseDir = temp ? mkdtempSync(join(tmpdir(), "overclock-probe-")) : join(NETWORK_STATE_DIR, "probe", host.replace(/[^a-z0-9.-]/gi, "_"));
  mkdirSync(baseDir, { recursive: true });
  const cfg = (label: string): NetworkConfig => ({
    enabled: true,
    endpoint,
    database,
    mode: "network-read-and-contribute",
    publishEnabled: true,
    lookupTimeoutMs: 5000,
    dataDir: join(baseDir, label),
    runtimeLabel: label,
  });

  const result: Record<string, unknown> = { endpoint, database, temp, readOnly, iterations: readOnly ? 0 : iterations, at: new Date().toISOString() };
  const opened: Array<{ close(): unknown }> = [];
  try {
    // Connect: raw SDK connections for A and B, then the full NetworkClient path for C.
    const a = await rawConnect(endpoint, database, join(baseDir, "a"));
    const b = await rawConnect(endpoint, database, join(baseDir, "b"));
    opened.push({ close: () => a.conn.disconnect() }, { close: () => b.conn.disconnect() });
    const tc = now();
    const c = await NetworkClient.connect(cfg("c"), { connectTimeoutMs: 20_000 });
    opened.push(c);
    result["connectMs"] = { rawA: Math.round(a.ms * 100) / 100, rawB: Math.round(b.ms * 100) / 100, networkClientWithBaseSubscription: Math.round((now() - tc) * 100) / 100 };

    const aIdentity = a.conn.identity!;
    if (!readOnly) await a.conn.reducers.registerPublisher({ displayName: `probe-${run}-0`, role: "publisher" });

    // Subscription applied: B subscribes to A's publisher row; C runs the origin-scoped watch set.
    const ts = now();
    await new Promise<void>((resolve, reject) => {
      b.conn
        .subscriptionBuilder()
        .onApplied(() => resolve())
        .onError((ctx) => reject(ctx.event))
        .subscribe(tables.publishers.where((p) => p.identity.eq(aIdentity)));
    });
    const subscribeRowMs = now() - ts;
    const probeOrigin = `https://probe-${run}.overclock.invalid`;
    const tw = now();
    await c.watchOrigins([probeOrigin]);
    result["subscriptionAppliedMs"] = { singleRow: Math.round(subscribeRowMs * 100) / 100, watchOriginsQuerySet: Math.round((now() - tw) * 100) / 100 };

    // Reducer round trip and A -> B propagation.
    const rtt: number[] = [];
    const propagation: number[] = [];
    const serverToClient: number[] = [];
    for (let i = 1; i <= (readOnly ? 0 : iterations); i++) {
      const name = `probe-${run}-${i}`;
      const seen = new Promise<number>((resolve) => {
        const cb = (_ctx: EventContext, _old: Publishers, row: Publishers) => {
          if (row.displayName !== name || !row.identity.isEqual(aIdentity)) return;
          b.conn.db.publishers.removeOnUpdate(cb);
          const t = now();
          serverToClient.push(t - Number(row.updatedAt.microsSinceUnixEpoch) / 1000);
          resolve(t);
        };
        b.conn.db.publishers.onUpdate(cb);
      });
      const sent = now();
      await a.conn.reducers.registerPublisher({ displayName: name, role: "publisher" });
      rtt.push(now() - sent);
      propagation.push((await seen) - sent);
    }
    if (!readOnly) {
      result["reducerRoundTripMs"] = stats(rtt);
      result["propagationAtoBMs"] = stats(propagation);
      result["serverCommitToClientMs"] = { ...stats(serverToClient), note: "uses the server clock; includes clock skew for remote hosts" };
    }

    if (temp) {
      // Large capability: authorize A as the owner, then propose, propagate, and fetch.
      await authorizeAsOwner({ database, server, identityHex: aIdentity.toHexString(), role: "admin" });
      const pa = await NetworkClient.connect(cfg("a"), { connectTimeoutMs: 20_000 });
      opened.push(pa);
      await pa.registerApplication(probeOrigin, ["/items/:id"]);
      const capabilityId = `probe-${run}`;
      const proposed = new Promise<{ committedAt: number; receivedAt: number }>((resolve) => {
        const off = c.onCapabilityChange((ch) => {
          if (ch.capabilityId === capabilityId) {
            off();
            resolve(ch);
          }
        });
      });
      const cap = probeCapability(capabilityId, probeOrigin, pa.identity!, payloadKiB);
      const tp = now();
      const { versionId } = await pa.proposeCapability(cap);
      const proposeMs = now() - tp;
      const ch = await proposed;
      const fetched = await c.fetchArtifact(versionId);
      const again = await c.fetchArtifact(versionId);
      result["largeCapability"] = {
        bytes: Buffer.byteLength(JSON.stringify({ ...cap, publisherId: pa.identity })),
        proposeRoundTripMs: Math.round(proposeMs * 100) / 100,
        propagationToSubscriberMs: Math.round((ch.receivedAt - tp) * 100) / 100,
        fetchNetworkMs: Math.round(fetched.ms * 100) / 100,
        fetchLocalCacheMs: Math.round(again.ms * 100) / 100,
      };
    }
  } finally {
    for (const o of opened) {
      try {
        await o.close();
      } catch {
        // ignore
      }
    }
    if (temp) {
      const deleted = await deleteDatabase({ database, server });
      result["tempDatabaseDeleted"] = deleted;
      rmSync(baseDir, { recursive: true, force: true });
    }
  }

  mkdirSync(NETWORK_STATE_DIR, { recursive: true });
  const out = join(NETWORK_STATE_DIR, `probe-${host.replace(/[^a-z0-9.-]/gi, "_")}${temp ? "-temp" : readOnly ? "-readonly" : ""}.json`);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nsaved ${out}`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
