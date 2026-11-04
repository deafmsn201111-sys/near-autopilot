import { accountId } from '@near-autopilot/core';
import { describe, expect, it } from 'vitest';
import {
  DCL_CONTRACT_IDS,
  DCL_DEPOSITS,
  buildAddLiquidity,
  buildAppendLiquidity,
  buildCancelOrder,
  buildClaimOrder,
  buildCreatePool,
  buildDclStorageDeposit,
  buildDeposit,
  buildLimitOrder,
  buildRemoveLiquidity,
  buildSwapExactIn,
  buildSwapExactOut,
  buildSwapToStopPoint,
  buildWithdrawAssets,
  orientLimitOrderPoint,
} from '../src';
import { POOL_ID } from './fixtures/shapes';

const dcl = DCL_CONTRACT_IDS.testnet;
const usdc = accountId('usdc.fakes.testnet');
const wrap = accountId('wrap.testnet');

describe('swap messages (shape per ref-sdk dcl-swap/swap.ts)', () => {
  it('Swap is an ft_transfer_call on the input token with 1 yoctoNEAR and 180 Tgas', () => {
    const tx = buildSwapExactIn({
      dcl,
      tokenIn: usdc,
      tokenOut: wrap,
      amountIn: 1_000_000n,
      minAmountOut: 0n,
      poolIds: [POOL_ID],
    });
    expect(tx.receiverId).toBe(usdc);
    const action = tx.actions[0];
    expect(action).toMatchObject({
      type: 'FunctionCall',
      methodName: 'ft_transfer_call',
      gas: 180_000_000_000_000n,
      deposit: 1n,
    });
    expect(action?.args).toEqual({
      receiver_id: dcl,
      amount: '1000000',
      msg: '{"Swap":{"pool_ids":["usdc.fakes.testnet|wrap.testnet|2000"],"output_token":"wrap.testnet","min_output_amount":"0","referral_id":"","client_id":""}}',
    });
  });

  it('SwapByOutput carries output_amount and transfers amountInMax', () => {
    const tx = buildSwapExactOut({
      dcl,
      tokenIn: usdc,
      tokenOut: wrap,
      amountInMax: 5n,
      amountOut: 9n,
      poolIds: [POOL_ID],
    });
    expect(tx.actions[0]?.args['amount']).toBe('5');
    expect(JSON.parse(String(tx.actions[0]?.args['msg']))).toEqual({
      SwapByOutput: {
        pool_ids: [POOL_ID],
        output_token: wrap,
        output_amount: '9',
        referral_id: '',
        client_id: '',
      },
    });
  });

  it('LimitOrderWithSwap and SwapByStopPoint messages', () => {
    const limit = buildLimitOrder({
      dcl,
      sellToken: wrap,
      buyToken: usdc,
      amount: 7n,
      poolId: POOL_ID,
      point: -288000,
    });
    expect(limit.receiverId).toBe(wrap);
    expect(JSON.parse(String(limit.actions[0]?.args['msg']))).toEqual({
      LimitOrderWithSwap: {
        pool_id: POOL_ID,
        buy_token: usdc,
        point: -288000,
        client_id: '',
        referral_id: '',
      },
    });
    const stop = buildSwapToStopPoint({
      dcl,
      tokenIn: usdc,
      amountIn: 3n,
      poolId: POOL_ID,
      stopPoint: 288040,
    });
    expect(JSON.parse(String(stop.actions[0]?.args['msg']))).toEqual({
      SwapByStopPoint: { pool_id: POOL_ID, stop_point: 288040, referral_id: '' },
    });
  });

  it('orients a limit-order point by the sold token like ref-sdk', () => {
    expect(orientLimitOrderPoint(POOL_ID, usdc, 100)).toBe(100);
    expect(orientLimitOrderPoint(POOL_ID, wrap, 100)).toBe(-100);
    expect(() => orientLimitOrderPoint(POOL_ID, accountId('other.testnet'), 1)).toThrow(RangeError);
  });

  it('rejects nonsense before it can reach a signer', () => {
    expect(() =>
      buildSwapExactIn({
        dcl,
        tokenIn: usdc,
        tokenOut: wrap,
        amountIn: 0n,
        minAmountOut: 0n,
        poolIds: [POOL_ID],
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildSwapExactIn({
        dcl,
        tokenIn: usdc,
        tokenOut: wrap,
        amountIn: 1n,
        minAmountOut: -1n,
        poolIds: [POOL_ID],
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildSwapExactIn({
        dcl,
        tokenIn: usdc,
        tokenOut: wrap,
        amountIn: 1n,
        minAmountOut: 0n,
        poolIds: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildLimitOrder({
        dcl,
        sellToken: usdc,
        buyToken: accountId('other.testnet'),
        amount: 1n,
        poolId: POOL_ID,
        point: 0,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildLimitOrder({
        dcl,
        sellToken: usdc,
        buyToken: wrap,
        amount: 1n,
        poolId: POOL_ID,
        point: 900_000,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildSwapToStopPoint({
        dcl,
        tokenIn: accountId('other.testnet'),
        amountIn: 1n,
        poolId: POOL_ID,
        stopPoint: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe('liquidity messages (shape per ref-ui services/swapV3.ts)', () => {
  it('deposit uses the JSON-string message "Deposit"', () => {
    const tx = buildDeposit({ dcl, token: usdc, amount: 10n });
    expect(tx.receiverId).toBe(usdc);
    expect(tx.actions[0]?.args).toEqual({ receiver_id: dcl, amount: '10', msg: '"Deposit"' });
    expect(tx.actions[0]?.deposit).toBe(1n);
  });

  it('add_liquidity args and 150 Tgas, no deposit', () => {
    const tx = buildAddLiquidity({
      dcl,
      poolId: POOL_ID,
      leftPoint: 288680,
      rightPoint: 289000,
      pointDelta: 40,
      amountX: 1_000_000n,
      amountY: 0n,
    });
    expect(tx.receiverId).toBe(dcl);
    expect(tx.actions[0]).toMatchObject({
      methodName: 'add_liquidity',
      gas: 150_000_000_000_000n,
      deposit: 0n,
    });
    expect(tx.actions[0]?.args).toEqual({
      pool_id: POOL_ID,
      left_point: 288680,
      right_point: 289000,
      amount_x: '1000000',
      amount_y: '0',
      min_amount_x: '0',
      min_amount_y: '0',
    });
  });

  it('add_liquidity refuses misaligned ranges and empty amounts', () => {
    expect(() =>
      buildAddLiquidity({
        dcl,
        poolId: POOL_ID,
        leftPoint: 288681,
        rightPoint: 289000,
        pointDelta: 40,
        amountX: 1n,
        amountY: 0n,
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildAddLiquidity({
        dcl,
        poolId: POOL_ID,
        leftPoint: 288680,
        rightPoint: 289000,
        pointDelta: 40,
        amountX: 0n,
        amountY: 0n,
      }),
    ).toThrow(RangeError);
  });

  it('append / remove / withdraw / cancel / claim', () => {
    expect(
      buildAppendLiquidity({ dcl, lptId: 'p#1', amountX: 1n, amountY: 2n }).actions[0]?.args,
    ).toEqual({
      lpt_id: 'p#1',
      amount_x: '1',
      amount_y: '2',
      min_amount_x: '0',
      min_amount_y: '0',
    });
    expect(
      buildRemoveLiquidity({ dcl, lptId: 'p#1', liquidity: 99n, minAmountX: 1n, minAmountY: 2n })
        .actions[0]?.args,
    ).toEqual({
      lpt_id: 'p#1',
      amount: '99',
      min_amount_x: '1',
      min_amount_y: '2',
    });
    const withdraw = buildWithdrawAssets({ dcl, tokenIds: [usdc, wrap] });
    expect(withdraw.actions.map((a) => [a.methodName, a.args])).toEqual([
      ['withdraw_asset', { token_id: usdc }],
      ['withdraw_asset', { token_id: wrap }],
    ]);
    expect(buildCancelOrder({ dcl, orderId: 'o#1', amount: 5n }).actions[0]?.args).toEqual({
      order_id: 'o#1',
      amount: '5',
    });
    expect(buildClaimOrder({ dcl, orderId: 'o#1' }).actions[0]?.args).toEqual({
      order_id: 'o#1',
      amount: '0',
    });
    expect(() =>
      buildRemoveLiquidity({ dcl, lptId: 'p#1', liquidity: 0n, minAmountX: 0n, minAmountY: 0n }),
    ).toThrow(RangeError);
    expect(() => buildWithdrawAssets({ dcl, tokenIds: [] })).toThrow(RangeError);
  });

  it('create_pool attaches 0.1 NEAR; storage_deposit attaches 0.5 NEAR by default', () => {
    const create = buildCreatePool({
      dcl,
      tokenA: wrap,
      tokenB: usdc,
      fee: 2000,
      initPoint: 288000,
    });
    expect(create.actions[0]).toMatchObject({ methodName: 'create_pool', deposit: 10n ** 23n });
    expect(create.actions[0]?.args).toEqual({
      token_a: wrap,
      token_b: usdc,
      fee: 2000,
      init_point: 288000,
    });
    expect(() =>
      buildCreatePool({ dcl, tokenA: wrap, tokenB: usdc, fee: 7, initPoint: 0 }),
    ).toThrow(RangeError);
    const storage = buildDclStorageDeposit({ dcl, accountId: accountId('alice.testnet') });
    expect(storage.actions[0]).toMatchObject({
      methodName: 'storage_deposit',
      deposit: DCL_DEPOSITS.firstRegistration,
    });
    expect(storage.actions[0]?.args).toEqual({
      registration_only: true,
      account_id: 'alice.testnet',
    });
    expect(DCL_DEPOSITS.firstRegistration).toBe(5n * 10n ** 23n);
  });
});
