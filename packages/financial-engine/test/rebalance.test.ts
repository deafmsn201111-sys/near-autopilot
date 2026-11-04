import { describe, expect, it } from 'vitest';
import {
  amountsForLiquidity,
  concentratedQuoteExactIn,
  liquidityForAmounts,
  Q96,
  rebalanceCost,
  solveRebalance,
  sqrtRatioAtTick,
  valueInToken1,
  type LiquiditySegment,
} from '../src';
import { forAll } from './support/prop';

const t = sqrtRatioAtTick;
const deep = (L = 10n ** 26n): LiquiditySegment[] => [
  { sqrtLower: t(-3000), sqrtUpper: t(3000), liquidity: L },
];
const price0 = t(0); // price 1.0: token0 and token1 trade 1:1 so values are easy to read
const base = { sqrtPrice: price0, segments: deep(), feePpm: 3000, gasQuote: 0n };
const e18 = 10n ** 18n;

describe('rebalanceCost: fixtures', () => {
  it('already balanced for the new range -> no meaningful swap, deposit nearly everything', () => {
    const range = { newLower: t(-600), newUpper: t(600) };
    const L = 10n ** 22n;
    const h = amountsForLiquidity(
      price0,
      { sqrtLower: range.newLower, sqrtUpper: range.newUpper, liquidity: L },
      'ceil',
    );
    const r = rebalanceCost({ ...base, ...range, holdings0: h.amount0, holdings1: h.amount1 });
    expect(r.solution.liquidity >= L - 2n).toBe(true);
    expect(r.totalCostBps <= 1n).toBe(true);
    expect(r.solution.leftover.amount0 + r.solution.leftover.amount1 <= 4n).toBe(true);
  });

  it('all token0 into a range around the price: sells about half, pays ~0.15% fee plus tiny impact', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.solution.swap?.zeroForOne).toBe(true);
    const sold = r.solution.swap!.quote.amountInConsumed;
    expect(sold > 480n * e18 && sold < 520n * e18).toBe(true);
    // fee 0.30% of ~half the portfolio = ~15 bps; impact in this deep pool is a fraction of a bp
    expect(r.totalCostBps >= 14n && r.totalCostBps <= 18n).toBe(true);
    expect(r.poolFeeQuote > 0n && r.swapCostQuote >= r.poolFeeQuote).toBe(true);
    // almost nothing is left over, valued at spot
    const leftover = valueInToken1(r.solution.leftover, price0, 'ceil');
    expect(leftover * 10_000n < r.valueBeforeQuote).toBe(true); // < 1 bp
  });

  it('mirror image: all token1 sells token1', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 0n,
      holdings1: 1000n * e18,
    });
    expect(r.solution.swap?.zeroForOne).toBe(false);
    expect(r.totalCostBps >= 14n && r.totalCostBps <= 18n).toBe(true);
  });

  it('range wholly ABOVE the price needs only token0: all token1 is sold', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(600),
      newUpper: t(1200),
      holdings0: 0n,
      holdings1: 1000n * e18,
    });
    expect(r.solution.swap?.zeroForOne).toBe(false);
    expect(r.solution.swap!.quote.amountInConsumed).toBe(1000n * e18);
    expect(r.solution.leftover.amount1).toBe(0n);
    expect(r.solution.liquidity > 0n).toBe(true);
    expect(r.totalCostBps >= 29n && r.totalCostBps <= 33n).toBe(true); // whole position pays the 0.30% fee
  });

  it('range wholly BELOW the price needs only token1: all token0 is sold', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(-1200),
      newUpper: t(-600),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.solution.swap?.zeroForOne).toBe(true);
    expect(r.solution.swap!.quote.amountInConsumed).toBe(1000n * e18);
    expect(r.solution.leftover.amount0).toBe(0n);
  });

  it('holdings already single-sided in the right token need no swap', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(600),
      newUpper: t(1200),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.solution.swap).toBeNull();
    expect(r.swapCostQuote).toBe(0n);
    expect(r.totalCostQuote).toBe(0n);
  });

  it('empty holdings: nothing to do', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 0n,
      holdings1: 0n,
    });
    expect(r.solution.swap).toBeNull();
    expect(r.solution.liquidity).toBe(0n);
    expect(r.totalCostBps).toBe(0n);
  });

  it('gas and other costs add exactly, and are reflected in bps of the position', () => {
    const noGas = rebalanceCost({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    const withGas = rebalanceCost({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 1000n * e18,
      holdings1: 0n,
      gasQuote: 5n * e18,
      otherCostQuote: 2n * e18,
    });
    expect(withGas.totalCostQuote).toBe(noGas.swapCostQuote + 7n * e18);
    expect(withGas.swapCostQuote).toBe(noGas.swapCostQuote);
    expect(withGas.totalCostBps > noGas.totalCostBps).toBe(true);
  });

  it('thin liquidity makes the same rebalance more expensive; a bigger fee tier does too', () => {
    const args = { newLower: t(-600), newUpper: t(600), holdings0: 1000n * e18, holdings1: 0n };
    const deepCost = rebalanceCost({ ...base, ...args }).swapCostQuote;
    const thinCost = rebalanceCost({ ...base, ...args, segments: deep(10n ** 22n) }).swapCostQuote;
    const pricey = rebalanceCost({ ...base, ...args, feePpm: 10_000 }).swapCostQuote;
    expect(thinCost > deepCost).toBe(true);
    expect(pricey > deepCost).toBe(true);
  });

  it('throws when the supplied depth cannot absorb the swap (book ends before the surplus is gone)', () => {
    const shallow: LiquiditySegment[] = [
      { sqrtLower: t(-100), sqrtUpper: t(100), liquidity: 10n ** 12n },
    ];
    expect(() =>
      rebalanceCost({
        ...base,
        segments: shallow,
        newLower: t(-600),
        newUpper: t(600),
        holdings0: 1000n * e18,
        holdings1: 0n,
      }),
    ).toThrow('cannot absorb');
  });

  it('a thin book is not an error by itself: the price simply moves and the deposit adapts', () => {
    const r = rebalanceCost({
      ...base,
      segments: deep(10n ** 12n),
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.solution.swap!.quote.priceImpactBps > 100n).toBe(true); // enormous impact is reported, not hidden
  });

  it('regression (found by fuzzing): spot price exactly at the new lower bound is all token0, so it sells token1 and does not divide by zero', () => {
    const r = rebalanceCost({
      ...base,
      newLower: price0,
      newUpper: t(600),
      holdings0: 0n,
      holdings1: 1000n * e18,
    });
    expect(r.solution.swap?.zeroForOne).toBe(false);
    // buying token0 pushes the price just above the bound, so a sliver of token1 is still needed (< 1% here)
    expect(
      r.solution.deposited.amount0 > 900n * e18 && r.solution.deposited.amount1 < 10n * e18,
    ).toBe(true);
    expect(r.solution.liquidity > 0n).toBe(true);
    const idle = rebalanceCost({
      ...base,
      newLower: price0,
      newUpper: t(600),
      holdings0: 5n * e18,
      holdings1: 0n,
    });
    expect(idle.solution.swap).toBeNull(); // already all token0
  });

  it('validates inputs', () => {
    expect(() =>
      solveRebalance({ ...base, newLower: t(600), newUpper: t(600), holdings0: 1n, holdings1: 1n }),
    ).toThrow(RangeError);
    expect(() =>
      solveRebalance({
        ...base,
        newLower: t(-600),
        newUpper: t(600),
        holdings0: -1n,
        holdings1: 1n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      rebalanceCost({
        ...base,
        newLower: t(-600),
        newUpper: t(600),
        holdings0: 1n,
        holdings1: 1n,
        gasQuote: -1n,
      }),
    ).toThrow(RangeError);
  });
});

describe('solveRebalance: properties', () => {
  const gen = (g: import('./support/prop').Gen) => {
    const lo = g.int(-1500, 1000);
    return {
      newLower: t(lo),
      newUpper: t(lo + g.int(20, 1500)),
      holdings0: g.bigBiased(0n, 10n ** 24n),
      holdings1: g.bigBiased(0n, 10n ** 24n),
      L: g.big(10n ** 24n, 10n ** 27n),
      feePpm: g.pick([500, 3000, 10_000]),
    };
  };

  it('never spends more than it holds, never loses value at spot, and costs are non-negative', () => {
    forAll({ runs: 150 }, gen, ({ L, feePpm, ...rest }) => {
      const r = rebalanceCost({
        ...rest,
        sqrtPrice: price0,
        segments: deep(L),
        feePpm,
        gasQuote: 7n,
      });
      const s = r.solution;
      expect(s.deposited.amount0 <= s.holdings0 && s.deposited.amount1 <= s.holdings1).toBe(true);
      expect(s.leftover.amount0 >= 0n && s.leftover.amount1 >= 0n).toBe(true);
      expect(r.valueAfterSwapAtSpotQuote <= r.valueBeforeQuote).toBe(true);
      expect(r.swapCostQuote >= 0n && r.poolFeeQuote >= 0n && r.priceImpactCostQuote >= 0n).toBe(
        true,
      );
      expect(r.totalCostQuote).toBe(r.swapCostQuote + 7n);
      // conservation through the swap
      if (s.swap) {
        const q = s.swap.quote;
        expect(s.holdings0).toBe(
          rest.holdings0 + (s.swap.zeroForOne ? -q.amountInConsumed : q.amountOut),
        );
        expect(s.holdings1).toBe(
          rest.holdings1 + (s.swap.zeroForOne ? q.amountOut : -q.amountInConsumed),
        );
      }
    });
  });

  it('is at least as good as not swapping, and matches a brute-force scan of swap sizes', () => {
    forAll({ runs: 60 }, gen, ({ L, feePpm, newLower, newUpper, holdings0, holdings1 }) => {
      const segments = deep(L);
      const r = solveRebalance({
        holdings0,
        holdings1,
        sqrtPrice: price0,
        newLower,
        newUpper,
        segments,
        feePpm,
      });
      const noSwap = liquidityForAmounts({
        sqrtPrice: price0,
        sqrtLower: newLower,
        sqrtUpper: newUpper,
        amount0: holdings0,
        amount1: holdings1,
      });
      expect(r.liquidity >= noSwap).toBe(true);

      // Scan 120 swap sizes on the side the solver chose (or both sides when it did not swap).
      let best = noSwap;
      for (const zeroForOne of [true, false]) {
        const max = zeroForOne ? holdings0 : holdings1;
        if (max === 0n) continue;
        for (let i = 1; i <= 120; i += 1) {
          const sell = (max * BigInt(i)) / 120n;
          if (sell === 0n) continue;
          const q = concentratedQuoteExactIn({
            sqrtPrice: price0,
            segments,
            zeroForOne,
            amountIn: sell,
            feePpm,
          });
          if (q.exhausted) continue;
          const h0 = zeroForOne ? holdings0 - q.amountInConsumed : holdings0 + q.amountOut;
          const h1 = zeroForOne ? holdings1 + q.amountOut : holdings1 - q.amountInConsumed;
          const l = liquidityForAmounts({
            sqrtPrice: q.sqrtPriceAfter,
            sqrtLower: newLower,
            sqrtUpper: newUpper,
            amount0: h0,
            amount1: h1,
          });
          if (l > best) best = l;
        }
      }
      // The solver must be at least as good as any scanned size (tiny tolerance for nested floor rounding).
      expect(r.liquidity + r.liquidity / 10n ** 9n + 2n >= best).toBe(true);
    });
  });

  it('an in-range target around the price leaves less than 1% of value undeposited in a deep pool', () => {
    forAll(
      { runs: 100 },
      (g) => ({ h0: g.big(10n ** 20n, 10n ** 24n), h1: g.big(0n, 10n ** 24n), w: g.int(50, 1200) }),
      ({ h0, h1, w }) => {
        const r = rebalanceCost({
          ...base,
          segments: deep(10n ** 28n),
          newLower: t(-w),
          newUpper: t(w),
          holdings0: h0,
          holdings1: h1,
        });
        const idle = valueInToken1(r.solution.leftover, price0, 'ceil');
        expect(idle * 100n <= r.valueBeforeQuote).toBe(true);
      },
    );
  });

  it('uses Q96 consistently: the price after a swap stays inside the supplied book', () => {
    const r = solveRebalance({
      ...base,
      newLower: t(-600),
      newUpper: t(600),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.sqrtPriceAfterSwap < Q96 && r.sqrtPriceAfterSwap > t(-3000)).toBe(true);
  });
});
