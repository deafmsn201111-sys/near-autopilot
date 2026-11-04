import { describe, expect, it } from 'vitest';
import { MissingPriceError, type TokenId, type UnitPrice } from '@near-autopilot/core';
import {
  breakevenMoveBps,
  computeRisk,
  DEFAULT_STRESS_SCENARIOS,
  runStressScenarios,
  USD18,
  type RiskAsset,
  type RiskPosition,
  type RiskReport,
  type StressScenario,
} from '../src';
import { ONE_NEAR_INNER, ONE_USDT_INNER, USDT, WNEAR } from './support/fixtures';

/**
 * Hand-computed reference position (all exact in binary-free integer arithmetic):
 *   collateral  100 wNEAR   price $5     -> value $500, volatility_ratio 6000 -> adjusted collateral $300
 *   debt        200 USDT    price $1     -> value $200, volatility_ratio 8000 -> adjusted debt $200 * 10000/8000 = $250
 *   health factor 300/250 = 1.2 -> 12000 bps;   LTV 200/500 = 4000 bps;   threshold 12000*4000/10000 = 4800 bps
 *   headroom $50: collateral can fall 50/300 = 16.66% (1666 bps), debt can rise 50/250 = 20% (2000 bps)
 */
const assets = new Map<TokenId, RiskAsset>([
  [WNEAR, { tokenId: WNEAR, extraDecimals: 0, volatilityRatioBps: 6000 }],
  [USDT, { tokenId: USDT, extraDecimals: 12, volatilityRatioBps: 8000 }],
]);
const prices = new Map<TokenId, UnitPrice>([
  [WNEAR, { multiplier: 50_000n, decimals: 28 }], // $5 per 1e24 raw units
  [USDT, { multiplier: 10_000n, decimals: 10 }], // $1 per 1e6 raw units
]);
const position: RiskPosition = {
  collateral: [{ tokenId: WNEAR, inner: 100n * ONE_NEAR_INNER }],
  borrowed: [{ tokenId: USDT, inner: 200n * ONE_USDT_INNER }],
};
const usd = (n: bigint) => n * USD18;
const stress = (scenario: StressScenario, pos: RiskPosition = position): RiskReport =>
  runStressScenarios(pos, assets, prices, [scenario])[0]!.report;

describe('computeRisk (hand-computed reference)', () => {
  const r = computeRisk(position, assets, prices);

  it('values collateral and debt', () => {
    expect(r.collateralValueUsd18).toBe(usd(500n));
    expect(r.borrowedValueUsd18).toBe(usd(200n));
  });

  it('applies the volatility ratio to collateral (multiply) and to debt (divide)', () => {
    expect(r.adjustedCollateralUsd18).toBe(usd(300n));
    expect(r.adjustedBorrowedUsd18).toBe(usd(250n));
    expect(r.headroomAdjustedUsd18).toBe(usd(50n));
  });

  it('computes health factor, LTV, liquidation threshold and blended collateral factor', () => {
    expect(r.healthFactorBps).toBe(12_000n);
    expect(r.ltvBps).toBe(4_000n);
    expect(r.liquidationThresholdBps).toBe(4_800n);
    expect(r.blendedCollateralFactorBps).toBe(6_000n);
    expect(r.liquidatable).toBe(false);
    expect(r.maxLiquidationDiscountBps).toBe(0n);
  });

  it('computes the distance to liquidation', () => {
    expect(r.collateralDropToLiquidationBps).toBe(1_666n);
    expect(r.debtRiseToLiquidationBps).toBe(2_000n);
  });
});

describe('extra_decimals', () => {
  it('values the same inner balance 10^12 times higher when its extra_decimals are ignored (0 instead of 12)', () => {
    const lowExtra = new Map(assets).set(USDT, {
      tokenId: USDT,
      extraDecimals: 0,
      volatilityRatioBps: 8000,
    });
    const a = computeRisk(position, assets, prices).borrowedValueUsd18;
    const b = computeRisk(position, lowExtra, prices).borrowedValueUsd18; // wrongly treats inner as raw
    expect(b).toBe(a * 10n ** 12n);
  });
});

