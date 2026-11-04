import { describe, expect, it } from 'vitest';
import {
  absBig,
  estimateFeeApr,
  netYield,
  paybackDays,
  realizedFeeYield,
  WAD,
  type NetYieldInput,
} from '../src';
import { forAll } from './support/prop';

const L = 10n ** 18n;
const baseApr = {
  capitalQuote: 100_000n,
  volume24hQuote: 1_000_000n,
  feePpm: 3000,
  positionLiquidity: L,
  activePoolLiquidity: L,
  activeLiquidityIncludesPosition: false,
  timeInRangeBps: 8000,
};

describe('estimateFeeApr (ESTIMATED)', () => {
  it('fixture: 1M volume * 0.30% = 3000/day pool fees; 50% share; 80% in range -> 1200/day -> 438% APR', () => {
    const r = estimateFeeApr(baseApr);
    expect(r.basis).toBe('estimated');
    expect(r.feesPerDayQuote).toBe(1200n);
    expect(r.aprWad).toBe(4_380_000_000_000_000_000n); // 1200 * 365 / 100000 = 4.38
    // APY = (1 + 4.38/365)^365 - 1 = 76.783... (Python decimal); powWad rounds each step, allow 1e-12 relative
    expect(
      absBig(r.apyWad - 76_783_425_280_849_982_720n) * 10n ** 12n < 76_783_425_280_849_982_720n,
    ).toBe(true);
  });

  it('lists the assumptions the estimate rests on', () => {
    const r = estimateFeeApr(baseApr);
    expect(r.assumptions.length).toBeGreaterThanOrEqual(5);
    expect(r.assumptions.join(' ')).toContain('volume repeats');
    expect(r.assumptions.join(' ')).toContain('80%');
    expect(r.assumptions.join(' ')).toContain('365');
  });

  it('if pool liquidity already contains the position, the share is L/L_active (here 100%)', () => {
    const r = estimateFeeApr({ ...baseApr, activeLiquidityIncludesPosition: true });
    expect(r.feesPerDayQuote).toBe(2400n);
    expect(() =>
      estimateFeeApr({
        ...baseApr,
        activeLiquidityIncludesPosition: true,
        activePoolLiquidity: L / 2n,
      }),
    ).toThrow(RangeError);
  });

  it('boundaries: out of range all the time, no volume, empty pool, tiny volume rounding down', () => {
    expect(estimateFeeApr({ ...baseApr, timeInRangeBps: 0 })).toMatchObject({
      feesPerDayQuote: 0n,
      aprWad: 0n,
      apyWad: 0n,
    });
    expect(estimateFeeApr({ ...baseApr, volume24hQuote: 0n }).feesPerDayQuote).toBe(0n);
    expect(estimateFeeApr({ ...baseApr, activePoolLiquidity: 0n }).feesPerDayQuote).toBe(2400n); // sole LP earns everything it can
    expect(estimateFeeApr({ ...baseApr, volume24hQuote: 100n }).feesPerDayQuote).toBe(0n); // 100*0.003 = 0.3 -> rounds down
    expect(estimateFeeApr({ ...baseApr, timeInRangeBps: 10_000 }).feesPerDayQuote).toBe(1500n);
  });

  it('validates inputs', () => {
    expect(() => estimateFeeApr({ ...baseApr, capitalQuote: 0n })).toThrow(RangeError);
    expect(() => estimateFeeApr({ ...baseApr, timeInRangeBps: 10_001 })).toThrow(RangeError);
    expect(() => estimateFeeApr({ ...baseApr, timeInRangeBps: -1 })).toThrow(RangeError);
    expect(() => estimateFeeApr({ ...baseApr, feePpm: 1_000_000 })).toThrow(RangeError);
    expect(() => estimateFeeApr({ ...baseApr, volume24hQuote: -1n })).toThrow(RangeError);
    expect(() => estimateFeeApr({ ...baseApr, compoundingsPerYear: 0 })).toThrow(RangeError);
  });

  it('property: monotone in volume, time in range and share; APY >= APR; halving capital doubles APR (+/-1 rounding)', () => {
    forAll(
      {},
      (g) => ({
        capital: g.big(1_000n, 10n ** 15n),
        volume: g.big(0n, 10n ** 15n),
        fee: g.pick([100, 500, 3000, 10_000]),
        pos: g.big(1n, 10n ** 24n),
        pool: g.big(0n, 10n ** 24n),
        tir: g.int(0, 10_000),
      }),
      ({ capital, volume, fee, pos, pool, tir }) => {
        const args = {
          capitalQuote: capital,
          volume24hQuote: volume,
          feePpm: fee,
          positionLiquidity: pos,
          activePoolLiquidity: pool,
          activeLiquidityIncludesPosition: false,
          timeInRangeBps: tir,
        };
        const r = estimateFeeApr(args);
        expect(
          estimateFeeApr({ ...args, volume24hQuote: volume * 2n + 1n }).feesPerDayQuote >=
            r.feesPerDayQuote,
        ).toBe(true);
        expect(
          estimateFeeApr({ ...args, timeInRangeBps: Math.min(10_000, tir + 1) }).feesPerDayQuote >=
            r.feesPerDayQuote,
        ).toBe(true);
        expect(
          estimateFeeApr({ ...args, positionLiquidity: pos * 2n }).feesPerDayQuote >=
            r.feesPerDayQuote,
        ).toBe(true);
        expect(
          estimateFeeApr({ ...args, activePoolLiquidity: pool + pos }).feesPerDayQuote <=
            r.feesPerDayQuote,
        ).toBe(true);
        expect(r.apyWad >= r.aprWad - 1_000n).toBe(true);
        // fees never exceed the whole pool's fee take
        expect(r.feesPerDayQuote <= (volume * BigInt(fee)) / 1_000_000n).toBe(true);
        if (capital % 2n === 0n)
          expect(
            absBig(
              estimateFeeApr({ ...args, capitalQuote: capital / 2n }).aprWad - 2n * r.aprWad,
            ) <=
              (2n * WAD) / capital + (2n * 365n * WAD) / capital,
          ).toBe(true);
      },
    );
  });
});

