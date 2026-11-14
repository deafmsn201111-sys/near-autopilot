import { describe, expect, it } from 'vitest';
import { orderInfoSchema } from '@near-autopilot/rhea-dcl-adapter';
import { accountPortfolio, limitOrderView, readLimitOrders } from '../src/analytics/account-view';

describe('readLimitOrders (#222)', () => {
  it('drops an order whose pool id it cannot read instead of failing the whole portfolio', async () => {
    const good = orderInfoSchema.parse({
      order_id: '7',
      owner_id: 'alice.near',
      pool_id: 'imeme-2.v2-launchpad.justhoot.near|wrap.near|10000',
      point: 0,
      sell_token: 'imeme-2.v2-launchpad.justhoot.near',
      buy_token: 'wrap.near',
      created_at: '0',
      original_amount: '1',
      remain_amount: '1',
      cancel_amount: '0',
      bought_amount: '0',
    });
    const dcl = {
      listActiveOrders: async () => [good, { ...good, order_id: '8', pool_id: 'not-a-pool' }],
    } as never;
    const out = await readLimitOrders(
      dcl,
      'alice.near' as never,
      async () => ({
        symbol: 'T',
        decimals: 18,
      }),
      new Map(),
    );
    expect(out.map((o) => o.orderId)).toEqual(['7']);
  });
});

const MEME = 'imeme-2.v2-launchpad.justhoot.near';
const POOL = `${MEME}|wrap.near|10000`;
const raw = {
  order_id: '7',
  owner_id: 'alice.near',
  pool_id: POOL,
  point: 0,
  sell_token: MEME,
  buy_token: 'wrap.near',
  created_at: '0',
  original_amount: (2000n * 10n ** 18n).toString(),
  remain_amount: (1000n * 10n ** 18n).toString(),
  cancel_amount: '0',
  bought_amount: '0',
  unclaimed_amount: (5n * 10n ** 23n).toString(),
};
const order = orderInfoSchema.parse(raw);
const meta = new Map([
  [MEME, { symbol: 'IMEME', decimals: 18 }],
  ['wrap.near', { symbol: 'wNEAR', decimals: 24 }],
]);

describe('limitOrderView (#222)', () => {
  it('values what is still on the order and what it bought but did not claim, with its price', () => {
    const v = limitOrderView(
      order,
      (t) => meta.get(t),
      new Map([
        [MEME, 0.0004],
        ['wrap.near', 2],
      ]),
    );
    expect(v).toMatchObject({
      orderId: '7',
      sellSymbol: 'IMEME',
      buySymbol: 'wNEAR',
      remaining: 1000,
      unclaimed: 0.5,
      usdSell: 0.4,
      usdBuy: 1,
    });
    // point 0 is a raw price of 1; X = IMEME (18), Y = wNEAR (24): 1e-6 wNEAR per IMEME
    expect(v?.price).toBeCloseTo(1e-6);
  });

  it('turns the price around when the order sells the pool Y token', () => {
    const v = limitOrderView(
      orderInfoSchema.parse({
        ...raw,
        sell_token: 'wrap.near',
        buy_token: MEME,
        remain_amount: (10n ** 24n).toString(),
      }),
      (t) => meta.get(t),
      new Map(),
    );
    expect(v?.price).toBeCloseTo(1e6);
    expect(v?.usdSell).toBeNull();
  });

  it('skips an order with unknown token decimals', () => {
    expect(limitOrderView(order, () => undefined, new Map())).toBeNull();
  });
});

describe('accountPortfolio with limit orders (#222)', () => {
  it('lists each order as a holding and counts it in net worth', () => {
    const view = limitOrderView(
      order,
      (t) => meta.get(t),
      new Map([
        [MEME, 0.0004],
        ['wrap.near', 2],
      ]),
    )!;
    const p = accountPortfolio({
      holdings: [],
      staking: [],
      dclPositions: [],
      v1Positions: [],
      limitOrders: [view],
    });
    expect(p.positions).toEqual([
      expect.objectContaining({
        key: 'order-7',
        label: 'IMEME → wNEAR',
        sub: 'Rhea limit order · 1,000 IMEME waiting to fill at 0.000001 wNEAR each',
        amount: null,
        usd: 1.4,
      }),
    ]);
    expect(p.totals.netWorthUsd).toBeCloseTo(1.4);
    expect(p.metrics.byToken).toEqual([]);
    expect(p.metrics.concentration).toBeNull();
  });

  it('says a filled order waits to be claimed', () => {
    const filled = limitOrderView(
      orderInfoSchema.parse({ ...raw, remain_amount: '0' }),
      (t) => meta.get(t),
      new Map(),
    )!;
    const p = accountPortfolio({
      holdings: [],
      staking: [],
      dclPositions: [],
      v1Positions: [],
      limitOrders: [filled],
    });
    expect(p.positions[0]?.sub).toBe('Rhea limit order · filled: 0.5 wNEAR to claim in Rhea');
  });
});
