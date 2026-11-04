/**
 * Minimal deterministic property-testing harness (seeded PRNG + generators), written because `fast-check` could not be
 * installed in the build sandbox (no registry access), and untested test code is worse than a small tested harness.
 * Semantics follow the usual contract: `forAll` draws `runs` inputs, runs the check on each, and on the first failure
 * throws with the seed, case index and the input so the failure replays exactly (run with the same seed).
 * Differences from fast-check: no automatic shrinking (generators are biased toward small and boundary values instead),
 * and generation is not coverage-guided. Swapping in fast-check later only requires re-expressing `forAll` call sites.
 */

/** mulberry32: small, fast, fully deterministic 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Gen {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** Uniform integer in [lo, hi] (numbers). */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new RangeError('empty range');
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  bool(): boolean {
    return this.next() < 0.5;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** Uniform bigint in [lo, hi], built from 32-bit draws so any width works. */
  big(lo: bigint, hi: bigint): bigint {
    if (hi < lo) throw new RangeError('empty range');
    const span = hi - lo + 1n;
    const words = Math.ceil(span.toString(2).length / 32) + 2; // extra words make modulo bias negligible (< 2^-64)
    let acc = 0n;
    for (let i = 0; i < words; i += 1)
      acc = (acc << 32n) | BigInt(Math.floor(this.next() * 4294967296));
    return lo + (acc % span);
  }

  /**
   * Bigint biased toward interesting values: ~15% boundaries (lo, lo+1, hi-1, hi), ~35% "small" (near lo), rest uniform.
   */
  bigBiased(lo: bigint, hi: bigint): bigint {
    const r = this.next();
    if (r < 0.15)
      return this.pick([lo, lo + 1n > hi ? hi : lo + 1n, hi - 1n < lo ? lo : hi - 1n, hi]);
    if (r < 0.5) {
      const smallHi = lo + (hi - lo) / 1000n;
      return this.big(lo, smallHi < lo ? lo : smallHi);
    }
    return this.big(lo, hi);
  }
}

export interface PropOptions {
  readonly runs?: number;
  readonly seed?: number;
}

const show = (v: unknown): string => {
  try {
    return JSON.stringify(v, (_k: string, x: unknown): unknown =>
      typeof x === 'bigint' ? `${x}n` : x instanceof Map ? { Map: [...x.entries()] } : x,
    );
  } catch {
    return String(v);
  }
};

export const DEFAULT_RUNS = 300;

/** Runs `check` against `runs` generated inputs. Deterministic for a given seed. */
export function forAll<T>(
  options: PropOptions,
  generate: (g: Gen) => T,
  check: (input: T, g: Gen) => void,
): void {
  const runs = options.runs ?? DEFAULT_RUNS;
  const seed = options.seed ?? 0x5eed;
  for (let i = 0; i < runs; i += 1) {
    const g = new Gen(seed + i * 7919);
    const input = generate(g);
    try {
      check(input, g);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `property failed at case ${i} (seed ${seed + i * 7919}): ${message}\n  input: ${show(input)}`,
      );
    }
  }
}
