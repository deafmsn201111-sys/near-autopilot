import { describe, expect, it } from 'vitest';
import {
  absBig,
  hodlValueToken1,
  impermanentLossConcentrated,
  impermanentLossFullRangeWad,
  isqrt,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  Q96,
  sqrtRatioAtTick,
  WAD,
} from '../src';
import { forAll } from './support/prop';

const e18 = 10n ** 18n;
const root = (k: bigint) => k * Q96;

describe('impermanentLossFullRangeWad: closed form 2*sqrt(r)/(1+r) - 1', () => {
  it('exact cases: r = 1 -> 0, r = 4 and r = 1/4 -> exactly -20%', () => {
    expect(impermanentLossFullRangeWad(WAD)).toBe(0n);
    expect(impermanentLossFullRangeWad(4n * WAD)).toBe(-(WAD / 5n));
    expect(impermanentLossFullRangeWad(WAD / 4n)).toBe(-(WAD / 5n));
  });

  it('reference values (Python decimal, 150 digits; tolerance 2e-18 from the floored square root)', () => {
    const cases: Array<[bigint, bigint]> = [
      [2n * WAD, -57_190_958_417_936_634n], // r = 2: -5.7191%
      [WAD / 2n, -57_190_958_417_936_634n],
      [10n * WAD, -425_040_425_423_931_031n],
      [WAD / 100n, -801_980_198_019_801_980n],
      [WAD + WAD / 100n, -12_376_007_871_615n], // r = 1.01
    ];
    for (const [r, expected] of cases)
      expect(absBig(impermanentLossFullRangeWad(r) - expected) <= 2n).toBe(true);
  });

  it('rejects non-positive ratios', () => {
    expect(() => impermanentLossFullRangeWad(0n)).toThrow(RangeError);
    expect(() => impermanentLossFullRangeWad(-1n)).toThrow(RangeError);
  });

  it('property: never positive, zero only at r = 1, symmetric under r -> 1/r, and worse the further r is from 1', () => {
    forAll(
      {},
      (g) => ({ r: g.big(WAD / 1000n, 1000n * WAD) }),
      ({ r }) => {
        const il = impermanentLossFullRangeWad(r);
        expect(il <= 0n).toBe(true);
        expect(il > -WAD).toBe(true); // can approach but never reach -100%
        const inverse = impermanentLossFullRangeWad((WAD * WAD) / r);
        expect(absBig(il - inverse) <= 1_000n).toBe(true); // only the rounding of 1/r itself separates them
        const further = impermanentLossFullRangeWad(r > WAD ? r + r / 10n + 1n : r - r / 10n);
        expect(further <= il + 2n).toBe(true);
      },
    );
  });
});

describe('impermanentLossConcentrated: exact fixtures (sqrt range [1, 3], L = 6e18, entry price 4)', () => {
  const shape = { sqrtLower: root(1n), sqrtUpper: root(3n), liquidity: 6n * e18 };
  const run = (exit: bigint) =>
    impermanentLossConcentrated({ shape, entrySqrtPrice: root(2n), exitSqrtPrice: exit });

  it('entry basket is 1e18 token0 + 6e18 token1', () => {
    const r = run(root(2n));
    expect([r.entryAmount0, r.entryAmount1]).toEqual([e18, 6n * e18]);
  });
  it('no price move -> no impermanent loss', () => {
    const r = run(root(2n));
    expect(r.ilToken1).toBe(0n);
    expect(r.ilWad).toBe(0n);
    expect(r.positionValueToken1).toBe(r.hodlValueToken1);
  });
  it('exit above the range at price 9: 12e18 vs 15e18 held -> exactly -20%', () => {
    const r = run(root(3n));
    expect([r.positionValueToken1, r.hodlValueToken1, r.ilToken1]).toEqual([
      12n * e18,
      15n * e18,
      -3n * e18,
    ]);
    expect(r.ilWad).toBe(-(WAD / 5n));
  });
  it('exit at the lower bound, price 1: 4e18 vs 7e18 held -> -3/7, rounded toward -infinity', () => {
    const r = run(root(1n));
    expect([r.positionValueToken1, r.hodlValueToken1]).toEqual([4n * e18, 7n * e18]);
    expect(r.ilWad).toBe(-428_571_428_571_428_572n);
  });
  it('exit far above the range at price 16: 12e18 vs 22e18 held', () => {
    const r = run(root(4n));
    expect(r.hodlValueToken1).toBe(22n * e18);
    expect(r.ilWad).toBe(-454_545_454_545_454_546n);
  });
  it('rejects a zero-value basket', () => {
    expect(() =>
      impermanentLossConcentrated({
        shape: { ...shape, liquidity: 0n },
        entrySqrtPrice: root(2n),
        exitSqrtPrice: root(3n),
      }),
    ).toThrow('undefined');
  });
  it('hodlValueToken1 values the basket at a price', () => {
    expect(hodlValueToken1(e18, 6n * e18, root(3n))).toBe(15n * e18);
  });
});

