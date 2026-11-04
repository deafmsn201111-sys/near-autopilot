import { describe, expect, it } from 'vitest';
import {
  accountId,
  PreconditionError,
  type SwapIntent,
  type TokenReader,
} from '@near-autopilot/core';
import { ScriptedContractViewer } from '@near-autopilot/core/testing';
import { RheaPlanner, RheaSwapQuoter, StaticPoolRegistry } from '../src';

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
