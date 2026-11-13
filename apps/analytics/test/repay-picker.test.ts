import { describe, expect, it } from 'vitest';
import { amountText, pickRepay } from '../lib/repay-picker';

// The demo wallet: 53.87 USDC collateral, 37.87 USDC borrowed, vr 0.95, $1.
const sizing = {
  collateralAdjUsd: 53.87 * 0.95,
  debtAdjUsd: 37.87 / 0.95,
  vr: 0.95,
  usdPerToken: 1,
  symbol: 'USDC',
  decimals: 6,
  hfNow: 1.28,
  targetHf: 1.6,
  safeTokens: 17.167634,
  maxTokens: 37.87,
  wholeDebt: true,
};

describe('pickRepay', () => {
  it('shows the health factor after the typed amount, coloured by zone', () => {
    const p = pickRepay(sizing, 'collateral', '17.167634');
    expect(p?.raw).toBe('17167634');
    expect(p?.hf).toBeCloseTo(1.6, 3);
    expect(p?.zone).toBe('low');
    expect(pickRepay(sizing, 'collateral', '3')?.zone).toBe('medium');
  });

  it('caps the amount at the largest repayment', () => {
    expect(pickRepay({ ...sizing, wholeDebt: false }, 'collateral', '99')?.tokens).toBe(37.87);
  });

  it('asks for a little more than the whole debt so accrued interest is covered (the contract caps it)', () => {
    const p = pickRepay(sizing, 'collateral', '37.87');
    expect(p?.hf).toBeNull();
    expect(BigInt(p?.raw ?? '0')).toBeGreaterThan(37_870_000n);
  });

  it('does not call the loan repaid while debt in another token is left', () => {
    const twoDebts = { ...sizing, debtAdjUsd: sizing.debtAdjUsd + 10 };
    const p = pickRepay(twoDebts, 'collateral', '37.87');
    expect(p?.hf).not.toBeNull();
    expect(p?.hf).toBeGreaterThan(1.28);
  });

  it('has nothing to prepare for zero or a non-number', () => {
    expect(pickRepay(sizing, 'collateral', '0')).toBeNull();
    expect(pickRepay(sizing, 'collateral', 'abc')).toBeNull();
  });
});

describe('amountText', () => {
  it('writes an amount without trailing zeros, at most 6 decimals', () => {
    expect(amountText(17.1676341, 6)).toBe('17.167635');
    expect(amountText(37.87, 6)).toBe('37.87');
    expect(amountText(5, 0)).toBe('5');
  });
});
