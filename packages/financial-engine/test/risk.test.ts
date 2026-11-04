import { describe, expect, it } from 'vitest';
import {
  applyScenario,
  assessLendingPosition,
  classifyRisk,
  collateralDropBuffer,
  DEFAULT_COLLATERAL_STRESS,
  debtRiseBuffer,
  liquidationPrice,
  simulateLiquidation,
  stressTest,
  WAD,
  type LendingModel,
} from '../src';
import { canonicalJson } from '@near-autopilot/core';
import { forAll, type Gen } from './support/prop';

const e18 = 10n ** 18n;
/** $2000 per 1e18 raw units. */
const ETH = { multiplier: 2000n, decimals: 18 };
/** $1 per 1e6 raw units, written with 4 extra decimals so that liquidation prices have a resolution of 0.0001. */
const USDC = { multiplier: 10_000n, decimals: 10 };

/** 10 ETH ($20,000) at 80% threshold against $10,000 of debt. */
const base: LendingModel = {
  collateral: [{ id: 'ETH', amount: 10n * e18, price: ETH, liquidationThresholdBps: 8000 }],
  debt: [{ id: 'USDC', amount: 10_000n * 10n ** 6n, price: USDC }],
};

describe('assessLendingPosition: hand-computed fixture', () => {
  const a = assessLendingPosition(base);
  it('values and ratios', () => {
    expect(a.collateralUsd).toBe(20_000_000_000n); // $20,000 in micro-USD
    expect(a.debtUsd).toBe(10_000_000_000n);
    expect(a.adjustedCollateralUsd).toBe(16_000_000_000n);
    expect(a.adjustedDebtUsd).toBe(10_000_000_000n);
    expect(a.healthFactorWad).toBe((16n * e18) / 10n); // 1.6
    expect(a.ltvBps).toBe(5000n);
    expect(a.weightedLiquidationThresholdBps).toBe(8000n);
    expect(a.headroomUsd).toBe(6_000_000_000n);
    expect(a.liquidatable).toBe(false);
  });
  it('status bands: policy defaults, overridable', () => {
    expect(classifyRisk(a)).toBe('healthy');
    expect(classifyRisk(a, { dangerBelowWad: 2n * WAD, watchBelowWad: 3n * WAD })).toBe('danger');
    expect(() => classifyRisk(a, { dangerBelowWad: 3n * WAD, watchBelowWad: 2n * WAD })).toThrow(
      RangeError,
    );
  });
});

describe('the liquidation line is exactly HF < 1', () => {
  const at = (debtRaw: bigint): LendingModel => ({
    ...base,
    debt: [{ id: 'USDC', amount: debtRaw, price: USDC }],
  });
  it('HF = 1.0 exactly is NOT liquidatable ($16,000 debt against $16,000 adjusted collateral)', () => {
    const a = assessLendingPosition(at(16_000n * 10n ** 6n));
    expect(a.healthFactorWad).toBe(WAD);
    expect(a.liquidatable).toBe(false);
    expect(classifyRisk(a)).toBe('danger');
  });
  it('one micro-dollar more debt is liquidatable and HF drops below 1', () => {
    const a = assessLendingPosition(at(16_000n * 10n ** 6n + 1n));
    expect(a.liquidatable).toBe(true);
    expect(a.healthFactorWad! < WAD).toBe(true);
    expect(classifyRisk(a)).toBe('liquidatable');
  });
  it('property: liquidatable <=> HF < 1 exactly (floor division cannot straddle the line)', () => {
    forAll(
      { runs: 500 },
      (g) => ({ debt: g.bigBiased(1n, 40_000n * 10n ** 6n) }),
      ({ debt }) => {
        const a = assessLendingPosition(at(debt));
        expect(a.liquidatable).toBe(a.healthFactorWad! < WAD);
      },
    );
  });
});

