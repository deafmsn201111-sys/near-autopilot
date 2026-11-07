import { describe, expect, it } from 'vitest';
import { loopFor, loopStrategies } from '../src/analytics/looping';

const usdt = {
  token: 'usdt.near',
  status: 'OK',
  supplyApr: '0.092',
  netSupplyApr: '0.092',
  borrowApr: '0.143',
  collateralFactor: 0.95,
  canUseAsCollateral: true,
  canBorrow: true,
  canDeposit: true,
  availableUsd: '2000000',
};
const opts = { equityUsd: 1000, targetHealthFactor: 1.6, gasUsdPerTx: 0.05, horizonDays: 30 };

describe('Burrow same-asset loop', () => {
  it('leverage follows from the target health factor exactly: HF = L * vr^2 / (L - 1)', () => {
    const r = loopFor(usdt, opts);
    if (!r) throw new Error('no loop');
    const k = 0.95 ** 2;
    expect(r.leverage).toBeCloseTo(1.6 / (1.6 - k), 12);
    expect((r.leverage * k) / (r.leverage - 1)).toBeCloseTo(1.6, 12); // the resulting HF is the target
    expect(r.depositedUsd - r.borrowedUsd).toBeCloseTo(1000, 9); // equity is preserved
  });

  it('net = L x supply - (L-1) x borrow, minus gas for every round in and out', () => {
    const r = loopFor(usdt, opts);
    if (!r) throw new Error('no loop');
    expect(r.netApr).toBeCloseTo(r.leverage * 0.092 - (r.leverage - 1) * 0.143, 12);
    expect(r.gasUsd).toBeCloseTo(2 * (1 + 2 * r.rounds) * 0.05, 12);
    expect(r.netUsd).toBeCloseTo(r.grossUsd - r.borrowCostUsd - r.gasUsd, 9);
    expect(r.breakEvenBorrowApr).toBeCloseTo((r.leverage * 0.092) / (r.leverage - 1), 12);
  });

  it('borrow above HF x supply makes the health factor drift down: the days to 1.0 are reported', () => {
    const r = loopFor(usdt, opts);
    // 0.143 < 1.6 x 0.092 = 0.1472: no drift
    expect(r?.daysToLiquidationFromRates).toBeNull();
    const pricey = loopFor({ ...usdt, borrowApr: '0.25' }, opts);
    expect(pricey?.daysToLiquidationFromRates).toBeCloseTo((0.6 / (0.25 - 1.6 * 0.092)) * 365, 6);
    expect(pricey?.netUsd).toBeLessThan(0);
  });

  it('only markets that allow deposit, collateral and borrow, with valid data', () => {
    expect(loopFor({ ...usdt, canBorrow: false }, opts)).toBeNull();
    expect(loopFor({ ...usdt, canUseAsCollateral: false }, opts)).toBeNull();
    expect(loopFor({ ...usdt, status: 'LOW_CONFIDENCE' }, opts)).toBeNull();
    expect(loopFor({ ...usdt, borrowApr: null }, opts)).toBeNull();
    expect(
      loopStrategies([usdt, { ...usdt, token: 'x', borrowApr: '0.3' }], opts).map((r) => r.token),
    ).toEqual(['usdt.near', 'x']);
  });
});
