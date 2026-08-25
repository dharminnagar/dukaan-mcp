/**
 * The eval suite's ONLY source of randomness. No `Math.random()`, no
 * `Date.now()`, no unseeded anything — a seeded generator run twice must
 * produce byte-identical transcripts, or the train/held-out split's
 * "frozen before any results were seen" guarantee is unenforceable. See
 * src/eval/dataset.ts for where the seed is fixed.
 *
 * mulberry32: a small, well-known 32-bit PRNG. Not cryptographic — it does
 * not need to be, this is test-fixture generation, not a security boundary.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max], inclusive on both ends. */
export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) {
    throw new Error('pick: cannot choose from an empty array');
  }
  const item = items[randInt(rng, 0, items.length - 1)];
  if (item === undefined) {
    throw new Error('pick: index out of range (unreachable)');
  }
  return item;
}

/** Fisher-Yates, driven entirely by `rng`. Does not mutate `items`. */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    const a = result[i]!;
    const b = result[j]!;
    result[i] = b;
    result[j] = a;
  }
  return result;
}
