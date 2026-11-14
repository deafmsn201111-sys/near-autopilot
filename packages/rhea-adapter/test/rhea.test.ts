import { describe, expect, it } from 'vitest';
import {
  accountId,
  PreconditionError,
  type SwapIntent,
  type TokenReader,
} from '@near-autopilot/core';
import { ScriptedContractViewer } from '@near-autopilot/core/testing';
import {
  buildExchangeDeposit,
  buildExchangeStorageDeposit,
  buildRheaSwap,
  buildV1AddLiquidity,
  RHEA_V1_LP_STORAGE_DEPOSIT,
  RheaPlanner,
  RheaSwapQuoter,
  StaticPoolRegistry,
} from '../src';

const REF = accountId('v2.ref-finance.near');
const WNEAR = accountId('wrap.near');
const USDT = accountId('usdt.tether-token.near');
const ALICE = accountId('alice.near');

describe('RheaSwapQuoter', () => {
  const pools = new StaticPoolRegistry([
    { poolId: 10, tokenA: WNEAR, tokenB: USDT },
    { poolId: 11, tokenA: USDT, tokenB: WNEAR },
    { poolId: 99, tokenA: WNEAR, tokenB: accountId('other.near') },
  ]);

  it('queries only configured pools for the pair and picks the best return', async () => {
    const viewer = new ScriptedContractViewer().onCall(REF, 'get_return', (args) =>
      args['pool_id'] === 10 ? '4900000' : '5050000',
    );
    const quote = await new RheaSwapQuoter(viewer, { contractId: REF, pools }).quote({
      tokenIn: WNEAR,
      tokenOut: USDT,
      amountIn: 10n ** 24n,
    });
    expect(quote).toEqual({
      protocol: 'rhea',
      poolId: 11,
      amountIn: 10n ** 24n,
      amountOut: 5_050_000n,
    });
    expect(viewer.calls.map((c) => c.args['pool_id'])).toEqual([10, 11]);
    expect(viewer.calls[0]?.args).toMatchObject({
      token_in: WNEAR,
      token_out: USDT,
      amount_in: (10n ** 24n).toString(),
    });
  });

  it('returns null when no pool is configured or all return zero', async () => {
    const viewer = new ScriptedContractViewer().on(REF, 'get_return', '0');
    const quoter = new RheaSwapQuoter(viewer, { contractId: REF, pools });
    expect(await quoter.quote({ tokenIn: WNEAR, tokenOut: USDT, amountIn: 1n })).toBeNull();
    expect(
      await quoter.quote({ tokenIn: USDT, tokenOut: accountId('x.near'), amountIn: 1n }),
    ).toBeNull();
  });

  it('fails loudly on a response shape it does not understand', async () => {
    const viewer = new ScriptedContractViewer().on(REF, 'get_return', { amount: 5 });
    await expect(
      new RheaSwapQuoter(viewer, { contractId: REF, pools }).quote({
        tokenIn: WNEAR,
        tokenOut: USDT,
        amountIn: 1n,
      }),
    ).rejects.toThrow('expected U128 string');
  });
});

describe('RheaPlanner', () => {
  const intent: SwapIntent = {
    id: 'i1',
    agentId: 'rebalancer',
    reason: 'test',
    kind: 'swap',
    protocol: 'rhea',
    tokenIn: WNEAR,
    tokenOut: USDT,
    amountIn: 1_000n,
    poolId: 10,
    quotedAmountOut: 500n,
    minAmountOut: 495n,
    slippageBps: 100,
  };
  const tokens = (registered: boolean): TokenReader => ({
    getBalance: async () => 0n,
    getMetadata: async () => ({ id: USDT, symbol: 'USDt', decimals: 6 }),
    isStorageRegistered: async () => registered,
  });

  it('builds ft_transfer_call on the input token addressed to the exchange', async () => {
    const plan = await new RheaPlanner(tokens(true), { contractId: REF }).plan(intent, ALICE);
    expect(plan.receiverId).toBe(WNEAR);
    expect(plan.signerId).toBe(ALICE);
    const action = plan.actions[0];
    expect(action?.methodName).toBe('ft_transfer_call');
    expect(action?.deposit).toBe(1n);
    expect(action?.args['receiver_id']).toBe(REF);
    expect(action?.args['amount']).toBe('1000');
    expect(JSON.parse(String(action?.args['msg']))).toEqual({
      force: 0,
      actions: [
        { pool_id: 10, token_in: WNEAR, token_out: USDT, amount_in: '1000', min_amount_out: '495' },
      ],
    });
  });

  it('refuses to plan when the output token cannot be received', async () => {
    await expect(
      new RheaPlanner(tokens(false), { contractId: REF }).plan(intent, ALICE),
    ).rejects.toThrow(PreconditionError);
  });
});