describe('realizedFeeYield (REALIZED)', () => {
  it('fixture: 500 earned on 100,000 over 30 days', () => {
    const r = realizedFeeYield({
      feesCollectedQuote: 500n,
      avgCapitalQuote: 100_000n,
      elapsedSeconds: 30n * 86_400n,
    });
    expect(r.basis).toBe('realized');
    expect(r.periodReturnWad).toBe(5_000_000_000_000_000n); // 0.5%
    expect(r.annualizedAprWad).toBe(60_833_333_333_333_333n); // 0.5% * 365/30, floor
  });
  it('one full year: annualised equals the period return', () => {
    const r = realizedFeeYield({
      feesCollectedQuote: 5_000n,
      avgCapitalQuote: 100_000n,
      elapsedSeconds: 365n * 86_400n,
    });
    expect(r.annualizedAprWad).toBe(r.periodReturnWad);
  });
  it('zero fees is a valid observation', () => {
    expect(
      realizedFeeYield({ feesCollectedQuote: 0n, avgCapitalQuote: 1n, elapsedSeconds: 1n })
        .annualizedAprWad,
    ).toBe(0n);
  });
  it('rejects impossible observations', () => {
    expect(() =>
      realizedFeeYield({ feesCollectedQuote: -1n, avgCapitalQuote: 1n, elapsedSeconds: 1n }),
    ).toThrow(RangeError);
    expect(() =>
      realizedFeeYield({ feesCollectedQuote: 1n, avgCapitalQuote: 0n, elapsedSeconds: 1n }),
    ).toThrow(RangeError);
    expect(() =>
      realizedFeeYield({ feesCollectedQuote: 1n, avgCapitalQuote: 1n, elapsedSeconds: 0n }),
    ).toThrow(RangeError);
  });
});