describe('liquidation rule (S: actions.rs compute_max_discount)', () => {
  it('is NOT liquidatable at exact equality (debt +20% makes adjusted debt == adjusted collateral)', () => {
    const report = stress({ name: 'eq', debtShockBps: 2_000 });
    expect(report.adjustedBorrowedUsd18).toBe(usd(300n));
    expect(report.adjustedCollateralUsd18).toBe(usd(300n));
    expect(report.liquidatable).toBe(false);
    expect(report.healthFactorBps).toBe(10_000n);
    expect(report.maxLiquidationDiscountBps).toBe(0n);
    expect(report.debtRiseToLiquidationBps).toBe(0n);
  });

  it('is liquidatable one bp beyond equality', () => {
    const report = stress({ name: 'eq+1', debtShockBps: 2_001 });
    expect(report.liquidatable).toBe(true);
    expect(report.healthFactorBps).toBe(9_999n);
  });

  it('computes the max liquidation discount as half the shortfall ratio', () => {
    // collateral -50%: adjusted collateral $150 vs adjusted debt $250 -> (250-150)/250/2 = 20%
    const report = stress({ name: 'c-50', collateralShockBps: -5_000 });
    expect(report.liquidatable).toBe(true);
    expect(report.healthFactorBps).toBe(6_000n);
    expect(report.maxLiquidationDiscountBps).toBe(2_000n);
    expect(report.collateralDropToLiquidationBps).toBe(0n);
  });

  it('counts only collateral: debt with no collateral is liquidatable, HF 0, LTV unbounded', () => {
    const r = computeRisk({ collateral: [], borrowed: position.borrowed }, assets, prices);
    expect(r.liquidatable).toBe(true);
    expect(r.healthFactorBps).toBe(0n);
    expect(r.ltvBps).toBeNull();
    expect(r.liquidationThresholdBps).toBeNull();
    expect(r.maxLiquidationDiscountBps).toBe(5_000n);
  });

  it('a position without debt has no health factor and is never liquidatable', () => {
    const r = computeRisk({ collateral: position.collateral, borrowed: [] }, assets, prices);
    expect(r.hasDebt).toBe(false);
    expect(r.healthFactorBps).toBeNull();
    expect(r.liquidatable).toBe(false);
    expect(r.ltvBps).toBe(0n);
    expect(r.collateralDropToLiquidationBps).toBeNull();
  });

  it('ignores zero balances', () => {
    const r = computeRisk(
      {
        collateral: [...position.collateral, { tokenId: USDT, inner: 0n }],
        borrowed: position.borrowed,
      },
      assets,
      prices,
    );
    expect(r.collateral).toHaveLength(1);
  });
});

describe('multi-asset positions', () => {
  it('sums adjusted values across assets', () => {
    const both: RiskPosition = {
      collateral: [
        { tokenId: WNEAR, inner: 100n * ONE_NEAR_INNER },
        { tokenId: USDT, inner: 100n * ONE_USDT_INNER }, // $100 at 80% -> $80
      ],
      borrowed: [{ tokenId: USDT, inner: 100n * ONE_USDT_INNER }], // $100 / 0.8 -> $125
    };
    const r = computeRisk(both, assets, prices);
    expect(r.adjustedCollateralUsd18).toBe(usd(380n));
    expect(r.adjustedBorrowedUsd18).toBe(usd(125n));
    expect(r.collateralValueUsd18).toBe(usd(600n));
    expect(r.ltvBps).toBe(1_667n); // ceil(100/600 * 10000)
  });
});

describe('fail-closed behaviour', () => {
  it('throws MissingPriceError for a missing price', () => {
    expect(() => computeRisk(position, assets, new Map([[WNEAR, prices.get(WNEAR)!]]))).toThrow(
      MissingPriceError,
    );
  });

  it('throws MissingPriceError for a zero multiplier', () => {
    const zero = new Map(prices).set(USDT, { multiplier: 0n, decimals: 10 });
    expect(() => computeRisk(position, assets, zero)).toThrow(MissingPriceError);
  });

  it('throws MissingPriceError when asset parameters are unknown', () => {
    expect(() => computeRisk(position, new Map([[WNEAR, assets.get(WNEAR)!]]), prices)).toThrow(
      MissingPriceError,
    );
  });

  it('rejects a borrowed asset with a zero volatility ratio', () => {
    const zero = new Map(assets).set(USDT, {
      tokenId: USDT,
      extraDecimals: 12,
      volatilityRatioBps: 0,
    });
    expect(() => computeRisk(position, zero, prices)).toThrow(RangeError);
  });

  it('rejects shocks below -100% and non-integer shocks', () => {
    expect(() =>
      runStressScenarios(position, assets, prices, [{ name: 'x', collateralShockBps: -10_001 }]),
    ).toThrow(RangeError);
    expect(() =>
      runStressScenarios(position, assets, prices, [{ name: 'x', debtShockBps: 1.5 }]),
    ).toThrow(RangeError);
  });
});

