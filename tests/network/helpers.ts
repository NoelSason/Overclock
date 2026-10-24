import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { NetworkConfig, PortableCapability, PublisherRole } from "@overclock/network-contracts";
import { inject } from "vitest";
import { NetworkClient, TokenStore, sha256Hex, type NetworkClientOptions } from "../../packages/network-client/src/index";
import { DbConnection } from "../../packages/network-client/src/generated/index";

export function env() {
  return inject("networkTest");
}

/** Save measurements; the global teardown prints every file's metrics after the run. */
export function recordMetrics(name: string, data: unknown): void {
  writeFileSync(join(env().scratchDir, `metrics-${name}.json`), JSON.stringify(data));
}

export function uid(n = 4): string {
  return randomBytes(n).toString("hex");
}

export function configFor(label: string, overrides: Partial<NetworkConfig> = {}): NetworkConfig {
  const e = env();
  return {
    enabled: true,
    endpoint: e.endpoint,
    database: e.database,
    mode: "network-read-and-contribute",
    publishEnabled: true,
    lookupTimeoutMs: 2000,
    dataDir: overrides.dataDir ?? mkdtempSync(join(e.scratchDir, `${label}-`)),
    runtimeLabel: label,
    ...overrides,
  };
}

export async function client(label: string, overrides: Partial<NetworkConfig> = {}, opts: NetworkClientOptions = {}): Promise<NetworkClient> {
  return NetworkClient.connect(configFor(label, overrides), opts);
}

export async function adminClient(): Promise<NetworkClient> {
  return client("admin", { dataDir: env().adminDataDir });
}

/** A client registered with `role` and authorized by `admin`. */
export async function authorizedClient(admin: NetworkClient, label: string, role: PublisherRole, overrides: Partial<NetworkConfig> = {}): Promise<NetworkClient> {
  const c = await client(label, overrides);
  await c.registerPublisher(label, role);
  await admin.authorizePublisher(c.identity!, role);
  await waitFor(() => c.myPublisher()?.status === "authorized", 5000, `${label} authorization`);
  return c;
}

/**
 * Raw connection with the identity stored in `dataDir`, for calling reducers directly and so
 * bypassing every client-side check (the module must enforce them on its own).
 */
export async function rawConnection(dataDir: string): Promise<DbConnection> {
  const e = env();
  const token = await new TokenStore(dataDir).load(new URL(e.endpoint).host);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("raw connection timeout")), 5000);
    DbConnection.builder()
      .withUri(e.endpoint)
      .withDatabaseName(e.database)
      .withToken(token)
      .onConnect((c) => {
        clearTimeout(timer);
        resolve(c);
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timer);
        reject(err);
      })
      .build();
  });
}

