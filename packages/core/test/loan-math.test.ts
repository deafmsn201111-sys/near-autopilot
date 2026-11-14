import { describe, expect, it } from 'vitest';
import {
  healthZone,
  hfAfterRepay,
  repayToReach,
  SWAP_REPAY_FLOOR_HF,
  swapRepayPlan,
  toRawAmount,
  withdrawableToKeep,
  type LoanModel,
  type SwapRepayInput,
} from '../src/loan-math';

// The demo wallet: 53.87 USDC collateral, 37.87 USDC borrowed, volatility ratio 0.95, $1 per token.
const demo: LoanModel = {
  collateralAdjUsd: 53.87 * 0.95,
  debtAdjUsd: 37.87 / 0.95,
  vr: 0.95,
  usdPerToken: 1,
};
const directHf = (collateral: number, debt: number) => (collateral * 0.95) / (debt / 0.95);

describe('loan math (Burrow health factor)', () => {
  it('repaying from collateral lowers both sides by the same tokens', () => {
    expect(hfAfterRepay(demo, 10, 'collateral')).toBeCloseTo(directHf(43.87, 27.87), 9);
  });

  it('repaying from the wallet lowers only the debt', () => {
    expect(hfAfterRepay(demo, 10, 'wallet')).toBeCloseTo(directHf(53.87, 27.87), 9);
  });

  it('repaying the whole debt leaves no health factor (nothing to liquidate)', () => {
    expect(hfAfterRepay(demo, 37.87, 'collateral')).toBeNull();
  });

  it('sizes the repayment from collateral that restores the target exactly', () => {
    const x = repayToReach(demo, 1.6, 'collateral');
    expect(x).toBeCloseTo(17.1676, 3);
    expect(directHf(53.87 - x, 37.87 - x)).toBeCloseTo(1.6, 9);
  });

  it('sizes the repayment from the wallet that restores the target exactly', () => {
    const x = repayToReach(demo, 1.6, 'wallet');
    expect(directHf(53.87, 37.87 - x)).toBeCloseTo(1.6, 9);
  });

  it('needs no repayment when the target is already met', () => {
    expect(repayToReach(demo, 1.2, 'collateral')).toBe(0);
  });

  it('withdraws only what keeps the health factor at the target, everything when there is no debt', () => {
    const after = { ...demo, debtAdjUsd: 20 / 0.95 };
    const x = withdrawableToKeep(after, 1.6);
    expect(directHf(53.87 - x, 20)).toBeCloseTo(1.6, 9);
    expect(withdrawableToKeep(demo, 1.6)).toBe(0);
    expect(withdrawableToKeep({ ...demo, debtAdjUsd: 0 }, 1.6)).toBe(Infinity);
  });

  it('colours a health factor by the same zones as the loan-safety chip', () => {
    expect(healthZone(1.05)).toBe('high');
    expect(healthZone(1.28)).toBe('medium');
    expect(healthZone(1.6)).toBe('low');
    expect(healthZone(null)).toBe('low');
  });

  it('turns a typed decimal amount into exact base units', () => {
    expect(toRawAmount('17.30', 6)).toBe(17_300_000n);
    expect(toRawAmount('0.1', 24)).toBe(100_000_000_000_000_000_000_000n);
    expect(toRawAmount('1.2345678', 6)).toBe(1_234_567n);
    expect(toRawAmount('abc', 6)).toBeNull();
    expect(toRawAmount('', 6)).toBeNull();
  });
});

