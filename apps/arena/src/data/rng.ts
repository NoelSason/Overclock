/** Deterministic PRNG (mulberry32) so every scenario seed reproduces exactly. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) ^ 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  weighted<T extends string>(w: Partial<Record<T, number>>): T {
    const entries = Object.entries(w).filter(([, v]) => typeof v === "number") as [T, number][];
    const total = entries.reduce((s, [, v]) => s + v, 0);
    let r = this.next() * total;
    for (const [k, v] of entries) {
      r -= v;
      if (r <= 0) return k;
    }
    return entries.at(-1)![0];
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
}
