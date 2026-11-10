import { describe, expect, it } from 'vitest';
import {
  PreconditionError,
  UnexpectedResponseError,
  type LendingRepayIntent,
  type LendingSupplyIntent,
} from '@near-autopilot/core';
import { ScriptedContractViewer } from '@near-autopilot/core/testing';
import {
  BurrowLendingReader,
  BurrowPlanner,
  BurrowPriceOracle,
  computeRisk,
  OracleMismatchError,
} from '../src';
import {
  aliceAccount,
  ALICE,
  BURROW,
  makeWorld,
  ONE_NEAR_INNER,
  ONE_USDT_INNER,
  ORACLE,
  USDT,
  WNEAR,
} from './support/fixtures';

const options = { contractId: BURROW, oracleId: ORACLE };

describe('BurrowLendingReader', () => {
  it('converts inner units to raw units: holdings round down, debt rounds up', async () => {
    const w = makeWorld();
    w.account = aliceAccount({
      supplied: [
        { token_id: USDT, balance: (5n * ONE_USDT_INNER + 10n ** 11n).toString(), shares: '1' },
      ],
      borrowed: [{ token_id: USDT, balance: (200n * ONE_USDT_INNER + 1n).toString(), shares: '1' }],
    });
    const pos = await new BurrowLendingReader(w.viewer, options).getPosition(ALICE);
    expect(pos.supplied).toEqual([{ token: USDT, raw: 5_000_000n }]);
    expect(pos.collateral).toEqual([{ token: WNEAR, raw: 100n * ONE_NEAR_INNER }]);
    expect(pos.borrowed).toEqual([{ token: USDT, raw: 200_000_001n }]);
  });

  it('treats an unregistered account as an empty position', async () => {
    const w = makeWorld();
    const pos = await new BurrowLendingReader(w.viewer, options).getPosition(ALICE);
    expect(pos).toMatchObject({ protocol: 'burrow', supplied: [], collateral: [], borrowed: [] });
  });

  it('fails closed when a held token is not listed or the response shape changes', async () => {
    const w = makeWorld();
    w.account = aliceAccount();
    delete w.assets[USDT];
    await expect(new BurrowLendingReader(w.viewer, options).getPosition(ALICE)).rejects.toThrow(
      UnexpectedResponseError,
    );
    const shape = new ScriptedContractViewer().on(BURROW, 'get_account', {
      account_id: 'alice.near',
      supplied: 'nope',
    });
    await expect(new BurrowLendingReader(shape, options).getPosition(ALICE)).rejects.toThrow(
      UnexpectedResponseError,
    );
  });

  it('maps the single volatility ratio to both generic factors, de-duplicating lookups', async () => {
    const w = makeWorld();
    const risk = await new BurrowLendingReader(w.viewer, options).getRisk([WNEAR, WNEAR, USDT]);
    expect(risk.get(WNEAR)).toEqual({
      token: WNEAR,
      collateralFactorBps: 6000,
      borrowFactorBps: 6000,
      canBeCollateral: true,
      canBorrow: true,
    });
    expect(w.viewer.calls.filter((c) => c.methodName === 'get_asset')).toHaveLength(2);
  });

  it('end to end: reader inputs + oracle prices reproduce the hand-computed health factor', async () => {
    const w = makeWorld();
    w.account = aliceAccount();
    w.viewer.on(ORACLE, 'get_price_data', {
      timestamp: '1760000000000000000',
      recency_duration_sec: 90,
      prices: [
        { asset_id: WNEAR, price: { multiplier: '50000', decimals: 28 } },
        { asset_id: USDT, price: { multiplier: '10000', decimals: 10 } },
      ],
    });
    const inputs = await new BurrowLendingReader(w.viewer, options).getRiskInputs(ALICE);
    const { prices } = await new BurrowPriceOracle(w.viewer, options).getPrices([WNEAR, USDT]);
    const r = computeRisk(inputs!.position, inputs!.assets, prices);
    expect(r.healthFactorBps).toBe(12_000n);
    expect(r.ltvBps).toBe(4_000n);
    expect(r.liquidationThresholdBps).toBe(4_800n);
  });

  it('getRiskInputs is null for an unregistered account', async () => {
    const w = makeWorld();
    expect(await new BurrowLendingReader(w.viewer, options).getRiskInputs(ALICE)).toBeNull();
  });
});

