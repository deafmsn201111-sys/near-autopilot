import { describe, expect, it } from 'vitest';
import {
  amount0Delta,
  amount1Delta,
  amountsForLiquidity,
  feeGrowthInsideX128,
  feesOwed,
  liquidityForAmounts,
  MAX_SQRT_RATIO,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MIN_TICK,
  positionValueInToken1,
  Q128,
  Q192,
  Q96,
  rangeState,
  sqrtRatioAtTick,
  subMod256,
  tickAtSqrtRatio,
  token0ValueInToken1,
  token1ValueInToken0,
  absBig,
} from '../src';
import { forAll, type Gen } from './support/prop';

const e18 = 10n ** 18n;
/** Exact integer square roots make exact fixtures: sqrt(P) = k * 2^96 for P = k^2. */
const root = (k: bigint) => k * Q96;

describe('sqrtRatioAtTick: independent reference values', () => {
  // Generated with Python `decimal` at 150 digits, rounded to nearest. Not produced by this code.
  const reference: Array<[number, bigint]> = [
    [-887272, 4295128738n],
    [-250000, 295440463448801648376845n],
    [-60, 78990846045029531151608375686n],
    [-1, 79224201403219477170569942573n],
    [0, 79228162514264337593543950336n],
    [1, 79232123823359799118286999567n],
    [60, 79466191966197645195421774832n],
    [12345, 146870458338965608271414022015n],
    [100000, 11755562826496067164730007768450n],
    [887272, 1461446703485210103244672773810124308346321380903n],
  ];
  for (const [tick, expected] of reference) {
    it(`tick ${tick}`, () => expect(sqrtRatioAtTick(tick)).toBe(expected));
  }

  it('tick 0 is exactly 2^96', () => expect(sqrtRatioAtTick(0)).toBe(Q96));

  it('agrees with the published Uniswap v3 extreme constants to within their own table error', () => {
    // Uniswap rounds MIN up (4295128739) and its MAX carries ~3e-20 relative table error.
    expect(absBig(MIN_SQRT_RATIO - 4295128739n)).toBeLessThanOrEqual(1n);
    const uniMax = 1461446703485210103287273052203988822378723970342n;
    expect(absBig(MAX_SQRT_RATIO - uniMax) * 10n ** 18n < uniMax).toBe(true);
  });

  it('rejects out-of-range and non-integer ticks', () => {
    expect(() => sqrtRatioAtTick(MIN_TICK - 1)).toThrow(RangeError);
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => sqrtRatioAtTick(1.5)).toThrow(RangeError);
    expect(() => sqrtRatioAtTick(NaN)).toThrow(RangeError);
  });

  it('property: strictly increasing, and each tick multiplies the price by 1.0001', () => {
    forAll(
      {},
      (g) => g.int(MIN_TICK, MAX_TICK - 1),
      (t) => {
        const a = sqrtRatioAtTick(t);
        const b = sqrtRatioAtTick(t + 1);
        expect(b > a).toBe(true);
        if (t > -400_000 && t < 400_000) {
          // (b/a)^2 = 1.0001  <=>  b^2 * 10000 = a^2 * 10001, up to the Q96 rounding of a and b.
          const lhs = b * b * 10_000n;
          const rhs = a * a * 10_001n;
          expect(absBig(lhs - rhs) * 10n ** 15n < rhs).toBe(true);
        }
      },
    );
  });

  it('property: reciprocal symmetry sqrt(t) * sqrt(-t) ~= 2^192', () => {
    forAll(
      {},
      (g) => g.int(0, 300_000),
      (t) => {
        const prod = sqrtRatioAtTick(t) * sqrtRatioAtTick(-t);
        // relative error bounded by Q96 rounding of the smaller factor
        const tol = Q192 / sqrtRatioAtTick(-t) + Q192 / sqrtRatioAtTick(t) + 4n;
        expect(absBig(prod - Q192) <= tol).toBe(true);
      },
    );
  });
});