describe('degenerate positions', () => {
  it('no debt: no health factor, zero LTV, status no-debt, buffers not applicable', () => {
    const m: LendingModel = { ...base, debt: [] };
    const a = assessLendingPosition(m);
    expect([a.healthFactorWad, a.ltvBps, a.liquidatable]).toEqual([null, 0n, false]);
    expect(classifyRisk(a)).toBe('no-debt');
    expect(collateralDropBuffer(m)).toEqual({ kind: 'no-debt' });
    expect(debtRiseBuffer(m)).toEqual({ kind: 'no-debt' });
    expect(liquidationPrice(m, 'collateral', 'ETH')).toEqual({ kind: 'no-debt' });
  });
  it('debt with no collateral: HF 0, LTV unbounded, liquidatable', () => {
    const a = assessLendingPosition({ collateral: [], debt: base.debt });
    expect([
      a.healthFactorWad,
      a.ltvBps,
      a.weightedLiquidationThresholdBps,
      a.liquidatable,
    ]).toEqual([0n, null, null, true]);
  });
  it('empty model', () => {
    const a = assessLendingPosition({ collateral: [], debt: [] });
    expect(a.healthFactorWad).toBeNull();
    expect(a.collateralUsd).toBe(0n);
  });
  it('borrow factor divides debt: 80% borrow factor turns $10,000 debt into $12,500 adjusted debt', () => {
    const a = assessLendingPosition({
      ...base,
      debt: [{ ...base.debt[0]!, borrowFactorBps: 8000 }],
    });
    expect(a.adjustedDebtUsd).toBe(12_500_000_000n);
    expect(a.healthFactorWad).toBe((128n * e18) / 100n);
  });
  it('rounding is pessimistic: debt rounds up, collateral rounds down', () => {
    // 1 raw unit of a token worth 1.5e-6 USD/unit: value 1.5 micro-USD -> collateral 1, debt 2
    const price = { multiplier: 15n, decimals: 1 + 6 }; // 15/10^7 = 1.5e-6 USD per raw unit
    const a = assessLendingPosition({
      collateral: [{ id: 'C', amount: 1n, price, liquidationThresholdBps: 10_000 }],
      debt: [{ id: 'D', amount: 1n, price }],
    });
    expect(a.collateralUsd).toBe(1n);
    expect(a.debtUsd).toBe(2n);
  });
});