describe('BurrowPriceOracle', () => {
  const prices = {
    timestamp: '1760000000000000000',
    recency_duration_sec: 90,
    prices: [
      { asset_id: WNEAR, price: { multiplier: '50000', decimals: 28 } },
      { asset_id: USDT, price: null },
    ],
  };

  it('returns prices from the oracle Burrow is configured with and omits unpriced tokens', async () => {
    const w = makeWorld();
    w.viewer.on(ORACLE, 'get_price_data', prices);
    const { prices: map, asOf } = await new BurrowPriceOracle(w.viewer, options).getPrices([
      WNEAR,
      USDT,
    ]);
    expect(map.get(WNEAR)).toEqual({ multiplier: 50_000n, decimals: 28 });
    expect(map.has(USDT)).toBe(false);
    expect(asOf.getTime()).toBe(1_760_000_000_000);
  });

  it('refuses prices when Burrow points at a different oracle, without querying either oracle', async () => {
    const w = makeWorld();
    w.oracleAccountId = 'other-oracle.near';
    w.viewer.on(ORACLE, 'get_price_data', prices);
    await expect(new BurrowPriceOracle(w.viewer, options).getPrices([WNEAR])).rejects.toThrow(
      OracleMismatchError,
    );
    expect(w.viewer.calls.some((c) => c.methodName === 'get_price_data')).toBe(false);
  });
});

describe('BurrowPlanner', () => {
  const repay: LendingRepayIntent = {
    id: 'i1',
    agentId: 'guardian',
    reason: 't',
    kind: 'lending.repay',
    protocol: 'burrow',
    token: USDT,
    amount: 42n,
  };
  const supply: LendingSupplyIntent = {
    id: 'i2',
    agentId: 'guardian',
    reason: 't',
    kind: 'lending.supply',
    protocol: 'burrow',
    token: WNEAR,
    amount: 7n,
    asCollateral: true,
  };
  const planner = (w: ReturnType<typeof makeWorld>) =>
    new BurrowPlanner({ verifier: w.verifier, client: w.client, clock: w.clock });

  it('plans repay only after verification, as ft_transfer_call to the token with an inner-unit cap', async () => {
    const w = makeWorld();
    w.account = aliceAccount();
    const plan = await planner(w).plan(repay, ALICE);
    expect(w.rpc.methods[0]).toBe('status');
    expect(plan.receiverId).toBe(USDT);
    expect(plan.signerId).toBe(ALICE);
    const a = plan.actions[0]!;
    expect(a.args['receiver_id']).toBe(BURROW);
    expect(a.args['amount']).toBe('42');
    expect(JSON.parse(String(a.args['msg']))).toEqual({
      Execute: { actions: [{ Repay: { token_id: USDT, max_amount: '42000000000000' } }] },
    });
  });

  it('plans supply-as-collateral and plain supply', async () => {
    const w = makeWorld();
    w.account = aliceAccount();
    const asCollateral = await planner(w).plan(supply, ALICE);
    expect(JSON.parse(String(asCollateral.actions[0]!.args['msg']))).toEqual({
      Execute: { actions: [{ IncreaseCollateral: { token_id: WNEAR, max_amount: '7' } }] },
    });
    const plain = await planner(w).plan({ ...supply, asCollateral: false }, ALICE);
    expect(plain.actions[0]!.args['msg']).toBe('');
  });

  it('refuses an unregistered signer (ft_on_transfer would panic and bounce)', async () => {
    const w = makeWorld();
    await expect(planner(w).plan(repay, ALICE)).rejects.toThrow(PreconditionError);
  });

  it('refuses to repay a token the signer does not owe', async () => {
    const w = makeWorld();
    w.account = aliceAccount({ borrowed: [] });
    await expect(planner(w).plan(repay, ALICE)).rejects.toThrow('no ' + USDT + ' debt');
  });

  it('builds nothing when the node is on the wrong chain, and reads no account', async () => {
    const w = makeWorld({ chainId: 'localnet' });
    w.account = aliceAccount();
    await expect(planner(w).plan(repay, ALICE)).rejects.toThrow('RPC reports chain');
    expect(w.viewer.calls).toEqual([]);
  });

  it('builds nothing when the token is not listed', async () => {
    const w = makeWorld();
    w.account = aliceAccount();
    delete w.assets[USDT];
    await expect(planner(w).plan(repay, ALICE)).rejects.toThrow('TOKEN_NOT_LISTED');
  });

  it('supports only repay and supply', () => {
    const w = makeWorld();
    const p = planner(w);
    expect(p.supports(repay)).toBe(true);
    expect(p.supports(supply)).toBe(true);
    expect(
      p.supports({
        id: 'x',
        agentId: 'a',
        reason: 'r',
        kind: 'swap',
        protocol: 'rhea',
        tokenIn: WNEAR,
        tokenOut: USDT,
        amountIn: 1n,
        poolId: 1,
        quotedAmountOut: 1n,
        minAmountOut: 1n,
        slippageBps: 0,
      }),
    ).toBe(false);
  });
});
