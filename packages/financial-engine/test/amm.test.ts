import { describe, expect, it } from 'vitest';
import {
  absBig,
  concentratedQuoteExactIn,
  constantProductAmountIn,
  constantProductQuote,
  isqrt,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  Q96,
  sqrtRatioAtTick,
  swapStepExactIn,
  withinSlippage,
  WAD,
  type LiquiditySegment,
} from '../src';
import { forAll } from './support/prop';

const e18 = 10n ** 18n;
/** sqrt(r1/r0) in Q96 the way the Uniswap v3 test-suite encodes prices. */
const encodePriceSqrt = (r1: bigint, r0: bigint) => isqrt((r1 << 192n) / r0);

describe('swapStepExactIn: Uniswap v3 SwapMath reference vectors', () => {
  it('exact in, capped at the price target (one for zero)', () => {
    const target = encodePriceSqrt(101n, 100n);
    const r = swapStepExactIn({
      sqrtCurrent: encodePriceSqrt(1n, 1n),
      sqrtTarget: target,
      liquidity: 2n * e18,
      amountRemaining: e18,
      feePpm: 600,
    });
    expect(r.amountIn).toBe(9975124224178055n);
    expect(r.amountOut).toBe(9925619580021728n);
    expect(r.feeAmount).toBe(5988667735148n);
    expect(r.sqrtPriceNext).toBe(target);
    expect(r.amountIn + r.feeAmount < e18).toBe(true);
  });

  it('exact in, fully spent inside the segment (one for zero)', () => {
    const r = swapStepExactIn({
      sqrtCurrent: encodePriceSqrt(1n, 1n),
      sqrtTarget: encodePriceSqrt(1000n, 100n),
      liquidity: 2n * e18,
      amountRemaining: e18,
      feePpm: 600,
    });
    expect(r.amountIn).toBe(999400000000000000n);
    expect(r.feeAmount).toBe(600000000000000n);
    expect(r.amountOut).toBe(666399946655997866n);
    expect(r.amountIn + r.feeAmount).toBe(e18); // everything is accounted for
    // price after = sqrtP + floor(amountLessFee * 2^96 / L): independent closed form
    expect(r.sqrtPriceNext).toBe(Q96 + (999400000000000000n * Q96) / (2n * e18));
  });

  it('a token0-in step moves the price down and input is fully accounted for', () => {
    const r = swapStepExactIn({
      sqrtCurrent: Q96,
      sqrtTarget: Q96 / 2n,
      liquidity: 10n ** 24n,
      amountRemaining: 10n ** 18n,
      feePpm: 3000,
    });
    expect(r.sqrtPriceNext < Q96).toBe(true);
    expect(r.sqrtPriceNext).toBe(79228083523865064300074843162n); // independent integer computation (Python)
    expect(r.amountIn + r.feeAmount).toBe(10n ** 18n);
  });

  it('zero liquidity jumps straight to the target consuming nothing', () => {
    const r = swapStepExactIn({
      sqrtCurrent: Q96,
      sqrtTarget: 2n * Q96,
      liquidity: 0n,
      amountRemaining: 1000n,
      feePpm: 3000,
    });
    expect(r).toEqual({ sqrtPriceNext: 2n * Q96, amountIn: 0n, amountOut: 0n, feeAmount: 0n });
  });

  it('rejects invalid fees', () => {
    expect(() =>
      swapStepExactIn({
        sqrtCurrent: Q96,
        sqrtTarget: 2n * Q96,
        liquidity: 1n,
        amountRemaining: 1n,
        feePpm: 1_000_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      swapStepExactIn({
        sqrtCurrent: Q96,
        sqrtTarget: 2n * Q96,
        liquidity: 1n,
        amountRemaining: 1n,
        feePpm: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe('constantProductQuote', () => {
  const pool = { reserveIn: 10n ** 12n, reserveOut: 2n * 10n ** 12n, feePpm: 3000 };

  it('matches a hand-checked fixture (Python integers)', () => {
    const q = constantProductQuote({ ...pool, amountIn: 10n ** 9n });
    expect(q.amountOut).toBe(1_992_013_962n);
    expect(q.feeAmount).toBe(3_000_000n);
    expect(q.spotPriceWad).toBe(2n * WAD);
    expect(q.executionPriceWad).toBe(1_992_013_962_000_000_000n);
    expect(q.priceImpactBps).toBe(10n); // 1 - 1/(1 + 0.001) = 0.0999% -> 10 bps rounded up
    expect(q.totalCostBps).toBe(40n); // impact + 0.3% fee = 0.399% -> 40 bps rounded up
    expect(q.reserveInAfter).toBe(10n ** 12n + 10n ** 9n);
    expect(q.reserveOutAfter).toBe(2n * 10n ** 12n - 1_992_013_962n);
  });

  it('zero fee: total cost equals price impact', () => {
    const q = constantProductQuote({
      reserveIn: 1000n,
      reserveOut: 1000n,
      amountIn: 1000n,
      feePpm: 0,
    });
    expect(q.amountOut).toBe(500n); // 1000*1000/(1000+1000)
    expect(q.feeAmount).toBe(0n);
    expect(q.priceImpactBps).toBe(5_000n);
    expect(q.totalCostBps).toBe(5_000n);
  });

  it('boundaries', () => {
    expect(
      constantProductQuote({
        reserveIn: 10n ** 12n,
        reserveOut: 10n ** 12n,
        amountIn: 1n,
        feePpm: 3000,
      }).amountOut,
    ).toBe(0n);
    expect(() => constantProductQuote({ ...pool, amountIn: 0n })).toThrow(RangeError);
    expect(() => constantProductQuote({ ...pool, reserveIn: 0n, amountIn: 1n })).toThrow(
      RangeError,
    );
    expect(() => constantProductQuote({ ...pool, feePpm: 1_000_000, amountIn: 1n })).toThrow(
      RangeError,
    );
    expect(() => constantProductQuote({ ...pool, feePpm: 0.5, amountIn: 1n })).toThrow(RangeError);
  });

  it('property: invariant never decreases, output < reserve, output monotone, no free money on a round trip', () => {
    forAll(
      {},
      (g) => ({
        rin: g.bigBiased(10n ** 3n, 10n ** 30n),
        rout: g.bigBiased(10n ** 3n, 10n ** 30n),
        a: g.bigBiased(1n, 10n ** 30n),
        fee: g.pick([0, 100, 500, 3000, 10_000, 100_000]),
      }),
      ({ rin, rout, a, fee }) => {
        const q = constantProductQuote({
          reserveIn: rin,
          reserveOut: rout,
          amountIn: a,
          feePpm: fee,
        });
        expect(q.amountOut < rout).toBe(true);
        expect(q.reserveInAfter * q.reserveOutAfter >= rin * rout).toBe(true);
        const bigger = constantProductQuote({
          reserveIn: rin,
          reserveOut: rout,
          amountIn: a + 1n + a / 3n,
          feePpm: fee,
        });
        expect(bigger.amountOut >= q.amountOut).toBe(true);
        expect(q.totalCostBps >= q.priceImpactBps || fee === 0).toBe(true);
        if (q.amountOut > 0n) {
          const back = constantProductQuote({
            reserveIn: q.reserveOutAfter,
            reserveOut: q.reserveInAfter,
            amountIn: q.amountOut,
            feePpm: fee,
          });
          expect(back.amountOut <= a).toBe(true);
        }
      },
    );
  });

  it('property: amountIn is the exact inverse (smallest input that delivers the output)', () => {
    forAll(
      {},
      (g) => {
        const rin = g.bigBiased(10n ** 4n, 10n ** 28n);
        const rout = g.bigBiased(10n ** 4n, 10n ** 28n);
        return { rin, rout, out: g.big(1n, rout / 2n), fee: g.pick([0, 500, 3000, 10_000]) };
      },
      ({ rin, rout, out, fee }) => {
        const need = constantProductAmountIn({
          reserveIn: rin,
          reserveOut: rout,
          amountOut: out,
          feePpm: fee,
        });
        expect(
          constantProductQuote({ reserveIn: rin, reserveOut: rout, amountIn: need, feePpm: fee })
            .amountOut >= out,
        ).toBe(true);
        if (need > 1n)
          expect(
            constantProductQuote({
              reserveIn: rin,
              reserveOut: rout,
              amountIn: need - 1n,
              feePpm: fee,
            }).amountOut < out,
          ).toBe(true);
      },
    );
    expect(() =>
      constantProductAmountIn({ reserveIn: 10n, reserveOut: 10n, amountOut: 10n, feePpm: 0 }),
    ).toThrow('cannot supply');
  });
});

describe('concentratedQuoteExactIn', () => {
  const t = sqrtRatioAtTick;
  const ladder = (L: bigint): LiquiditySegment[] => [
    { sqrtLower: t(-120), sqrtUpper: t(-60), liquidity: L },
    { sqrtLower: t(-60), sqrtUpper: t(0), liquidity: 2n * L },
    { sqrtLower: t(0), sqrtUpper: t(60), liquidity: 3n * L },
    { sqrtLower: t(60), sqrtUpper: t(120), liquidity: L },
  ];

  it('inside one segment it is exactly one swap step', () => {
    const segs = ladder(10n ** 22n);
    const q = concentratedQuoteExactIn({
      sqrtPrice: t(30),
      segments: segs,
      zeroForOne: false,
      amountIn: 10n ** 16n,
      feePpm: 3000,
    });
    const step = swapStepExactIn({
      sqrtCurrent: t(30),
      sqrtTarget: t(60),
      liquidity: 3n * 10n ** 22n,
      amountRemaining: 10n ** 16n,
      feePpm: 3000,
    });
    expect(q.amountOut).toBe(step.amountOut);
    expect(q.sqrtPriceAfter).toBe(step.sqrtPriceNext);
    expect(q.feeAmount).toBe(step.feeAmount);
    expect(q.exhausted).toBe(false);
    expect(q.amountInConsumed).toBe(10n ** 16n);
  });

  it('crosses segments, conserves input, and moves the price in the right direction', () => {
    const segs = ladder(10n ** 20n);
    const down = concentratedQuoteExactIn({
      sqrtPrice: t(30),
      segments: segs,
      zeroForOne: true,
      amountIn: 10n ** 19n,
      feePpm: 3000,
    });
    expect(down.sqrtPriceAfter < t(0)).toBe(true); // crossed the tick 0 boundary into a thinner segment
    expect(down.amountInConsumed + down.amountRemaining).toBe(10n ** 19n);
    const up = concentratedQuoteExactIn({
      sqrtPrice: t(-30),
      segments: segs,
      zeroForOne: false,
      amountIn: 10n ** 19n,
      feePpm: 3000,
    });
    expect(up.sqrtPriceAfter > t(0)).toBe(true);
  });

  it('reports exhaustion when depth runs out and leaves the remainder untouched', () => {
    const segs = ladder(10n ** 18n);
    const q = concentratedQuoteExactIn({
      sqrtPrice: t(0),
      segments: segs,
      zeroForOne: false,
      amountIn: 10n ** 30n,
      feePpm: 3000,
    });
    expect(q.exhausted).toBe(true);
    expect(q.sqrtPriceAfter).toBe(t(120));
    expect(q.amountInConsumed + q.amountRemaining).toBe(10n ** 30n);
    expect(q.amountRemaining > 0n).toBe(true);
  });

  it('respects a price limit', () => {
    const segs = ladder(10n ** 22n);
    const q = concentratedQuoteExactIn({
      sqrtPrice: t(0),
      segments: segs,
      zeroForOne: false,
      amountIn: 10n ** 30n,
      feePpm: 3000,
      sqrtPriceLimit: t(30),
    });
    expect(q.sqrtPriceAfter).toBe(t(30));
    expect(q.exhausted).toBe(true);
  });

  it('zero-liquidity gaps are crossed for free; an empty book consumes nothing', () => {
    const gap: LiquiditySegment[] = [
      { sqrtLower: t(0), sqrtUpper: t(60), liquidity: 10n ** 22n },
      { sqrtLower: t(60), sqrtUpper: t(120), liquidity: 0n },
      { sqrtLower: t(120), sqrtUpper: t(180), liquidity: 10n ** 22n },
    ];
    const q = concentratedQuoteExactIn({
      sqrtPrice: t(50),
      segments: gap,
      zeroForOne: false,
      amountIn: 10n ** 20n,
      feePpm: 3000,
    });
    expect(q.sqrtPriceAfter > t(120)).toBe(true);
    const empty = concentratedQuoteExactIn({
      sqrtPrice: t(0),
      segments: [{ sqrtLower: t(-60), sqrtUpper: t(60), liquidity: 0n }],
      zeroForOne: false,
      amountIn: 1000n,
      feePpm: 3000,
    });
    expect(empty.amountOut).toBe(0n);
  });

  it('validates its inputs', () => {
    const segs = ladder(10n ** 20n);
    const base = { sqrtPrice: t(0), segments: segs, zeroForOne: true, amountIn: 10n, feePpm: 3000 };
    expect(() => concentratedQuoteExactIn({ ...base, segments: [] })).toThrow(RangeError);
    expect(() => concentratedQuoteExactIn({ ...base, amountIn: 0n })).toThrow(RangeError);
    expect(() => concentratedQuoteExactIn({ ...base, sqrtPrice: t(500) })).toThrow('outside');
    expect(() => concentratedQuoteExactIn({ ...base, sqrtPriceLimit: t(10) })).toThrow(
      'wrong side',
    );
    expect(() => concentratedQuoteExactIn({ ...base, segments: [segs[0]!, segs[2]!] })).toThrow(
      'contiguous',
    );
    expect(() =>
      concentratedQuoteExactIn({
        ...base,
        segments: [{ sqrtLower: 5n, sqrtUpper: 5n, liquidity: 1n }],
      }),
    ).toThrow(RangeError);
  });

  it('cross-check: inside one range it equals a constant-product pool on the virtual reserves', () => {
    // v3 identity: x_virtual = L / sqrtP, y_virtual = L * sqrtP. Two independent formula families must agree.
    forAll(
      {},
      (g) => ({
        tick: g.int(-50_000, 50_000),
        L: g.big(10n ** 20n, 10n ** 30n),
        frac: g.int(1, 3000),
        zeroForOne: g.bool(),
        fee: g.pick([500, 3000, 10_000]),
      }),
      ({ tick, L, frac, zeroForOne, fee }) => {
        const s = sqrtRatioAtTick(tick);
        const x = (L * Q96) / s;
        const y = (L * s) / Q96;
        const amountIn = ((zeroForOne ? x : y) * BigInt(frac)) / 1_000_000n + 1n; // up to 0.3% of the reserve: stays inside the wide range
        const cl = concentratedQuoteExactIn({
          sqrtPrice: s,
          segments: [{ sqrtLower: MIN_SQRT_RATIO, sqrtUpper: MAX_SQRT_RATIO, liquidity: L }],
          zeroForOne,
          amountIn,
          feePpm: fee,
        });
        const cp = constantProductQuote({
          reserveIn: zeroForOne ? x : y,
          reserveOut: zeroForOne ? y : x,
          amountIn,
          feePpm: fee,
        });
        // reserve truncation (x, y rounded) moves the answer by a relative ~1/L-scale amount; allow 0.000001% + 2 units
        expect(absBig(cl.amountOut - cp.amountOut) <= cp.amountOut / 10n ** 8n + 2n).toBe(true);
      },
    );
  });

  it('property: splitting a segment at any point does not change the result (within rounding)', () => {
    forAll(
      {},
      (g) => ({
        L: g.big(10n ** 20n, 10n ** 26n),
        amt: g.big(10n ** 12n, 10n ** 19n),
        zeroForOne: g.bool(),
        splitAt: g.int(-50, 50),
      }),
      ({ L, amt, zeroForOne, splitAt }) => {
        const whole: LiquiditySegment[] = [{ sqrtLower: t(-100), sqrtUpper: t(100), liquidity: L }];
        const split: LiquiditySegment[] = [
          { sqrtLower: t(-100), sqrtUpper: t(splitAt), liquidity: L },
          { sqrtLower: t(splitAt), sqrtUpper: t(100), liquidity: L },
        ];
        const start = t(0);
        const a = concentratedQuoteExactIn({
          sqrtPrice: start,
          segments: whole,
          zeroForOne,
          amountIn: amt,
          feePpm: 3000,
        });
        const b = concentratedQuoteExactIn({
          sqrtPrice: start,
          segments: split,
          zeroForOne,
          amountIn: amt,
          feePpm: 3000,
        });
        expect(a.exhausted).toBe(b.exhausted);
        expect(absBig(a.amountOut - b.amountOut) <= 3n + a.amountOut / 10n ** 12n).toBe(true);
      },
    );
  });

  it('property: no free money on a round trip, and more input never gives less output', () => {
    forAll(
      {},
      (g) => ({
        L: g.big(10n ** 20n, 10n ** 26n),
        amt: g.big(10n ** 10n, 10n ** 18n),
        zeroForOne: g.bool(),
        fee: g.pick([500, 3000, 10_000]),
      }),
      ({ L, amt, zeroForOne, fee }) => {
        const segs: LiquiditySegment[] = [
          { sqrtLower: t(-1000), sqrtUpper: t(1000), liquidity: L },
        ];
        const go = concentratedQuoteExactIn({
          sqrtPrice: t(0),
          segments: segs,
          zeroForOne,
          amountIn: amt,
          feePpm: fee,
        });
        const more = concentratedQuoteExactIn({
          sqrtPrice: t(0),
          segments: segs,
          zeroForOne,
          amountIn: amt * 2n,
          feePpm: fee,
        });
        expect(more.amountOut >= go.amountOut).toBe(true);
        if (go.amountOut > 0n && !go.exhausted) {
          const back = concentratedQuoteExactIn({
            sqrtPrice: go.sqrtPriceAfter,
            segments: segs,
            zeroForOne: !zeroForOne,
            amountIn: go.amountOut,
            feePpm: fee,
          });
          expect(back.amountOut <= amt).toBe(true);
        }
        expect(go.totalCostBps >= 0n && go.priceImpactBps >= 0n).toBe(true);
      },
    );
  });
});

describe('withinSlippage', () => {
  it('boundary: exactly the floor passes, one unit below fails', () => {
    expect(withinSlippage({ quotedOut: 10_000n, actualOut: 9_950n, toleranceBps: 50 })).toBe(true);
    expect(withinSlippage({ quotedOut: 10_000n, actualOut: 9_949n, toleranceBps: 50 })).toBe(false);
    expect(withinSlippage({ quotedOut: 10_000n, actualOut: 0n, toleranceBps: 10_000 })).toBe(true);
    expect(withinSlippage({ quotedOut: 10_000n, actualOut: 10_000n, toleranceBps: 0 })).toBe(true);
    expect(withinSlippage({ quotedOut: 10_000n, actualOut: 9_999n, toleranceBps: 0 })).toBe(false);
  });
  it('rejects invalid tolerances', () => {
    expect(() => withinSlippage({ quotedOut: 1n, actualOut: 1n, toleranceBps: -1 })).toThrow(
      RangeError,
    );
    expect(() => withinSlippage({ quotedOut: 1n, actualOut: 1n, toleranceBps: 10_001 })).toThrow(
      RangeError,
    );
    expect(() => withinSlippage({ quotedOut: 1n, actualOut: 1n, toleranceBps: 0.5 })).toThrow(
      RangeError,
    );
  });
});
