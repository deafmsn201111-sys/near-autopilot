import { describe, expect, it } from 'vitest';
import { forAll, Gen } from './prop';

describe('property harness itself', () => {
  it('is deterministic for a seed', () => {
    const a = new Gen(42);
    const b = new Gen(42);
    expect([a.int(0, 1000), a.big(0n, 10n ** 40n), a.bool()]).toEqual([
      b.int(0, 1000),
      b.big(0n, 10n ** 40n),
      b.bool(),
    ]);
  });

  it('respects inclusive bounds and reaches both ends', () => {
    const g = new Gen(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(g.int(3, 6));
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    for (let i = 0; i < 500; i += 1) {
      const v = g.big(-5n, 5n);
      expect(v >= -5n && v <= 5n).toBe(true);
    }
  });

  it('bigBiased stays in range and hits the boundaries', () => {
    const g = new Gen(2);
    const seen = new Set<bigint>();
    for (let i = 0; i < 400; i += 1) {
      const v = g.bigBiased(10n, 10n ** 12n);
      expect(v >= 10n && v <= 10n ** 12n).toBe(true);
      seen.add(v);
    }
    expect(seen.has(10n) && seen.has(10n ** 12n)).toBe(true);
  });

  it('reports the seed and input of a failing case, and a failing property really fails', () => {
    let message = '';
    try {
      forAll(
        { runs: 50, seed: 7 },
        (g) => g.int(0, 10),
        (n) => {
          if (n === 10) throw new Error('boom');
        },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('property failed at case');
    expect(message).toContain('seed');
    expect(message).toContain('input: 10');
  });
});