describe('validation', () => {
  it('rejects malformed models', () => {
    expect(() =>
      assessLendingPosition({ ...base, collateral: [base.collateral[0]!, base.collateral[0]!] }),
    ).toThrow('duplicate');
    expect(() =>
      assessLendingPosition({
        ...base,
        collateral: [{ ...base.collateral[0]!, liquidationThresholdBps: 10_001 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      assessLendingPosition({ ...base, debt: [{ ...base.debt[0]!, borrowFactorBps: 0 }] }),
    ).toThrow(RangeError);
    expect(() =>
      assessLendingPosition({ ...base, debt: [{ ...base.debt[0]!, amount: -1n }] }),
    ).toThrow(RangeError);
    expect(() => applyScenario(base, { name: 'x', collateralShockBps: -10_001 })).toThrow(
      RangeError,
    );
    expect(() => applyScenario(base, { name: 'x', debtShockBps: 1.5 })).toThrow(RangeError);
    expect(() => applyScenario(base, { name: 'x', debtInterestBps: -1 })).toThrow(RangeError);
  });
});

describe('collateral stress testing: hand-computed', () => {
  it('default scenarios', () => {
    const r = Object.fromEntries(
      stressTest(base, DEFAULT_COLLATERAL_STRESS).map((x) => [x.scenario.name, x]),
    );
    expect(r['collateral -10%']!.assessment.healthFactorWad).toBe((144n * e18) / 100n);
    expect(r['collateral -20%']!.assessment.healthFactorWad).toBe((128n * e18) / 100n);
    expect(r['collateral -30%']!.assessment.healthFactorWad).toBe((112n * e18) / 100n);
    expect(r['collateral -50%']!.assessment.healthFactorWad).toBe((8n * e18) / 10n);
    expect(r['debt +25%']!.assessment.healthFactorWad).toBe((128n * e18) / 100n);
    // 0.7 * 16000 / (1.1 * 10000) = 1.01818...
    expect(r['collateral -30% and debt +10%']!.assessment.healthFactorWad).toBe(
      1_018_181_818_181_818_181n,
    );
    expect(r['collateral -10%']!.status).toBe('watch');
    expect(r['collateral -30%']!.status).toBe('watch');
    expect(r['collateral -50%']!.status).toBe('liquidatable');
    expect(r['collateral -30% and debt +10%']!.status).toBe('danger');
  });

  it('shocks are exact (no rounding): -3750 bps is HF exactly 1.0, -3751 bps is liquidatable', () => {
    const exact = assessLendingPosition(
      applyScenario(base, { name: 'a', collateralShockBps: -3750 }),
    );
    expect(exact.healthFactorWad).toBe(WAD);
    expect(exact.liquidatable).toBe(false);
    expect(
      assessLendingPosition(applyScenario(base, { name: 'b', collateralShockBps: -3751 }))
        .liquidatable,
    ).toBe(true);
  });

  it('interest accrual, per-asset overrides and -100% shocks', () => {
    // 5% interest: debt 10,500 -> HF = 16000/10500
    expect(
      assessLendingPosition(applyScenario(base, { name: 'i', debtInterestBps: 500 }))
        .healthFactorWad,
    ).toBe(1_523_809_523_809_523_809n);
    // an asset override beats the default
    const m = applyScenario(base, {
      name: 'o',
      collateralShockBps: -5000,
      assetShocksBps: new Map([['ETH', 0]]),
    });
    expect(assessLendingPosition(m).healthFactorWad).toBe((16n * e18) / 10n);
    expect(
      assessLendingPosition(applyScenario(base, { name: 'wipe', collateralShockBps: -10_000 }))
        .healthFactorWad,
    ).toBe(0n);
  });

  it('never mutates its input', () => {
    const before = canonicalJson(base);
    stressTest(base, DEFAULT_COLLATERAL_STRESS);
    collateralDropBuffer(base);
    liquidationPrice(base, 'collateral', 'ETH');
    expect(canonicalJson(base)).toBe(before);
  });
});

describe('distance to liquidation: hand-computed', () => {
  it('collateral can fall 37.5% (3750 bps) and debt can rise 60% (6000 bps)', () => {
    expect(collateralDropBuffer(base)).toEqual({ kind: 'buffer', bps: 3750, capped: false });
    expect(debtRiseBuffer(base)).toEqual({ kind: 'buffer', bps: 6000, capped: false });
  });
  it('liquidation price of ETH is $1250 (HF = 1.0 there), 3750 bps below today', () => {
    expect(liquidationPrice(base, 'collateral', 'ETH')).toEqual({
      kind: 'price',
      multiplier: 1250n,
      decimals: 18,
      moveToLiquidationBps: 3750n,
    });
  });
  it('liquidation price of the debt asset is $1.60 per USDC, 6000 bps above today', () => {
    expect(liquidationPrice(base, 'debt', 'USDC')).toEqual({
      kind: 'price',
      multiplier: 16_000n,
      decimals: 10,
      moveToLiquidationBps: 6000n,
    });
  });
  it('already liquidatable positions say so', () => {
    const bad: LendingModel = {
      ...base,
      debt: [{ ...base.debt[0]!, amount: 20_000n * 10n ** 6n }],
    };
    expect(collateralDropBuffer(bad)).toEqual({ kind: 'liquidatable' });
    expect(liquidationPrice(bad, 'collateral', 'ETH')).toEqual({ kind: 'already-liquidatable' });
  });
  it('other collateral can make a single asset irrelevant ("never")', () => {
    const m: LendingModel = {
      collateral: [
        ...base.collateral,
        { id: 'STABLE', amount: 100_000n * 10n ** 6n, price: USDC, liquidationThresholdBps: 9000 },
      ],
      debt: base.debt,
    };
    expect(liquidationPrice(m, 'collateral', 'ETH')).toEqual({ kind: 'never' });
  });
  it('unknown assets throw', () => {
    expect(() => liquidationPrice(base, 'collateral', 'NOPE')).toThrow('unknown');
  });
});

function randomModel(g: Gen): LendingModel {
  const nc = g.int(1, 3);
  const nd = g.int(1, 2);
  return {
    collateral: Array.from({ length: nc }, (_, i) => ({
      id: `c${i}`,
      amount: g.bigBiased(10n ** 12n, 10n ** 24n),
      price: { multiplier: g.big(1n, 10n ** 9n), decimals: g.int(10, 22) },
      liquidationThresholdBps: g.int(3000, 9500),
    })),
    debt: Array.from({ length: nd }, (_, i) => ({
      id: `d${i}`,
      amount: g.bigBiased(10n ** 9n, 10n ** 22n),
      price: { multiplier: g.big(1n, 10n ** 9n), decimals: g.int(10, 22) },
      borrowFactorBps: g.pick([10_000, 9000, 8000, 6000]),
    })),
  };
}

describe('properties', () => {
  it('buffers are exact: safe at the returned shock, liquidatable one bp beyond', () => {
    forAll({ runs: 150 }, randomModel, (m) => {
      const buf = collateralDropBuffer(m);
      if (buf.kind !== 'buffer') {
        expect(assessLendingPosition(m).liquidatable || buf.kind === 'no-debt').toBe(true);
        return;
      }
      expect(
        assessLendingPosition(applyScenario(m, { name: 's', collateralShockBps: -buf.bps }))
          .liquidatable,
      ).toBe(false);
      if (!buf.capped)
        expect(
          assessLendingPosition(applyScenario(m, { name: 'u', collateralShockBps: -(buf.bps + 1) }))
            .liquidatable,
        ).toBe(true);
      const rise = debtRiseBuffer(m);
      if (rise.kind === 'buffer' && !rise.capped) {
        expect(
          assessLendingPosition(applyScenario(m, { name: 's', debtShockBps: rise.bps }))
            .liquidatable,
        ).toBe(false);
        expect(
          assessLendingPosition(applyScenario(m, { name: 'u', debtShockBps: rise.bps + 1 }))
            .liquidatable,
        ).toBe(true);
      }
    });
  });

  it('liquidation prices are tight: safe at the price, unsafe one multiplier unit below (collateral) or above (debt)', () => {
    forAll({ runs: 100 }, randomModel, (m) => {
      const withMult = (side: 'collateral' | 'debt', id: string, mult: bigint): LendingModel =>
        side === 'collateral'
          ? {
              ...m,
              collateral: m.collateral.map((c) =>
                c.id === id ? { ...c, price: { ...c.price, multiplier: mult } } : c,
              ),
            }
          : {
              ...m,
              debt: m.debt.map((d) =>
                d.id === id ? { ...d, price: { ...d.price, multiplier: mult } } : d,
              ),
            };
      const c = liquidationPrice(m, 'collateral', 'c0');
      if (c.kind === 'price') {
        expect(assessLendingPosition(withMult('collateral', 'c0', c.multiplier)).liquidatable).toBe(
          false,
        );
        expect(
          assessLendingPosition(withMult('collateral', 'c0', c.multiplier - 1n)).liquidatable,
        ).toBe(true);
      }
      const d = liquidationPrice(m, 'debt', 'd0');
      if (d.kind === 'price') {
        expect(assessLendingPosition(withMult('debt', 'd0', d.multiplier)).liquidatable).toBe(
          false,
        );
        expect(assessLendingPosition(withMult('debt', 'd0', d.multiplier + 1n)).liquidatable).toBe(
          true,
        );
      }
    });
  });

  it('health factor is monotone: up with collateral price, down with debt price, and zero shocks change nothing', () => {
    forAll(
      {},
      (g) => ({ m: randomModel(g), a: g.int(0, 5000), b: g.int(0, 5000) }),
      ({ m, a, b }) => {
        const hf = (s: { collateralShockBps?: number; debtShockBps?: number }) =>
          assessLendingPosition(applyScenario(m, { name: 'x', ...s })).healthFactorWad!;
        expect(hf({ collateralShockBps: a + b }) >= hf({ collateralShockBps: a })).toBe(true);
        expect(hf({ debtShockBps: a + b }) <= hf({ debtShockBps: a })).toBe(true);
        expect(assessLendingPosition(applyScenario(m, { name: 'zero' }))).toEqual(
          assessLendingPosition(m),
        );
      },
    );
  });
});

describe('simulateLiquidation', () => {
  const crashed = applyScenario(base, { name: 'crash', collateralShockBps: -5000 }); // ETH $1000: collateral $10,000, adjusted $8,000 vs $10,000 debt
  it('hand-computed: 50% close factor, 5% bonus', () => {
    const r = simulateLiquidation(crashed, {
      debtId: 'USDC',
      collateralId: 'ETH',
      closeFactorBps: 5000,
      bonusBps: 500,
    });
    expect(r.repaidDebtAmount).toBe(5_000n * 10n ** 6n); // $5,000 of USDC
    expect(r.seizedUsd).toBe(5_250_000_000n); // $5,250 of ETH = 5.25 ETH at $1000
    expect(r.seizedCollateralAmount).toBe((525n * e18) / 100n);
    expect(r.borrowerLossUsd).toBe(250_000_000n); // the 5% incentive: $250
    expect(r.collateralExhausted).toBe(false);
    // afterwards: 4.75 ETH ($4,750 -> $3,800 adjusted) vs $5,000 debt -> HF 0.76: liquidation made it WORSE here
    expect(r.assessmentAfter.healthFactorWad).toBe((76n * e18) / 100n);
  });

  it('collateral exhausted: the liquidator takes everything and repays only what it covers', () => {
    const tiny: LendingModel = {
      collateral: [
        {
          id: 'ETH',
          amount: e18,
          price: { multiplier: 1000n, decimals: 18 },
          liquidationThresholdBps: 8000,
        },
      ],
      debt: [{ id: 'USDC', amount: 5_000n * 10n ** 6n, price: USDC }],
    };
    const r = simulateLiquidation(tiny, {
      debtId: 'USDC',
      collateralId: 'ETH',
      closeFactorBps: 10_000,
      bonusBps: 500,
    });
    expect(r.collateralExhausted).toBe(true);
    expect(r.seizedCollateralAmount).toBe(e18);
    expect(r.repaidUsd).toBe(952_380_952n); // 1000 / 1.05, rounded down
    expect(r.assessmentAfter.collateralUsd).toBe(0n);
  });

  it('refuses healthy positions and unknown assets', () => {
    expect(() =>
      simulateLiquidation(base, {
        debtId: 'USDC',
        collateralId: 'ETH',
        closeFactorBps: 5000,
        bonusBps: 500,
      }),
    ).toThrow('not liquidatable');
    expect(() =>
      simulateLiquidation(crashed, {
        debtId: 'X',
        collateralId: 'ETH',
        closeFactorBps: 5000,
        bonusBps: 500,
      }),
    ).toThrow('unknown');
    expect(() =>
      simulateLiquidation(crashed, {
        debtId: 'USDC',
        collateralId: 'ETH',
        closeFactorBps: 10_001,
        bonusBps: 500,
      }),
    ).toThrow(RangeError);
  });

  it('property: accounting is conserved and the borrower pays at most the incentive', () => {
    forAll(
      { runs: 200 },
      (g) => ({
        m: randomModel(g),
        cf: g.int(1, 10_000),
        bonus: g.int(0, 3000),
        crash: g.int(1000, 9500),
      }),
      ({ m, cf, bonus, crash }) => {
        const stressed = applyScenario(m, { name: 'c', collateralShockBps: -crash });
        if (!assessLendingPosition(stressed).liquidatable) return;
        const r = simulateLiquidation(stressed, {
          debtId: 'd0',
          collateralId: 'c0',
          closeFactorBps: cf,
          bonusBps: bonus,
        });
        const debtBefore = stressed.debt.find((d) => d.id === 'd0')!.amount;
        const colBefore = stressed.collateral.find((c) => c.id === 'c0')!.amount;
        expect(r.after.debt.find((d) => d.id === 'd0')!.amount).toBe(
          debtBefore - r.repaidDebtAmount,
        );
        expect(r.after.collateral.find((c) => c.id === 'c0')!.amount).toBe(
          colBefore - r.seizedCollateralAmount,
        );
        expect(r.repaidDebtAmount <= (debtBefore * BigInt(cf)) / 10_000n).toBe(true);
        expect(r.seizedCollateralAmount <= colBefore).toBe(true);
        expect(r.borrowerLossUsd <= r.seizedUsd).toBe(true);
      },
    );
  });
});

describe('rounding direction is pessimistic everywhere it matters (mutation-hardening fixtures)', () => {
  it('borrow factor: 10 micro-USD of debt at a 30% borrow factor is 33.33.. -> 34 adjusted (rounds up)', () => {
    const a = assessLendingPosition({
      ...base,
      debt: [{ id: 'USDC', amount: 10n, price: USDC, borrowFactorBps: 3000 }],
    });
    expect(a.debtUsd).toBe(10n);
    expect(a.adjustedDebtUsd).toBe(34n);
  });

  it('interest: 3 raw units + 5% = 3.15 -> 4 (accrued debt rounds up, never down)', () => {
    const m = applyScenario(
      { ...base, debt: [{ id: 'USDC', amount: 3n, price: USDC }] },
      { name: 'i', debtInterestBps: 500 },
    );
    expect(m.debt[0]!.amount).toBe(4n);
  });

  it('seized collateral covers the bonus rounded UP (favouring the liquidator = worst case for the borrower)', () => {
    // ETH $1000: 5e9 wei is $5e-6 (5 micro-USD). Debt: 6 micro-USD. Repay 50% = 3 micro-USD; x1.05 = 3.15 -> 4 micro-USD -> 4e9 wei.
    const tiny: LendingModel = {
      collateral: [
        {
          id: 'ETH',
          amount: 5n * 10n ** 9n,
          price: { multiplier: 1000n, decimals: 18 },
          liquidationThresholdBps: 8000,
        },
      ],
      debt: [{ id: 'USDC', amount: 6n, price: USDC }],
    };
    const r = simulateLiquidation(tiny, {
      debtId: 'USDC',
      collateralId: 'ETH',
      closeFactorBps: 5000,
      bonusBps: 500,
    });
    expect(r.repaidDebtAmount).toBe(3n);
    expect(r.seizedCollateralAmount).toBe(4n * 10n ** 9n);
  });

  it('property: moveToLiquidationBps is the smallest integer bps move that reaches the liquidation price', () => {
    forAll({ runs: 100 }, randomModel, (m) => {
      const c = liquidationPrice(m, 'collateral', 'c0');
      if (c.kind === 'price') {
        const cur = m.collateral[0]!.price.multiplier;
        const exact = (cur - c.multiplier) * 10_000n; // compare move*cur against exact without division
        expect(c.moveToLiquidationBps * cur >= exact).toBe(true);
        expect((c.moveToLiquidationBps - 1n) * cur < exact).toBe(true);
      }
      const d = liquidationPrice(m, 'debt', 'd0');
      if (d.kind === 'price') {
        const cur = m.debt[0]!.price.multiplier;
        const exact = (d.multiplier - cur) * 10_000n;
        expect(d.moveToLiquidationBps * cur >= exact).toBe(true);
        expect((d.moveToLiquidationBps - 1n) * cur < exact).toBe(true);
      }
    });
  });
});
