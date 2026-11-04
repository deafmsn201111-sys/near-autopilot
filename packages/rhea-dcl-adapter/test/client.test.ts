import { accountId, UnexpectedResponseError } from '@near-autopilot/core';
import { ScriptedContractViewer } from '@near-autopilot/core/testing';
import { describe, expect, it } from 'vitest';
import {
  DCL_CONTRACT_IDS,
  RheaDclClient,
  canonicalPoolId,
  normalisePoolId,
  parsePoolId,
} from '../src';
import { orderFixture, POOL_ID, poolFixture, positionFixture } from './fixtures/shapes';

const DCL = DCL_CONTRACT_IDS.testnet;
const ALICE = accountId('alice.testnet');

function client(viewer: ScriptedContractViewer) {
  return new RheaDclClient(viewer, { contractId: DCL });
}

describe('pool ids', () => {
  it('sorts tokens and validates the fee tier (ref-sdk getDCLPoolId)', () => {
    expect(canonicalPoolId('wrap.testnet', 'usdc.fakes.testnet', 2000)).toBe(POOL_ID);
    expect(normalisePoolId('wrap.testnet|usdc.fakes.testnet|2000')).toBe(POOL_ID);
    expect(() => canonicalPoolId('a.testnet', 'b.testnet', 123)).toThrow(RangeError);
    expect(() => canonicalPoolId('a.testnet', 'a.testnet', 100)).toThrow(RangeError);
    expect(() => parsePoolId('only|two')).toThrow(RangeError);
  });

  it('pins the testnet contract ids found in ref-sdk/ref-ui', () => {
    expect(DCL_CONTRACT_IDS.testnet).toBe('dclv2.ref-dev.testnet');
    expect(DCL_CONTRACT_IDS['testnet-dev']).toBe('refv2-dev.ref-dev.testnet');
    expect(DCL_CONTRACT_IDS.mainnet).toBe('dclv2.ref-labs.near');
  });
});