describe('tickAtSqrtRatio', () => {
  it('inverts sqrtRatioAtTick', () => {
    for (const t of [MIN_TICK, -887271, -100000, -1, 0, 1, 60, 99999, 887271])
      expect(tickAtSqrtRatio(sqrtRatioAtTick(t))).toBe(t);
    expect(tickAtSqrtRatio(MAX_SQRT_RATIO)).toBe(MAX_TICK);
  });
  it('is a floor: values just below the next tick map to the lower tick', () => {
    expect(tickAtSqrtRatio(sqrtRatioAtTick(500) + 1n)).toBe(500);
    expect(tickAtSqrtRatio(sqrtRatioAtTick(501) - 1n)).toBe(500);
  });
  it('rejects out-of-range prices', () => {
    expect(() => tickAtSqrtRatio(MIN_SQRT_RATIO - 1n)).toThrow(RangeError);
    expect(() => tickAtSqrtRatio(MAX_SQRT_RATIO + 1n)).toThrow(RangeError);
  });
  it('property: floor-inverse', () => {
    forAll(
      { runs: 150 },
      (g) => ({ t: g.int(MIN_TICK, MAX_TICK - 1), g: g.int(0, 1000) }),
      ({ t, g }) => {
        const lo = sqrtRatioAtTick(t);
        const hi = sqrtRatioAtTick(t + 1);
        const s = lo + ((hi - lo) * BigInt(g)) / 1001n;
        const found = tickAtSqrtRatio(s);
        expect(sqrtRatioAtTick(found) <= s && s < sqrtRatioAtTick(found + 1)).toBe(true);
      },
    );
  });
});

