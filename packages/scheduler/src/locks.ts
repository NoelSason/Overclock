/**
 * Exclusive resource locks keyed by strings like `app:crm:customer:C-1001`. A key ending in `*`
 * is a prefix lock (used when a resource cannot be resolved precisely: conservative by default).
 */
export class LockManager {
  private readonly held = new Map<string, string>();

  private conflicts(key: string, holder: string): string | null {
    for (const [k, h] of this.held) {
      if (h === holder) continue;
      if (k === key) return h;
      if (k.endsWith("*") && key.startsWith(k.slice(0, -1))) return h;
      if (key.endsWith("*") && k.startsWith(key.slice(0, -1))) return h;
    }
    return null;
  }

  /** Acquire all keys atomically, or none. Returns the conflicting key and holder on failure. */
  tryAcquire(keys: string[], holder: string): { ok: true } | { ok: false; key: string; holder: string } {
    for (const k of keys) {
      const h = this.conflicts(k, holder);
      if (h) return { ok: false, key: k, holder: h };
    }
    for (const k of keys) this.held.set(k, holder);
    return { ok: true };
  }

  release(holder: string): void {
    for (const [k, h] of [...this.held]) if (h === holder) this.held.delete(k);
  }

  get size(): number {
    return this.held.size;
  }

  snapshot(): { key: string; holder: string }[] {
    return [...this.held].map(([key, holder]) => ({ key, holder }));
  }
}