describe('swap-repay plan (withdraw another collateral -> swap -> repay)', () => {
  // 200 wNEAR collateral at $3 (vr 0.6), 250 USDC debt at $1 (vr 0.95): HF 360 / 263.16 = 1.368.
  const C = 200 * 3 * 0.6;
  const D = 250 / 0.95;
  const base: SwapRepayInput = {
    model: { collateralAdjUsd: C, debtAdjUsd: D },
    collateral: { usdPerToken: 3, vr: 0.6, deposited: 0, collateral: 200, wallet: 0 },
    debt: { usdPerToken: 1, vr: 0.95, amount: 250, wallet: 0 },
    outPerIn: 3 * 0.995, // USDC per wNEAR at the swap's min-out
    target: 1.6,
    floor: SWAP_REPAY_FLOOR_HF,
  };
  // Independent of the code under test: the HF after taking `fromCollateral` wNEAR out and repaying `repay` USDC.
  const hf = (fromCollateral: number, repay: number) =>
    (C - fromCollateral * 3 * 0.6) / (D - repay / 0.95);
  const ok = (i: SwapRepayInput) => {
    const p = swapRepayPlan(i);
    if (!p.ok) throw new Error(`expected a plan, got ${p.reason}`);
    return p;
  };

  it('keeps the floor at 1.15', () => {
    expect(SWAP_REPAY_FLOOR_HF).toBe(1.15);
  });

  it('withdraws just enough to reach the target, and step 1 stays above the floor', () => {
    const p = ok(base);
    expect(p.fromWallet).toBe(0);
    expect(p.withdraw).toBeCloseTo(p.swapIn, 9);
    expect(p.minOut).toBeCloseTo(p.swapIn * 2.985, 9);
    expect(p.repay).toBeCloseTo(p.minOut, 9);
    expect(hf(p.withdraw, p.repay)).toBeCloseTo(1.6, 4);
    expect(p.hfAfterRepay).toBeCloseTo(1.6, 4);
    expect(p.hfAfterWithdraw).toBeCloseTo(hf(p.withdraw, 0), 9);
    expect(p.hfAfterWithdraw).toBeGreaterThanOrEqual(1.15);
    expect(p.hfAfterWithdraw).toBeLessThan(base.model.collateralAdjUsd / D);
  });

  it('stops at the floor when the target needs more, still raising the HF', () => {
    // 290 USDC debt: HF 1.18, so step 1 may take only what keeps 1.15.
    const d = 290 / 0.95;
    const p = ok({
      ...base,
      model: { collateralAdjUsd: C, debtAdjUsd: d },
      debt: { ...base.debt, amount: 290 },
    });
    expect(p.hfAfterWithdraw).toBeCloseTo(1.15, 6);
    expect(p.hfAfterRepay).not.toBeNull();
    expect(p.hfAfterRepay as number).toBeGreaterThan(C / d);
    expect(p.hfAfterRepay as number).toBeLessThan(1.6);
  });

  it('offers nothing when any withdrawal would take the HF under the floor', () => {
    const d = 320 / 0.95; // HF 1.07
    const p = swapRepayPlan({
      ...base,
      model: { collateralAdjUsd: C, debtAdjUsd: d },
      debt: { ...base.debt, amount: 320 },
    });
    expect(p).toEqual({ ok: false, reason: 'floor' });
  });

  it('swaps the collateral token already in the wallet first and withdraws only the rest', () => {
    const p = ok({ ...base, collateral: { ...base.collateral, wallet: 10 } });
    expect(p.fromWallet).toBe(10);
    expect(p.withdraw).toBeCloseTo(p.swapIn - 10, 9);
    expect(hf(p.withdraw, p.repay)).toBeCloseTo(1.6, 4);
  });

  it('needs no withdrawal when the wallet holds enough, even under the floor', () => {
    const d = 320 / 0.95;
    const p = ok({
      ...base,
      model: { collateralAdjUsd: C, debtAdjUsd: d },
      debt: { ...base.debt, amount: 320 },
      collateral: { ...base.collateral, wallet: 100 },
    });
    expect(p.withdraw).toBe(0);
    expect(p.hfAfterWithdraw).toBeCloseTo(C / d, 9);
    expect(C / (d - p.repay / 0.95)).toBeCloseTo(1.6, 4);
  });

  it('takes plain (non-collateral) supply of the token before collateral: it does not move the HF', () => {
    const p = ok({ ...base, collateral: { ...base.collateral, deposited: 5 } });
    expect(p.hfAfterWithdraw).toBeCloseTo(hf(p.withdraw - 5, 0), 9);
    expect(hf(p.withdraw - 5, p.repay)).toBeCloseTo(1.6, 4);
  });

  it('adds the debt token already in the wallet to the repayment', () => {
    const p = ok({ ...base, debt: { ...base.debt, wallet: 20 } });
    expect(p.repay).toBeCloseTo(p.minOut + 20, 9);
    expect(hf(p.withdraw, p.repay)).toBeCloseTo(1.6, 4);
  });

  it('repays a small debt in full and swaps no more than that needs', () => {
    const d = 30 / 0.95;
    const p = ok({
      ...base,
      model: { collateralAdjUsd: C, debtAdjUsd: d },
      debt: { ...base.debt, amount: 30 },
    });
    expect(p.repay).toBeCloseTo(30, 9);
    expect(p.swapIn).toBeCloseTo(30 / 2.985, 6);
    expect(p.hfAfterRepay).toBeNull();
  });

  it('offers nothing when the swap loses so much that repaying would not raise the HF', () => {
    expect(swapRepayPlan({ ...base, outPerIn: 0.5 })).toEqual({ ok: false, reason: 'no_gain' });
  });

  it('swaps only the wallet part when withdrawing collateral would lower the HF (deep under water)', () => {
    // HF 0.5 with vr 0.6 x 0.95: repaying with withdrawn collateral loses HF, the wallet's tokens still help.
    const d = 720 / 0.95;
    const p = ok({
      ...base,
      model: { collateralAdjUsd: C, debtAdjUsd: d },
      debt: { ...base.debt, amount: 720 },
      collateral: { ...base.collateral, wallet: 10 },
      floor: 0, // the floor alone would already stop it; this isolates the direction check
    });
    expect(p.withdraw).toBe(0);
    expect(p.swapIn).toBeCloseTo(10, 9);
    expect(p.hfAfterRepay as number).toBeGreaterThan(C / d);
  });

  it('offers nothing with no collateral of that token and none in the wallet', () => {
    expect(swapRepayPlan({ ...base, collateral: { ...base.collateral, collateral: 0 } })).toEqual({
      ok: false,
      reason: 'nothing',
    });
  });
});