describe('amounts: exact fixture (range sqrtP in [1,3], i.e. price [1,9], price 4, L = 6e18)', () => {
  const shape = { sqrtLower: root(1n), sqrtUpper: root(3n), liquidity: 6n * e18 };
  it('x = L(1/2 - 1/3) = 1e18 and y = L(2 - 1) = 6e18, exactly', () => {
    for (const mode of ['floor', 'ceil'] as const) {
      const a = amountsForLiquidity(root(2n), shape, mode);
      expect(a).toEqual({ amount0: e18, amount1: 6n * e18, state: 'in-range' });
    }
  });
  it('below the range the position is all token0: L(1/1 - 1/3) = 4e18', () => {
    expect(amountsForLiquidity(root(1n) - 1n, shape, 'floor').amount1).toBe(0n);
    const at = amountsForLiquidity(root(1n), shape, 'floor');
    expect(at).toEqual({ amount0: 4n * e18, amount1: 0n, state: 'in-range' }); // lower bound is inclusive
  });
  it('at and above the upper bound the position is all token1: L(3 - 1) = 12e18', () => {
    expect(amountsForLiquidity(root(3n), shape, 'floor')).toEqual({
      amount0: 0n,
      amount1: 12n * e18,
      state: 'above',
    });
    expect(amountsForLiquidity(root(5n), shape, 'floor')).toEqual({
      amount0: 0n,
      amount1: 12n * e18,
      state: 'above',
    });
  });
  it('range states at the boundaries', () => {
    expect(rangeState(root(1n) - 1n, root(1n), root(3n))).toBe('below');
    expect(rangeState(root(1n), root(1n), root(3n))).toBe('in-range');
    expect(rangeState(root(3n) - 1n, root(1n), root(3n))).toBe('in-range');
    expect(rangeState(root(3n), root(1n), root(3n))).toBe('above');
  });
  it('liquidityForAmounts inverts it', () => {
    expect(
      liquidityForAmounts({
        sqrtPrice: root(2n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: e18,
        amount1: 6n * e18,
      }),
    ).toBe(6n * e18);
    // The scarcer token limits liquidity.
    expect(
      liquidityForAmounts({
        sqrtPrice: root(2n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: e18 / 2n,
        amount1: 6n * e18,
      }),
    ).toBe(3n * e18);
    expect(
      liquidityForAmounts({
        sqrtPrice: root(2n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: e18,
        amount1: 3n * e18,
      }),
    ).toBe(3n * e18);
  });
  it('single-sided funding outside the range', () => {
    expect(
      liquidityForAmounts({
        sqrtPrice: root(1n) - 1n,
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: 4n * e18,
        amount1: 999n,
      }),
    ).toBe(6n * e18);
    expect(
      liquidityForAmounts({
        sqrtPrice: root(3n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: 999n,
        amount1: 12n * e18,
      }),
    ).toBe(6n * e18);
    // price exactly at the lower bound holds only token0: token1 is ignored and nothing divides by zero (regression: found by fuzzing)
    expect(
      liquidityForAmounts({
        sqrtPrice: root(1n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: 4n * e18,
        amount1: 999n,
      }),
    ).toBe(6n * e18);
  });
  it('position value in token1: 1e18 * 4 + 6e18 = 10e18 at price 4', () => {
    expect(positionValueInToken1(root(2n), shape)).toBe(10n * e18);
    expect(positionValueInToken1(root(3n), shape)).toBe(12n * e18); // above range: all token1
    expect(positionValueInToken1(root(1n), shape)).toBe(4n * e18); // price 1: 4e18 token0 * 1
  });
});

describe('boundary and error behaviour', () => {
  it('zero liquidity is worth nothing', () => {
    expect(
      amountsForLiquidity(
        root(2n),
        { sqrtLower: root(1n), sqrtUpper: root(3n), liquidity: 0n },
        'ceil',
      ),
    ).toEqual({ amount0: 0n, amount1: 0n, state: 'in-range' });
  });
  it('rejects malformed ranges and negative inputs', () => {
    expect(() => rangeState(1n, 0n, 5n)).toThrow(RangeError);
    expect(() => rangeState(1n, 5n, 5n)).toThrow(RangeError);
    expect(() => rangeState(1n, 6n, 5n)).toThrow(RangeError);
    expect(() => amount0Delta(0n, 5n, 1n, 'floor')).toThrow(RangeError);
    expect(() => amount1Delta(1n, 5n, -1n, 'floor')).toThrow(RangeError);
    expect(() =>
      liquidityForAmounts({
        sqrtPrice: root(2n),
        sqrtLower: root(1n),
        sqrtUpper: root(3n),
        amount0: -1n,
        amount1: 0n,
      }),
    ).toThrow(RangeError);
  });
  it('amount deltas are symmetric in their price arguments', () => {
    expect(amount0Delta(root(3n), root(2n), 6n * e18, 'floor')).toBe(
      amount0Delta(root(2n), root(3n), 6n * e18, 'floor'),
    );
    expect(amount1Delta(root(3n), root(2n), 6n * e18, 'ceil')).toBe(
      amount1Delta(root(2n), root(3n), 6n * e18, 'ceil'),
    );
  });
  it('handles extreme but valid inputs without overflow (bigint)', () => {
    const shape = { sqrtLower: MIN_SQRT_RATIO, sqrtUpper: MAX_SQRT_RATIO, liquidity: 2n ** 127n };
    const a = amountsForLiquidity(Q96, shape, 'floor');
    expect(a.amount0 > 0n && a.amount1 > 0n).toBe(true);
  });
  it('token value conversions: P = 4 -> 1 token0 is 4 token1 and back', () => {
    expect(token0ValueInToken1(e18, root(2n), 'floor')).toBe(4n * e18);
    expect(token1ValueInToken0(4n * e18, root(2n), 'floor')).toBe(e18);
    expect(() => token1ValueInToken0(1n, 0n, 'floor')).toThrow(RangeError);
    expect(() => token0ValueInToken1(-1n, Q96, 'floor')).toThrow(RangeError);
  });
});

interface RandomPosition {
  sqrtLower: bigint;
  sqrtUpper: bigint;
  sqrtPrice: bigint;
  liquidity: bigint;
}
function randomPosition(g: Gen): RandomPosition {
  const a = g.int(-200_000, 190_000);
  const b = a + g.int(10, 60_000);
  const t = g.int(a - 20_000, b + 20_000);
  return {
    sqrtLower: sqrtRatioAtTick(a),
    sqrtUpper: sqrtRatioAtTick(b),
    sqrtPrice: sqrtRatioAtTick(Math.max(MIN_TICK, Math.min(MAX_TICK, t))),
    liquidity: g.bigBiased(0n, 10n ** 24n),
  };
}

describe('properties of concentrated-liquidity amounts', () => {
  it('floor <= ceil, differing by at most 2 units per token', () => {
    forAll({}, randomPosition, (p) => {
      const shape = { sqrtLower: p.sqrtLower, sqrtUpper: p.sqrtUpper, liquidity: p.liquidity };
      const f = amountsForLiquidity(p.sqrtPrice, shape, 'floor');
      const c = amountsForLiquidity(p.sqrtPrice, shape, 'ceil');
      expect(c.amount0 >= f.amount0 && c.amount0 - f.amount0 <= 2n).toBe(true);
      expect(c.amount1 >= f.amount1 && c.amount1 - f.amount1 <= 2n).toBe(true);
    });
  });

  it('liquidityForAmounts never over-funds: withdrawable amounts for that liquidity are <= what was supplied', () => {
    forAll(
      {},
      (g) => ({
        p: randomPosition(g),
        a0: g.bigBiased(0n, 10n ** 27n),
        a1: g.bigBiased(0n, 10n ** 27n),
      }),
      ({ p, a0, a1 }) => {
        const L = liquidityForAmounts({
          sqrtPrice: p.sqrtPrice,
          sqrtLower: p.sqrtLower,
          sqrtUpper: p.sqrtUpper,
          amount0: a0,
          amount1: a1,
        });
        const out = amountsForLiquidity(
          p.sqrtPrice,
          { sqrtLower: p.sqrtLower, sqrtUpper: p.sqrtUpper, liquidity: L },
          'floor',
        );
        expect(out.amount0 <= a0 && out.amount1 <= a1).toBe(true);
      },
    );
  });

  it('amounts are monotone non-decreasing in liquidity and scale linearly (within rounding)', () => {
    forAll(
      {},
      (g) => ({ p: randomPosition(g), k: g.int(2, 9) }),
      ({ p, k }) => {
        const base = { sqrtLower: p.sqrtLower, sqrtUpper: p.sqrtUpper, liquidity: p.liquidity };
        const big = { ...base, liquidity: p.liquidity * BigInt(k) };
        const a = amountsForLiquidity(p.sqrtPrice, base, 'floor');
        const b = amountsForLiquidity(p.sqrtPrice, big, 'floor');
        expect(b.amount0 >= a.amount0 && b.amount1 >= a.amount1).toBe(true);
        expect(
          b.amount0 <= a.amount0 * BigInt(k) + BigInt(k) &&
            b.amount1 <= a.amount1 * BigInt(k) + BigInt(k),
        ).toBe(true);
      },
    );
  });

  it('value is continuous across the range boundaries and non-decreasing in price (within 3 units)', () => {
    forAll(
      {},
      (g) => ({ p: randomPosition(g), t1: g.int(-250_000, 250_000), t2: g.int(-250_000, 250_000) }),
      ({ p, t1, t2 }) => {
        const shape = { sqrtLower: p.sqrtLower, sqrtUpper: p.sqrtUpper, liquidity: p.liquidity };
        const [lo, hi] = t1 <= t2 ? [t1, t2] : [t2, t1];
        const vLo = positionValueInToken1(sqrtRatioAtTick(lo), shape);
        const vHi = positionValueInToken1(sqrtRatioAtTick(hi), shape);
        // d(value)/d(price) = amount0 >= 0. Allow for floor rounding of each term.
        expect(vHi + 3n >= vLo).toBe(true);
      },
    );
  });
});

describe('fee growth accounting', () => {
  it('feesOwed: liquidity * (growthNow - growthLast) / 2^128, rounded down', () => {
    expect(
      feesOwed({
        liquidity: 1000n,
        feeGrowthInsideNowX128: 5n * Q128,
        feeGrowthInsideLastX128: 2n * Q128,
      }),
    ).toBe(3000n);
    expect(
      feesOwed({ liquidity: 3n, feeGrowthInsideNowX128: Q128 / 2n, feeGrowthInsideLastX128: 0n }),
    ).toBe(1n); // 1.5 -> 1
    expect(
      feesOwed({ liquidity: 0n, feeGrowthInsideNowX128: Q128, feeGrowthInsideLastX128: 0n }),
    ).toBe(0n);
    expect(
      feesOwed({ liquidity: 7n, feeGrowthInsideNowX128: 9n, feeGrowthInsideLastX128: 9n }),
    ).toBe(0n);
  });

  it('survives uint256 wraparound of the accumulator', () => {
    const last = 2n ** 256n - Q128; // about to wrap
    const now = Q128; // wrapped past zero: true delta is 2 * Q128
    expect(
      feesOwed({ liquidity: 10n, feeGrowthInsideNowX128: now, feeGrowthInsideLastX128: last }),
    ).toBe(20n);
    expect(subMod256(0n, 1n)).toBe(2n ** 256n - 1n);
    expect(subMod256(5n, 3n)).toBe(2n);
  });

  it('fee growth inside = global - below - above, depending on where the tick sits', () => {
    const base = {
      tickLower: -100,
      tickUpper: 100,
      feeGrowthGlobalX128: 1000n,
      feeGrowthOutsideLowerX128: 100n,
      feeGrowthOutsideUpperX128: 50n,
    };
    expect(feeGrowthInsideX128({ ...base, tickCurrent: 0 })).toBe(850n); // inside: 1000 - 100 - 50
    // below the range: below = global - outsideLower = 900, above = outsideUpper = 50 -> 1000 - 900 - 50
    expect(feeGrowthInsideX128({ ...base, tickCurrent: -101 })).toBe(50n);
    // at the upper tick the price is outside (above): below = 100, above = global - outsideUpper = 950 -> -50 (mod 2^256)
    expect(feeGrowthInsideX128({ ...base, tickCurrent: 100 })).toBe(2n ** 256n - 50n);
  });

  it('rejects an inverted tick range', () => {
    expect(() =>
      feeGrowthInsideX128({
        tickLower: 5,
        tickUpper: 5,
        tickCurrent: 0,
        feeGrowthGlobalX128: 0n,
        feeGrowthOutsideLowerX128: 0n,
        feeGrowthOutsideUpperX128: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('property: a position only accrues what the global accumulator gained while price was inside', () => {
    forAll(
      {},
      (g) => ({ gain: g.bigBiased(0n, 10n ** 30n), L: g.bigBiased(0n, 10n ** 24n) }),
      ({ gain, L }) => {
        const tickParams = {
          tickLower: -50,
          tickUpper: 50,
          tickCurrent: 0,
          feeGrowthOutsideLowerX128: 0n,
          feeGrowthOutsideUpperX128: 0n,
        };
        const before = feeGrowthInsideX128({ ...tickParams, feeGrowthGlobalX128: 777n });
        const after = feeGrowthInsideX128({ ...tickParams, feeGrowthGlobalX128: 777n + gain });
        expect(
          feesOwed({
            liquidity: L,
            feeGrowthInsideNowX128: after,
            feeGrowthInsideLastX128: before,
          }),
        ).toBe((gain * L) / Q128);
      },
    );
  });
});