export async function waitFor(pred: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function testOrigin(): string {
  return `https://shop-${uid()}.example.test`;
}

/** A harmless test capability: open an order page, set a status select, save, verify. */
export function sampleCapability(o: {
  capabilityId: string;
  version: number;
  origin: string;
  parentVersion?: number;
  description?: string;
  gotoUrl?: string;
  publisherId?: string;
}): PortableCapability {
  const status = "Shop:/orders/:id:select:status";
  const save = "Shop:/orders/:id:button:save";
  return {
    schemaVersion: "1",
    capabilityId: o.capabilityId,
    version: o.version,
    publisherId: o.publisherId ?? "set-by-client",
    applications: [
      { name: "Shop", origin: o.origin, routeFamilies: ["/orders/:id"], interfaceFingerprint: `ifp-${o.capabilityId}`, roleClass: "operator", locale: "en-US" },
    ],
    intent: {
      canonicalOperation: `op:${o.capabilityId}`,
      description: o.description ?? "Mark an order as reviewed (network test fixture)",
      inputSchema: { recordFields: ["orderId"] },
    },
    procedure: {
      format: "overclock-procedure-dsl",
      compilerVersion: "test-compiler-1",
      plan: {
        strategy: { name: "direct", summary: "open each order and set its status", rationale: "test fixture" },
        phases: [
          {
            id: "review",
            kind: "foreach",
            over: "$input.records",
            key: "$rec.orderId",
            dependsOn: [],
            steps: [
              { id: "open_order", op: "goto", app: "Shop", url: o.gotoUrl ?? "/orders/{$rec.orderId}" },
              { id: "set_status", op: "select", control: status, value: "'reviewed'" },
              {
                id: "save",
                op: "submit",
                control: save,
                writes: ["app:shop:order:{$rec.orderId}"],
                guards: [],
                verify: { url: "/orders/{$rec.orderId}", fields: [{ name: "status", control: status, equals: "'reviewed'" }] },
                irreversible: false,
              },
            ],
          },
        ],
        outcomes: [{ id: "reviewed", description: "every order is marked reviewed" }],
        assumptions: [],
        risks: [],
      },
    },
    controls: [
      {
        key: status,
        app: "Shop",
        routeFamily: "/orders/:id",
        kind: "select",
        role: "combobox",
        name: "Status",
        label: "Status",
        options: [
          { value: "new", label: "New" },
          { value: "reviewed", label: "Reviewed" },
        ],
        effect: "remote-write",
        strategies: [{ kind: "role", role: "combobox", name: "Status" }],
      },
      { key: save, app: "Shop", routeFamily: "/orders/:id", kind: "button", role: "button", name: "Save", effect: "remote-write", strategies: [{ kind: "role", role: "button", name: "Save" }] },
    ],
    pages: [{ app: "Shop", routeFamily: "/orders/:id", pathTemplate: "/orders/{id}", pageFingerprint: `pfp-${o.capabilityId}`, regionFingerprints: { form: `rfp-${o.capabilityId}` } }],
    requirements: {
      permissions: ["orders:write"],
      allowedOrigins: [o.origin],
      expectedEffects: [{ effect: "remote-write", resource: "app:shop:order", stepId: "save" }],
    },
    verification: { rules: [{ stepId: "save", url: "/orders/{$rec.orderId}", fields: [{ name: "status", control: status, equals: "reviewed" }] }] },
    provenance: {
      artifactHash: sha256Hex(`${o.capabilityId}@${o.version}`),
      createdAt: Date.now(),
      verifiedReceipts: 3,
      ...(o.parentVersion !== undefined ? { parentVersion: o.parentVersion } : {}),
    },
  };
}

export function passValidation(versionId: string) {
  return { versionId, environment: "sandbox-local", outcome: "pass" as const, category: "replay", evidenceDigest: sha256Hex(`evidence:${versionId}`), detail: "replayed 3 records" };
}

export function failValidation(versionId: string) {
  return { versionId, environment: "sandbox-local", outcome: "fail" as const, category: "verification", evidenceDigest: sha256Hex(`fail:${versionId}`), detail: "verification mismatch" };
}

/** Propose a capability version and drive it to VERIFIED with an independent validator. */
export async function proposeVerified(publisher: NetworkClient, validator: NetworkClient, cap: PortableCapability): Promise<string> {
  const { versionId } = await publisher.proposeCapability(cap);
  await validator.recordValidation(passValidation(versionId));
  return versionId;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function summarize(values: number[]): { n: number; p50: number; p95: number; max: number } {
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n: values.length, p50: r(percentile(values, 50)), p95: r(percentile(values, 95)), max: r(Math.max(0, ...values)) };
}

/** TCP proxy in front of the SpacetimeDB server, to cut and restore a client's network path. */
export class TcpProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private down = false;
  port = 0;

  constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((inbound) => {
      if (this.down) {
        inbound.destroy();
        return;
      }
      const outbound = tcpConnect(this.targetPort, this.targetHost);
      this.sockets.add(inbound);
      this.sockets.add(outbound);
      const drop = () => {
        inbound.destroy();
        outbound.destroy();
        this.sockets.delete(inbound);
        this.sockets.delete(outbound);
      };
      inbound.on("error", drop).on("close", drop);
      outbound.on("error", drop).on("close", drop);
      inbound.pipe(outbound).pipe(inbound);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : 0;
  }

  endpoint(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  /** Drop every open connection and refuse new ones until restore(). */
  cut(): void {
    this.down = true;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  restore(): void {
    this.down = false;
  }

  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