describe('netYield: realized / marked / estimated are reported separately', () => {
  const input: NetYieldInput = {
    avgCapitalQuote: 100_000n,
    elapsedSeconds: 30n * 86_400n,
    realized: { feesCollectedQuote: 500n, gasPaidQuote: 20n, swapCostsPaidQuote: 30n },
    marked: { uncollectedFeesQuote: 100n, impermanentLossQuote: -300n },
    estimated: {
      horizonSeconds: 30n * 86_400n,
      projectedFeesQuote: 1000n,
      projectedGasQuote: 50n,
      projectedSwapCostQuote: 70n,
      assumptions: ['volume repeats'],
    },
  };

  it('fixture', () => {
    const n = netYield(input);
    expect(n.realized).toEqual({
      basis: 'realized',
      netQuote: 450n,
      annualizedAprWad: 54_750_000_000_000_000n,
    });
    expect(n.marked.basis).toBe('marked');
    expect(n.marked.netVsHodlQuote).toBe(250n); // 450 realized + 100 uncollected - 300 IL
    expect(n.marked.annualizedAprWad).toBe(30_416_666_666_666_666n);
    expect(n.marked.feesCoverIl).toBe(true); // 600 fees vs 300 IL
    expect(n.estimated).toEqual({
      basis: 'estimated',
      netQuote: 880n,
      horizonReturnWad: 8_800_000_000_000_000n,
      annualizedAprWad: 107_066_666_666_666_666n,
      assumptions: ['volume repeats'],
    });
  });

  it('impermanent loss never enters the realized view', () => {
    const worse = netYield({
      ...input,
      marked: { ...input.marked, impermanentLossQuote: -99_999n },
    });
    expect(worse.realized).toEqual(netYield(input).realized);
    expect(worse.marked.netVsHodlQuote).toBe(450n + 100n - 99_999n);
    expect(worse.marked.feesCoverIl).toBe(false);
  });

  it('the estimated block is optional and never leaks into the other two', () => {
    const without = netYield({ ...input, estimated: undefined });
    expect(without.estimated).toBeNull();
    forAll(
      {},
      (g) => ({
        f: g.big(0n, 10n ** 12n),
        gas: g.big(0n, 10n ** 12n),
        swap: g.big(0n, 10n ** 12n),
      }),
      ({ f, gas, swap }) => {
        const a = netYield({
          ...input,
          estimated: {
            ...input.estimated!,
            projectedFeesQuote: f,
            projectedGasQuote: gas,
            projectedSwapCostQuote: swap,
          },
        });
        expect(a.realized).toEqual(without.realized);
        expect(a.marked).toEqual(without.marked);
      },
    );
  });

  it('costs larger than income give negative nets (rounding toward -infinity in rates)', () => {
    const n = netYield({
      ...input,
      realized: { feesCollectedQuote: 0n, gasPaidQuote: 1n, swapCostsPaidQuote: 0n },
    });
    expect(n.realized.netQuote).toBe(-1n);
    expect(n.realized.annualizedAprWad < 0n).toBe(true);
  });

  it('property: marked = realized + uncollected + IL, exactly', () => {
    forAll(
      {},
      (g) => ({
        fees: g.big(0n, 10n ** 12n),
        gas: g.big(0n, 10n ** 9n),
        swap: g.big(0n, 10n ** 9n),
        unc: g.big(0n, 10n ** 12n),
        il: g.big(0n, 10n ** 12n),
      }),
      ({ fees, gas, swap, unc, il }) => {
        const n = netYield({
          avgCapitalQuote: 10n ** 12n,
          elapsedSeconds: 86_400n,
          realized: { feesCollectedQuote: fees, gasPaidQuote: gas, swapCostsPaidQuote: swap },
          marked: { uncollectedFeesQuote: unc, impermanentLossQuote: -il },
        });
        expect(n.realized.netQuote).toBe(fees - gas - swap);
        expect(n.marked.netVsHodlQuote).toBe(fees - gas - swap + unc - il);
        expect(n.marked.feesCoverIl).toBe(fees + unc >= il);
      },
    );
  });

  it('validates inputs, including the sign convention of IL', () => {
    expect(() =>
      netYield({ ...input, marked: { ...input.marked, impermanentLossQuote: 1n } }),
    ).toThrow('<= 0');
    expect(() => netYield({ ...input, avgCapitalQuote: 0n })).toThrow(RangeError);
    expect(() => netYield({ ...input, elapsedSeconds: 0n })).toThrow(RangeError);
    expect(() =>
      netYield({ ...input, realized: { ...input.realized, gasPaidQuote: -1n } }),
    ).toThrow(RangeError);
    expect(() =>
      netYield({ ...input, estimated: { ...input.estimated!, horizonSeconds: 0n } }),
    ).toThrow(RangeError);
  });
});

describe('paybackDays (ESTIMATED)', () => {
  it('rounds up, handles zero cost and zero income', () => {
    expect(paybackDays({ costQuote: 100n, estimatedFeesPerDayQuote: 30n })).toEqual({
      basis: 'estimated',
      days: 4n,
    });
    expect(paybackDays({ costQuote: 90n, estimatedFeesPerDayQuote: 30n }).days).toBe(3n);
    expect(paybackDays({ costQuote: 0n, estimatedFeesPerDayQuote: 0n }).days).toBe(0n);
    expect(paybackDays({ costQuote: 1n, estimatedFeesPerDayQuote: 0n }).days).toBeNull();
    expect(() => paybackDays({ costQuote: -1n, estimatedFeesPerDayQuote: 1n })).toThrow(RangeError);
  });
});
