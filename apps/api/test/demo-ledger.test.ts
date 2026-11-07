import { describe, expect, it } from 'vitest';
import { applyLedger, DEMO_PORTFOLIOS } from '../src/simulation/demo-portfolios';

const base = DEMO_PORTFOLIOS['demo-5000']; // wallet 300 NEAR + 600 USDt, debt 2000 USDt, supplied 50 USDt
const USDT = 10n ** 6n;
const NEAR = 10n ** 24n;

describe('simulated demo ledger', () => {
  it('a repayment moves USDt from the wallet to the loan; a deposit moves tokens into Burrow', () => {
    const p = applyLedger(base, [
      { kind: 'repay', asset: 'usdt', amountRaw: 100n * USDT },
      { kind: 'supply', asset: 'usdt', amountRaw: 50n * USDT },
      { kind: 'supply', asset: 'near', amountRaw: 10n * NEAR },
    ]);
    expect(p.wallet).toEqual({ near: 290n * NEAR, usdt: 450n * USDT });
    expect(p.borrowed.usdt).toBe(1900n * USDT);
    expect(p.supplied).toEqual({ usdt: 100n * USDT, near: 10n * NEAR });
    expect(p.collateral).toEqual(base.collateral);
  });

  it('never goes negative: amounts are clamped to what the wallet and the loan hold', () => {
    const p = applyLedger(base, [{ kind: 'repay', asset: 'usdt', amountRaw: 10_000n * USDT }]);
    expect(p.wallet.usdt).toBe(0n);
    expect(p.borrowed.usdt).toBe(1400n * USDT);
  });

  it('a reset starts again from the base amounts', () => {
    const p = applyLedger(base, [
      { kind: 'repay', asset: 'usdt', amountRaw: 100n * USDT },
      { kind: 'reset', asset: null, amountRaw: 0n },
      { kind: 'supply', asset: 'usdt', amountRaw: 1n * USDT },
    ]);
    expect(p.borrowed.usdt).toBe(2000n * USDT);
    expect(p.wallet.usdt).toBe(599n * USDT);
  });
});