describe('stress scenarios', () => {
  it('runs every default scenario independently and monotonically', () => {
    const results = runStressScenarios(position, assets, prices, DEFAULT_STRESS_SCENARIOS);
    expect(results).toHaveLength(DEFAULT_STRESS_SCENARIOS.length);
    const byName = Object.fromEntries(results.map((x) => [x.scenario.name, x.report]));
    expect(byName['collateral -10%']?.healthFactorBps).toBe(10_800n); // 270/250
    expect(byName['collateral -20%']?.healthFactorBps).toBe(9_600n); // 240/250
    expect(byName['collateral -20%']?.liquidatable).toBe(true);
    expect(byName['debt +10%']?.healthFactorBps).toBe(10_909n); // 300/275 = 1.0909
    expect(byName['debt +25%']?.liquidatable).toBe(true);
    expect(byName['collateral -20% and debt +10%']?.healthFactorBps).toBe(8_727n); // 240/275 = 0.8727
    const hf = ['collateral -10%', 'collateral -20%', 'collateral -30%', 'collateral -50%'].map(
      (n) => byName[n]!.healthFactorBps!,
    );
    expect(hf).toEqual([...hf].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  });

  it('per-token shocks override the side-wide shock', () => {
    const report = stress({
      name: 'wnear only',
      collateralShockBps: -5_000,
      tokenShocksBps: new Map([[WNEAR, 0]]),
    });
    expect(report.healthFactorBps).toBe(12_000n);
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(position, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
    runStressScenarios(position, assets, prices, DEFAULT_STRESS_SCENARIOS);
    expect(JSON.stringify(position, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(before);
  });
});

describe('breakevenMoveBps', () => {
  it('matches the closed-form reference values', () => {
    expect(breakevenMoveBps(position, assets, prices, WNEAR, 'collateral')).toBe(1_666n);
    expect(breakevenMoveBps(position, assets, prices, USDT, 'borrowed')).toBe(2_000n);
  });

  it('is safe at the breakeven move and liquidatable one bp beyond it', () => {
    const fall = breakevenMoveBps(position, assets, prices, WNEAR, 'collateral')!;
    const safe = runStressScenarios(position, assets, prices, [
      { name: 's', tokenShocksBps: new Map([[WNEAR, -Number(fall)]]) },
    ])[0]!.report;
    const dead = runStressScenarios(position, assets, prices, [
      { name: 'd', tokenShocksBps: new Map([[WNEAR, -Number(fall) - 1]]) },
    ])[0]!.report;
    expect(safe.liquidatable).toBe(false);
    expect(dead.liquidatable).toBe(true);

    const rise = breakevenMoveBps(position, assets, prices, USDT, 'borrowed')!;
    const safeD = runStressScenarios(position, assets, prices, [
      { name: 's', tokenShocksBps: new Map([[USDT, Number(rise)]]) },
    ])[0]!.report;
    const deadD = runStressScenarios(position, assets, prices, [
      { name: 'd', tokenShocksBps: new Map([[USDT, Number(rise) + 1]]) },
    ])[0]!.report;
    expect(safeD.liquidatable).toBe(false);
    expect(deadD.liquidatable).toBe(true);
  });

  it('is consistent across many deterministic pseudo-random positions', () => {
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const p: RiskPosition = {
        collateral: [{ tokenId: WNEAR, inner: BigInt(50 + next(5000)) * ONE_NEAR_INNER }],
        borrowed: [{ tokenId: USDT, inner: BigInt(10 + next(1500)) * ONE_USDT_INNER }],
      };
      const fall = breakevenMoveBps(p, assets, prices, WNEAR, 'collateral');
      if (fall === null || fall < 2n) continue;
      const at = (bps: bigint) =>
        runStressScenarios(p, assets, prices, [
          { name: 'x', tokenShocksBps: new Map([[WNEAR, -Number(bps)]]) },
        ])[0]!.report;
      expect(at(fall - 1n).liquidatable).toBe(false);
      expect(at(fall + 1n).liquidatable).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('returns null when no move of that asset alone can liquidate, and 0 when already liquidatable', () => {
    // A small collateral asset next to a large one: losing ALL of it still leaves the position safe.
    const diversified: RiskPosition = {
      collateral: [
        { tokenId: WNEAR, inner: 1n * ONE_NEAR_INNER },
        { tokenId: USDT, inner: 1000n * ONE_USDT_INNER },
      ],
      borrowed: [{ tokenId: USDT, inner: 100n * ONE_USDT_INNER }],
    };
    expect(breakevenMoveBps(diversified, assets, prices, WNEAR, 'collateral')).toBeNull();
    expect(breakevenMoveBps(position, assets, prices, WNEAR, 'borrowed')).toBeNull(); // not borrowed
    const underwater: RiskPosition = {
      collateral: [{ tokenId: WNEAR, inner: 10n * ONE_NEAR_INNER }],
      borrowed: position.borrowed,
    };
    expect(breakevenMoveBps(underwater, assets, prices, WNEAR, 'collateral')).toBe(0n);
    expect(
      breakevenMoveBps(
        { collateral: position.collateral, borrowed: [] },
        assets,
        prices,
        WNEAR,
        'collateral',
      ),
    ).toBeNull();
  });
});
