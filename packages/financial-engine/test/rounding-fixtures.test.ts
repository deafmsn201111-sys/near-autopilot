import { describe, expect, it } from 'vitest';
import {
  amount1Delta,
  constantProductQuote,
  impermanentLossConcentrated,
  impermanentLossFullRangeWad,
  Q96,
  rebalanceCost,
  sqrtRatioAtTick,
  swapStepExactIn,
  token0ValueInToken1,
} from '../src';

/**
 * Rounding-direction fixtures. Every expected value below was produced by an independent Python implementation of the
 * same documented rounding rules (arbitrary-precision integers, written separately from this package), chosen by
 * search so that rounding up and rounding down give DIFFERENT answers. They exist because mutation testing showed the
 * earlier fixtures were all exact, which would not notice a flipped rounding direction.
 */

describe('amount deltas: rounding direction is honoured', () => {
  it('one wei of liquidity across one Q96 unit of sqrt price: ceil 1, floor 0', () => {
    expect(amount1Delta(Q96, Q96 + 1n, 1n, 'ceil')).toBe(1n);
    expect(amount1Delta(Q96, Q96 + 1n, 1n, 'floor')).toBe(0n);
  });
});

describe('constant-product fee rounds UP (the pool never undercharges)', () => {
  it('1 unit in at 0.30%: fee 1, not 0', () => {
    const q = constantProductQuote({
      amountIn: 1n,
      reserveIn: 10n ** 12n,
      reserveOut: 10n ** 12n,
      feePpm: 3000,
    });
    expect(q.feeAmount).toBe(1n);
  });
});

describe('swapStepExactIn: independent Python vectors with inexact rounding', () => {
  it('zero-for-one, target reached: input rounds up, output rounds down, fee = ceil(in*fee/(1-fee))', () => {
    const r = swapStepExactIn({
      sqrtCurrent: 79228162515262470488790607214n,
      sqrtTarget: 79228162514273574707762259783n,
      liquidity: 550366507632374386829n,
      amountRemaining: 10n ** 30n,
      feePpm: 3000,
    });
    expect(r).toEqual({
      sqrtPriceNext: 79228162514273574707762259783n,
      amountIn: 6869465354n,
      amountOut: 6869465353n,
      feeAmount: 20670408n,
    });
  });
  it('one-for-zero, target reached', () => {
    const r = swapStepExactIn({
      sqrtCurrent: 79228162514849838717075146871n,
      sqrtTarget: 79228162515528047324072119751n,
      liquidity: 945190329856248867705n,
      amountRemaining: 10n ** 30n,
      feePpm: 3000,
    });
    expect(r).toEqual({
      sqrtPriceNext: 79228162515528047324072119751n,
      amountIn: 8091014567n,
      amountOut: 8091014566n,
      feeAmount: 24346082n,
    });
  });
  it('zero-for-one, input exhausted before the target (next price from the input formula)', () => {
    const r = swapStepExactIn({
      sqrtCurrent: 79228162519233082637039377984n,
      sqrtTarget: 79228162517280756927676397362n,
      liquidity: 221704757330n,
      amountRemaining: 4n,
      feePpm: 3000,
    });
    expect(r).toEqual({
      sqrtPriceNext: 79228162518161006013913046205n,
      amountIn: 3n,
      amountOut: 3n,
      feeAmount: 1n,
    });
  });
  it('one-for-zero, input exhausted before the target', () => {
    const r = swapStepExactIn({
      sqrtCurrent: 79228162515694806787693063641n,
      sqrtTarget: 79228162522519272018374996857n,
      liquidity: 710865704856n,
      amountRemaining: 8n,
      feePpm: 3000,
    });
    expect(r).toEqual({
      sqrtPriceNext: 79228162516474978251601559626n,
      amountIn: 7n,
      amountOut: 6n,
      feeAmount: 1n,
    });
  });
});

describe('impermanent loss: rounding fixtures', () => {
  it('full range, r = 2 + 1e-18: nearest rounding gives ...634 (floor would give ...635)', () => {
    expect(impermanentLossFullRangeWad(2n * 10n ** 18n + 1n)).toBe(-57190958417936634n);
  });

  it('concentrated: deposit rounds UP, so the HODL basket and the loss are not understated', () => {
    // Python: with ceil deposits (219197, 20267) HODL = 165223, position = 163264, IL = -1959 (-1.18567e-2);
    // with floor deposits it would be (219196, 20266), HODL 165222, IL -1958.
    const r = impermanentLossConcentrated({
      shape: {
        sqrtLower: 55459713759985036315481543055n,
        sqrtUpper: 102996611268543638871607969256n,
        liquidity: 390853n,
      },
      entrySqrtPrice: 59567951693846068482011102150n,
      exitSqrtPrice: 64428814514362134453777628106n,
    });
    expect([r.entryAmount0, r.entryAmount1]).toEqual([219197n, 20267n]);
    expect(r.hodlValueToken1).toBe(165223n);
    expect(r.positionValueToken1).toBe(163264n);
    expect(r.ilToken1).toBe(-1959n);
    expect(r.ilWad).toBe(-11856702759301066n);
  });
});

describe('rebalance pool fee is valued in quote terms in BOTH directions', () => {
  const t = sqrtRatioAtTick;
  const e18 = 10n ** 18n;
  const spot = t(1000); // price ~1.105, so token0 and token1 amounts differ and a swapped formula shows
  const base = {
    sqrtPrice: spot,
    segments: [{ sqrtLower: t(-3000), sqrtUpper: t(3000), liquidity: 10n ** 26n }],
    feePpm: 3000,
    gasQuote: 0n,
  };

  it('selling token0: fee is token0, valued at spot and rounded up (capped by the total swap cost)', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(900),
      newUpper: t(1100),
      holdings0: 1000n * e18,
      holdings1: 0n,
    });
    expect(r.solution.swap?.zeroForOne).toBe(true);
    const fee0 = r.solution.swap!.quote.feeAmount;
    const expected = token0ValueInToken1(fee0, spot, 'ceil');
    expect(r.poolFeeQuote).toBe(expected < r.swapCostQuote ? expected : r.swapCostQuote);
    expect(fee0 > 0n && fee0 * 1n !== r.poolFeeQuote).toBe(true); // token0 units differ from quote units at this price
  });

  it('selling token1: fee is already in quote units and used as is', () => {
    const r = rebalanceCost({
      ...base,
      newLower: t(900),
      newUpper: t(1100),
      holdings0: 0n,
      holdings1: 1000n * e18,
    });
    expect(r.solution.swap?.zeroForOne).toBe(false);
    const fee1 = r.solution.swap!.quote.feeAmount;
    expect(r.poolFeeQuote).toBe(fee1 < r.swapCostQuote ? fee1 : r.swapCostQuote);
  });
});