describe('RheaDclClient views (argument names are asserted exactly)', () => {
  it('get_pool sends a canonical pool_id and parses u128 fields to bigint', async () => {
    const viewer = new ScriptedContractViewer().on(DCL, 'get_pool', poolFixture);
    const pool = await client(viewer).getPool('wrap.testnet|usdc.fakes.testnet|2000');
    expect(viewer.calls).toEqual([
      { contractId: DCL, methodName: 'get_pool', args: { pool_id: POOL_ID } },
    ]);
    expect(pool?.current_point).toBe(288000);
    expect(pool?.liquidity).toBe(5842542192n);
    expect(pool?.point_delta).toBe(40);
  });

  it('returns null for an unknown pool and preserves unknown extra fields', async () => {
    expect(
      await client(new ScriptedContractViewer().on(DCL, 'get_pool', null)).getPool(POOL_ID),
    ).toBeNull();
    const withExtra = await client(
      new ScriptedContractViewer().on(DCL, 'get_pool', { ...poolFixture, brand_new_field: 'x' }),
    ).getPool(POOL_ID);
    expect(withExtra).toHaveProperty('brand_new_field', 'x');
  });

  it('fails closed on a malformed pool (fee as string, missing point_delta)', async () => {
    await expect(
      client(
        new ScriptedContractViewer().on(DCL, 'get_pool', { ...poolFixture, fee: '2000' }),
      ).getPool(POOL_ID),
    ).rejects.toThrow(UnexpectedResponseError);
    const { point_delta: _omit, ...broken } = poolFixture;
    await expect(
      client(new ScriptedContractViewer().on(DCL, 'get_pool', broken)).getPool(POOL_ID),
    ).rejects.toThrow(UnexpectedResponseError);
  });

  it('rejects non-integer-string liquidity instead of coercing', async () => {
    const viewer = new ScriptedContractViewer().on(DCL, 'get_pool', {
      ...poolFixture,
      liquidity: '12.5',
    });
    await expect(client(viewer).getPool(POOL_ID)).rejects.toThrow(UnexpectedResponseError);
  });

  it('list_pools takes no arguments', async () => {
    const viewer = new ScriptedContractViewer().on(DCL, 'list_pools', [poolFixture]);
    const pools = await client(viewer).listPools();
    expect(pools).toHaveLength(1);
    expect(viewer.calls[0]?.args).toEqual({});
  });

  it('get_liquidity uses lpt_id; list_liquidities uses account_id', async () => {
    const viewer = new ScriptedContractViewer()
      .on(DCL, 'get_liquidity', positionFixture)
      .on(DCL, 'list_liquidities', [positionFixture]);
    const c = client(viewer);
    const one = await c.getPosition(positionFixture.lpt_id);
    const all = await c.listPositions(ALICE);
    expect(viewer.calls.map((x) => [x.methodName, x.args])).toEqual([
      ['get_liquidity', { lpt_id: positionFixture.lpt_id }],
      ['list_liquidities', { account_id: 'alice.testnet' }],
    ]);
    expect(one?.amount).toBe(5842542192n);
    expect(all[0]?.left_point).toBe(288680);
  });

  it('list_user_assets returns a bigint map and tolerates null', async () => {
    const assets = await client(
      new ScriptedContractViewer().on(DCL, 'list_user_assets', {
        'wrap.testnet': '5',
        'usdc.fakes.testnet': '7',
      }),
    ).listInternalBalances(ALICE);
    expect(assets.get('wrap.testnet')).toBe(5n);
    expect(
      (
        await client(
          new ScriptedContractViewer().on(DCL, 'list_user_assets', null),
        ).listInternalBalances(ALICE)
      ).size,
    ).toBe(0);
  });

  it('get_marketdepth sends pool_id and depth (default 100) and parses both maps', async () => {
    const viewer = new ScriptedContractViewer().on(DCL, 'get_marketdepth', {
      liquidities: { '0': { left_point: 288680, right_point: 289000, amount_l: '5842542192' } },
      orders: { '0': { point: 288000, amount_x: '1', amount_y: '2' } },
    });
    const depth = await client(viewer).getMarketDepth(POOL_ID);
    expect(viewer.calls[0]?.args).toEqual({ pool_id: POOL_ID, depth: 100 });
    expect(depth.liquidities['0']?.amount_l).toBe(5842542192n);
    expect(depth.orders['0']?.amount_y).toBe(2n);
    await expect(client(viewer).getMarketDepth(POOL_ID, 0)).rejects.toThrow(RangeError);
  });

  it('quote / quote_by_output send raw-unit strings and canonical pool ids', async () => {
    const viewer = new ScriptedContractViewer()
      .on(DCL, 'quote', { amount: '990', tag: 't1' })
      .on(DCL, 'quote_by_output', { amount: '1010', tag: null });
    const c = client(viewer);
    const wrap = accountId('wrap.testnet');
    const usdc = accountId('usdc.fakes.testnet');
    const q = await c.quote({
      poolIds: ['wrap.testnet|usdc.fakes.testnet|2000'],
      inputToken: wrap,
      outputToken: usdc,
      inputAmount: 1000n,
      tag: 't1',
    });
    const qo = await c.quoteByOutput({
      poolIds: [POOL_ID],
      inputToken: wrap,
      outputToken: usdc,
      outputAmount: 1000n,
    });
    expect(q.amount).toBe(990n);
    expect(qo.amount).toBe(1010n);
    expect(viewer.calls[0]?.args).toEqual({
      pool_ids: [POOL_ID],
      input_token: 'wrap.testnet',
      output_token: 'usdc.fakes.testnet',
      input_amount: '1000',
      tag: 't1',
    });
    expect(viewer.calls[1]?.args).toEqual({
      pool_ids: [POOL_ID],
      input_token: 'wrap.testnet',
      output_token: 'usdc.fakes.testnet',
      output_amount: '1000',
    });
    await expect(
      c.quote({ poolIds: [], inputToken: wrap, outputToken: usdc, inputAmount: 1n }),
    ).rejects.toThrow(RangeError);
    await expect(
      c.quote({ poolIds: [POOL_ID], inputToken: wrap, outputToken: usdc, inputAmount: 0n }),
    ).rejects.toThrow(RangeError);
  });

  it('order views use order_id / account_id / pool_id+point', async () => {
    const viewer = new ScriptedContractViewer()
      .on(DCL, 'get_order', orderFixture)
      .on(DCL, 'find_order', orderFixture)
      .on(DCL, 'list_active_orders', [orderFixture])
      .on(DCL, 'list_history_orders', []);
    const c = client(viewer);
    const order = await c.getOrder(orderFixture.order_id);
    await c.findOrder({ accountId: ALICE, poolId: POOL_ID, point: 288000 });
    await c.listActiveOrders(ALICE);
    await c.listHistoryOrders(ALICE);
    expect(order?.remain_amount).toBe(1000n);
    expect(order?.unclaimed_amount).toBeNull();
    expect(viewer.calls.map((x) => [x.methodName, x.args])).toEqual([
      ['get_order', { order_id: orderFixture.order_id }],
      ['find_order', { account_id: 'alice.testnet', pool_id: POOL_ID, point: 288000 }],
      ['list_active_orders', { account_id: 'alice.testnet' }],
      ['list_history_orders', { account_id: 'alice.testnet' }],
    ]);
  });

  it('get_user_storage_detail uses user_id; null means unregistered', async () => {
    const detail = {
      max_slots: 128,
      cur_order_slots: 0,
      cur_liquidity_slots: 1,
      locked_near: '500000000000000000000000',
      storage_for_asset: '0',
      slot_price: '100000000000000000000000',
      sponsor_id: 'alice.testnet',
    };
    const viewer = new ScriptedContractViewer().on(DCL, 'get_user_storage_detail', detail);
    const parsed = await client(viewer).getUserStorageDetail(ALICE);
    expect(viewer.calls[0]?.args).toEqual({ user_id: 'alice.testnet' });
    expect(parsed?.slot_price).toBe(100000000000000000000000n);
    expect(
      await client(
        new ScriptedContractViewer().on(DCL, 'get_user_storage_detail', null),
      ).getUserStorageDetail(ALICE),
    ).toBeNull();
  });

  it('storage_balance_of returns bigint totals or null', async () => {
    const viewer = new ScriptedContractViewer().on(DCL, 'storage_balance_of', {
      total: '10',
      available: '4',
    });
    expect(await client(viewer).getStorageBalance(ALICE)).toEqual({ total: 10n, available: 4n });
    expect(viewer.calls[0]?.args).toEqual({ account_id: 'alice.testnet' });
  });
});
