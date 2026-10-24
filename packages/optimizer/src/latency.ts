import type { ActionNode } from "@overclock/contracts";
import type { CompiledSegment } from "@overclock/compiler";

class Ewma {
  value: number | null = null;
  n = 0;
  constructor(private readonly alpha = 0.25) {}
  add(x: number): void {
    this.n++;
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
  }
}

export type Source = "measured" | "estimated" | "default";

/**
 * Latency model for cost estimation. Starts from defaults, is seeded with real page-load
 * timings measured by the scouts and dry-run probes, and is updated online from execution.
 */
export class LatencyModel {
  private readonly nav = new Map<string, Ewma>();
  private readonly write = new Map<string, Ewma>();
  private readonly segment = new Map<string, Ewma>();
  private readonly action = new Map<string, Ewma>();
  readonly defaults = { navMs: 250, writeMs: 450, actionMs: 30, fieldMs: 15, tableRowMs: 2 };

  private ewma(m: Map<string, Ewma>, k: string): Ewma {
    let e = m.get(k);
    if (!e) {
      e = new Ewma();
      m.set(k, e);
    }
    return e;
  }

  observeNav(app: string, ms: number): void {
    this.ewma(this.nav, app).add(ms);
  }
  observeWrite(app: string, ms: number): void {
    this.ewma(this.write, app).add(ms);
  }
  observeSegment(segmentId: string, ms: number): void {
    this.ewma(this.segment, segmentId).add(ms);
  }
  observeAction(type: string, ms: number): void {
    this.ewma(this.action, type).add(ms);
  }

  navMs(app: string | undefined): { ms: number; source: Source } {
    const e = app ? this.nav.get(app) : undefined;
    return e?.value != null ? { ms: e.value, source: "measured" } : { ms: this.defaults.navMs, source: "default" };
  }
  writeMs(app: string | undefined): { ms: number; source: Source } {
    const e = app ? this.write.get(app) : undefined;
    if (e?.value != null) return { ms: e.value, source: "measured" };
    const nav = this.navMs(app);
    // A form POST + redirect + page load is roughly two page loads of the same app.
    return nav.source === "measured" ? { ms: nav.ms * 2, source: "estimated" } : { ms: this.defaults.writeMs, source: "default" };
  }

  nodeMs(n: ActionNode): number {
    const a = (t: string, d: number) => this.action.get(t)?.value ?? d;
    switch (n.type) {
      case "navigate":
        return this.navMs(n.app).ms;
      case "click":
        if (n.effect === "remote-write" || n.effect === "irreversible") return this.writeMs(n.app).ms + (n.verify ? this.navMs(n.app).ms + n.verify.fields.length * this.defaults.fieldMs : 0);
        return a("click", this.navMs(n.app).ms * 0.8);
      case "fill":
      case "select":
        return a(n.type, this.defaults.actionMs);
      case "extract":
        if (n.table) {
          const pages = n.table.pagination ? Math.min(n.table.pagination.maxPages, 4) : 1;
          return pages * (this.navMs(n.app).ms + 60);
        }
        return (n.fields?.length ?? 1) * this.defaults.fieldMs;
      case "waitFor":
        return 200;
      default:
        return 0.2;
    }
  }

  segmentMs(seg: CompiledSegment): { ms: number; source: Source } {
    const e = this.segment.get(seg.id);
    if (e?.value != null && e.n >= 2) return { ms: e.value, source: "measured" };
    const ms = seg.nodes.reduce((s, n) => s + this.nodeMs(n), 0);
    const anyMeasured = seg.app ? this.nav.get(seg.app)?.value != null : true;
    return { ms, source: anyMeasured ? "estimated" : "default" };
  }

  measuredApps(): string[] {
    return [...this.nav.entries()].filter(([, e]) => e.value != null).map(([k]) => k);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, e] of this.nav) if (e.value != null) out[`nav:${k}`] = Math.round(e.value);
    for (const [k, e] of this.write) if (e.value != null) out[`write:${k}`] = Math.round(e.value);
    return out;
  }
}
