/** Small seeded statistics helpers for the paired bench. No dependencies. */

/** mulberry32: deterministic PRNG in [0, 1) from a 32-bit seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle with a seeded PRNG; returns a new array. */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Linear-interpolated quantile (q in [0,1]); null for an empty list. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export const median = (values: readonly number[]): number | null => quantile(values, 0.5);

export const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

export interface Interval {
  estimate: number | null;
  lo: number | null;
  hi: number | null;
  n: number;
}

/**
 * Percentile bootstrap 95% interval of `stat` over independent units (tasks), fixed seed.
 * With fewer than 2 units the interval is null: one task cannot express its own uncertainty.
 */
export function bootstrap(values: readonly number[], stat: (v: readonly number[]) => number | null = median, seed = 1, resamples = 2000): Interval {
  const estimate = stat(values);
  if (values.length < 2) return { estimate, lo: null, hi: null, n: values.length };
  const next = rng(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample = values.map(() => values[Math.floor(next() * values.length)]!);
    const s = stat(sample);
    if (s !== null) stats.push(s);
  }
  return { estimate, lo: quantile(stats, 0.025), hi: quantile(stats, 0.975), n: values.length };
}