describe('concentrated vs full-range', () => {
  it('a (practically) full-range position reproduces the closed form', () => {
    const shape = { sqrtLower: MIN_SQRT_RATIO, sqrtUpper: MAX_SQRT_RATIO, liquidity: 10n ** 26n };
    for (const r of [2n * WAD, 4n * WAD, WAD / 3n, 10n * WAD]) {
      const exit = isqrt((r * (1n << 192n)) / WAD); // sqrt(r) in Q96, entry price 1
      const cl = impermanentLossConcentrated({ shape, entrySqrtPrice: Q96, exitSqrtPrice: exit });
      const closed = impermanentLossFullRangeWad(r);
      expect(absBig(cl.ilWad - closed) < 10n ** 9n).toBe(true); // 1e-9 absolute: Q96 rounding of sqrt(r), range truncation
    }
  });
});

describe('properties of concentrated IL', () => {
  const gen = (g: import('./support/prop').Gen) => {
    const a = g.int(-100_000, 90_000);
    const b = a + g.int(20, 40_000);
    return {
      shape: {
        sqrtLower: sqrtRatioAtTick(a),
        sqrtUpper: sqrtRatioAtTick(b),
        liquidity: g.big(10n ** 15n, 10n ** 27n),
      },
      entry: sqrtRatioAtTick(g.int(a - 5_000, b + 5_000)),
      exitTick: g.int(a - 30_000, b + 30_000),
    };
  };

  it('IL is never positive, even with rounding (HODL rounds up, position rounds down)', () => {
    forAll({ runs: 400 }, gen, ({ shape, entry, exitTick }) => {
      const exit = sqrtRatioAtTick(Math.max(-887_000, Math.min(887_000, exitTick)));
      const r = impermanentLossConcentrated({ shape, entrySqrtPrice: entry, exitSqrtPrice: exit });
      expect(r.ilToken1 <= 0n && r.ilWad <= 0n).toBe(true);
      expect(r.positionValueToken1 <= r.hodlValueToken1).toBe(true);
    });
  });

  it('the loss (in token1) grows monotonically as the exit price moves away from entry, on each side', () => {
    // Position over ticks [-30000, 30000], entered at tick 0. Position value is concave and tangent to the HODL line
    // at entry, so the gap (hold - position) can only widen as the exit moves away, whichever way.
    const shape = (L: bigint) => ({
      sqrtLower: sqrtRatioAtTick(-30_000),
      sqrtUpper: sqrtRatioAtTick(30_000),
      liquidity: L,
    });
    forAll(
      { runs: 300 },
      (g) => ({ L: g.big(10n ** 15n, 10n ** 27n), k1: g.int(1, 60_000), k2: g.int(1, 60_000) }),
      ({ L, k1, k2 }) => {
        const [near, far] = k1 <= k2 ? [k1, k2] : [k2, k1];
        const gap = (tick: number) =>
          -impermanentLossConcentrated({
            shape: shape(L),
            entrySqrtPrice: sqrtRatioAtTick(0),
            exitSqrtPrice: sqrtRatioAtTick(tick),
          }).ilToken1;
        const tolerance = 4n; // each of the two floor/ceil roundings can move a value by a couple of units
        expect(gap(far) + tolerance >= gap(near)).toBe(true);
        expect(gap(-far) + tolerance >= gap(-near)).toBe(true);
      },
    );
  });
});
