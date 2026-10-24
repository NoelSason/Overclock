/** Small numeric helpers shared by the optimizer, scheduler, and benchmark reports. */

export class Ewma {
  private v: number | null = null;
  n = 0;
  constructor(
    private readonly alpha = 0.3,
    readonly prior?: number,
  ) {}
  add(x: number): void {
    this.n++;
    this.v = this.v === null ? x : this.alpha * x + (1 - this.alpha) * this.v;
  }
  get value(): number | null {
    return this.v ?? this.prior ?? null;
  }
  get measured(): boolean {
    return this.v !== null;
  }
}

export function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

export function percentile(xs: number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