describe('v1 liquidity builders', () => {
  const EXCHANGE = accountId('v2.ref-finance.near');

  it('buildRheaSwap: one pool, the min-out in the message, 1 yocto, refuses a zero amount', () => {
    const tx = buildRheaSwap({
      contractId: EXCHANGE,
      poolId: 4512,
      tokenIn: WNEAR,
      tokenOut: USDT,
      amountIn: 5_000n,
      minAmountOut: 4_900n,
    });
    expect(tx.receiverId).toBe(WNEAR);
    expect(tx.actions[0]).toMatchObject({
      methodName: 'ft_transfer_call',
      deposit: 1n,
      gas: 180_000_000_000_000n,
      args: { receiver_id: EXCHANGE, amount: '5000' },
    });
    expect(JSON.parse(String(tx.actions[0].args['msg']))).toEqual({
      force: 0,
      actions: [
        {
          pool_id: 4512,
          token_in: WNEAR,
          token_out: USDT,
          amount_in: '5000',
          min_amount_out: '4900',
        },
      ],
    });
    expect(() =>
      buildRheaSwap({
        contractId: EXCHANGE,
        poolId: 1,
        tokenIn: WNEAR,
        tokenOut: USDT,
        amountIn: 0n,
        minAmountOut: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('buildExchangeStorageDeposit registers the signer with the exact on-chain min', () => {
    const step = buildExchangeStorageDeposit({
      contractId: EXCHANGE,
      accountId: ALICE,
      deposit: 1_020_000_000_000_000_000_000n,
    });
    expect(step.receiverId).toBe(EXCHANGE);
    expect(step.actions).toHaveLength(1);
    const a = step.actions[0];
    expect(a?.methodName).toBe('storage_deposit');
    expect(a?.args).toEqual({ account_id: ALICE, registration_only: true });
    expect(a?.deposit).toBe(1_020_000_000_000_000_000_000n);
  });

  it('buildExchangeStorageDeposit rejects a non-positive deposit', () => {
    expect(() =>
      buildExchangeStorageDeposit({ contractId: EXCHANGE, accountId: ALICE, deposit: 0n }),
    ).toThrow(RangeError);
  });

  it('buildExchangeDeposit credits the exchange deposit balance with empty msg', () => {
    const step = buildExchangeDeposit({ tokenId: WNEAR, contractId: EXCHANGE, rawAmount: 1_000n });
    expect(step.receiverId).toBe(WNEAR);
    const a = step.actions[0];
    expect(a?.methodName).toBe('ft_transfer_call');
    expect(a?.args).toEqual({ receiver_id: EXCHANGE, amount: '1000', msg: '' });
    expect(a?.deposit).toBe(1n);
  });

  it('buildExchangeDeposit rejects a non-positive amount', () => {
    expect(() =>
      buildExchangeDeposit({ tokenId: WNEAR, contractId: EXCHANGE, rawAmount: 0n }),
    ).toThrow(RangeError);
  });

  it('buildV1AddLiquidity serialises amounts in pool order with a refundable storage buffer', () => {
    const step = buildV1AddLiquidity({
      contractId: EXCHANGE,
      poolId: 3879,
      amounts: [100n, 200n],
    });
    expect(step.receiverId).toBe(EXCHANGE);
    const a = step.actions[0];
    expect(a?.methodName).toBe('add_liquidity');
    expect(a?.args).toEqual({ pool_id: 3879, amounts: ['100', '200'] });
    expect(a?.deposit).toBe(RHEA_V1_LP_STORAGE_DEPOSIT);
  });

  it('buildV1AddLiquidity includes min_amounts when provided', () => {
    const step = buildV1AddLiquidity({
      contractId: EXCHANGE,
      poolId: 3879,
      amounts: [100n, 200n],
      minAmounts: [95n, 190n],
    });
    expect(step.actions[0]?.args).toEqual({
      pool_id: 3879,
      amounts: ['100', '200'],
      min_amounts: ['95', '190'],
    });
  });

  it('buildV1AddLiquidity rejects min_amounts above amounts', () => {
    expect(() =>
      buildV1AddLiquidity({
        contractId: EXCHANGE,
        poolId: 3879,
        amounts: [100n, 200n],
        minAmounts: [101n, 190n],
      }),
    ).toThrow(RangeError);
  });

  it('buildV1AddLiquidity rejects a non-positive amount', () => {
    expect(() =>
      buildV1AddLiquidity({ contractId: EXCHANGE, poolId: 3879, amounts: [0n, 200n] }),
    ).toThrow(RangeError);
  });
});
