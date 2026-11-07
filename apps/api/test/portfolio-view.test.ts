import { describe, expect, it } from 'vitest';
import { buildPortfolioView, narrate } from '../src/analytics/portfolio-view';

const hf = (x: number) => (BigInt(Math.round(x * 1e6)) * 10n ** 12n).toString();
const market = (token: string, supply: string, borrow: string, cf: number) => ({
  token,
  status: 'OK',
  supplyApr: supply,
  netSupplyApr: supply,
  borrowApr: borrow,
  collateralFactor: cf,
  canUseAsCollateral: true,
  canBorrow: true,
  canDeposit: true,
  availableUsd: '5000000',
});
const view = (healthFactor: number, nearVr = 0.99) =>
  buildPortfolioView({
    id: 'demo-5000',
    analysis: {
      createdAt: new Date('2026-11-07T12:00:00Z'),
      result: {
        decision: {
          outcome: 'no_action',
          risk: { healthFactorWad: hf(healthFactor) },
          agentNoActions: [],
        },
        strategies: [],
      },
    },
    prices: new Map([
      ['wrap.near', 3],
      ['usdt.tether-token.near', 1],
    ]),
    markets: [
      market('usdt.tether-token.near', '0.09', '0.14', 0.95),
      market('wrap.near', '0.003', '0.025', nearVr),
    ],
    symbols: new Map([['usdt.tether-token.near', 'USDt']]),
  });

describe('portfolio view (demo-5000)', () => {
  it('values the simulated holdings at the given prices', () => {
    const v = view(1.55);
    // wallet 300 NEAR + 600 USDt, collateral 1150 NEAR, supplied 50 USDt, debt 2000 USDt
    expect(v.totals).toMatchObject({
      assetsUsd: 900 + 600 + 3450 + 50,
      debtUsd: 2000,
      idleUsd: 1500,
    });
    expect(v.totals.netWorthUsd).toBe(3000);
    expect(v.simulated).toBe(true);
  });

  it('repaying with idle USDt saves the borrow interest; the autopilot does it only to protect the loan', () => {
    const repay = view(1.55).actions.find((a) => a.id === 'repay');
    expect(repay?.grossUsd).toBeCloseTo(600 * 0.14 * (30 / 365), 9);
    expect(repay?.netUsd).toBeCloseTo(600 * 0.14 * (30 / 365) - 0.05, 9);
    expect(repay?.autopilot.verdict).toBe('not_allowed');
    // HF computed live from the current amounts: 1150 NEAR x $3 x vr / (2000 / 0.95); with vr 0.75 it is 1.23 < 1.5
    expect(view(1.3, 0.75).actions.find((a) => a.id === 'repay')?.autopilot.verdict).toBe(
      'worth_it',
    );
  });

  it('lending is costed on the exact idle amount of each token, and a loop is never presented as something the autopilot does', () => {
    const v = view(1.55);
    expect(v.actions.find((a) => a.id === 'lend-usdt')?.capitalUsd).toBe(600);
    expect(v.actions.find((a) => a.id === 'lend-near')?.capitalUsd).toBe(900);
    for (const loop of v.actions.filter((a) => a.kind === 'loop'))
      expect(loop.autopilot.verdict).toBe('not_allowed');
    // a loop is listed only when it earns after every cost
    for (const loop of v.actions.filter((a) => a.kind === 'loop'))
      expect(loop.netUsd ?? -1).toBeGreaterThan(0);
    // ordered by the result after costs
    const nets = v.actions.map((a) => a.netUsd ?? -Infinity);
    expect([...nets].sort((a, b) => b - a)).toEqual(nets);
  });

  it('narrates rejections in plain words, never as codes', () => {
    const n = narrate(
      {
        decision: {
          outcome: 'no_action',
          rejected: [
            { agent: 'capital-allocator', kind: 'allocation.swap', code: 'NO_QUOTE', detail: 'x' },
          ],
          agentNoActions: [{ agent: 'liquidation-guardian', reasonCode: 'healthy' }],
          risk: { healthFactorWad: hf(1.6) },
        },
      },
      new Map(),
    );
    expect(n.headline).toBe('No action: nothing worth doing');
    expect(n.notes.join(' ')).not.toMatch(/NO_QUOTE|healthy\b(?! )/);
    expect(n.notes).toContain(
      'Loan guardian: health factor 1.60 is above the 1.5 safety line, so no repayment is needed.',
    );
  });
});
