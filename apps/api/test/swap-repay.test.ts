import { describe, expect, it } from 'vitest';
import type { AccountId } from '@near-autopilot/core';
import { SWAP_REPAY_FLOOR_HF } from '@near-autopilot/core';
import { assembleCascade } from '../src/wallet/cascade';
import { prepareSwapRepay, type SwapRepayPrepareInput } from '../src/wallet/swap-repay';
import { validateCascade } from '../src/wallet/validate-cascade';

const ACCOUNT = 'alice.near' as AccountId;
const WNEAR = 'wrap.near';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const RHEA = 'v2.ref-finance.near';
const BURROW = 'contract.main.burrow.near';
const W = 10n ** 24n; // one wNEAR
const U = 10n ** 6n; // one USDC

// 200 wNEAR collateral at $3 (vr 0.6), 250 USDC debt (vr 0.95): HF 1.368.
const base: SwapRepayPrepareInput = {
  account: ACCOUNT,
  rheaId: RHEA,
  requested: { swapInRaw: 20n * W, withdrawRaw: 20n * W },
  collateral: {
    token: WNEAR,
    symbol: 'wNEAR',
    decimals: 24,
    usdPerToken: 3,
    vr: 0.6,
    walletRaw: 0n,
    suppliedRaw: 0n,
    collateralRaw: 200n * W,
    storageMin: null,
  },
  debt: {
    token: USDC,
    symbol: 'USDC',
    decimals: 6,
    usdPerToken: 1,
    vr: 0.95,
    walletRaw: 0n,
    debtRaw: 250n * U,
    storageMin: null,
  },
  model: { collateralAdjUsd: 360, debtAdjUsd: 250 / 0.95 },
  slippageBps: 50,
  floor: SWAP_REPAY_FLOOR_HF,
  quote: async (amountIn) => ({ poolId: 4512, amountOut: (amountIn * 3n * U) / W }),
  withdrawTx: (rawAmount, fromCollateralRaw) => ({
    receiverId: BURROW as AccountId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'execute_with_pyth',
        args: {
          actions: [
            { DecreaseCollateral: { max_amount: fromCollateralRaw.toString() } },
            { Withdraw: { max_amount: rawAmount.toString() } },
          ],
        },
        gas: 100_000_000_000_000n,
        deposit: 1n,
      },
    ],
  }),
  repayTx: (rawAmount) => ({
    receiverId: USDC as AccountId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: BURROW, amount: rawAmount.toString(), msg: 'repay' },
        gas: 100_000_000_000_000n,
        deposit: 1n,
      },
    ],
  }),
};

const ok = async (i: SwapRepayPrepareInput) => {
  const r = await prepareSwapRepay(i);
  if (!r.ok) throw new Error(r.error);
  return r;
};
const swapMsg = (args: Record<string, unknown>) =>
  JSON.parse(String(args['msg'])) as { actions: { min_amount_out: string; pool_id: number }[] };

describe('prepareSwapRepay', () => {
  it('builds withdraw -> swap -> repay in order, sized from the swap min-out', async () => {
    const r = await ok(base);
    expect(r.steps.map((s) => s.intentId)).toEqual(['withdraw', 'swap', 'repay']);
    const [withdraw, swap, repay] = r.steps.map((s) => s.tx);
    expect(withdraw?.actions[0]?.args).toEqual({
      actions: [
        { DecreaseCollateral: { max_amount: (20n * W).toString() } },
        { Withdraw: { max_amount: (20n * W).toString() } },
      ],
    });
    expect(swap?.receiverId).toBe(WNEAR);
    expect(swap?.actions[0]?.args['receiver_id']).toBe(RHEA);
    expect(swap?.actions[0]?.args['amount']).toBe((20n * W).toString());
    const minOut = (60n * U * 9950n) / 10_000n; // 60 USDC quoted, 0.5% slippage
    expect(swapMsg(swap?.actions[0]?.args ?? {}).actions[0]).toMatchObject({
      pool_id: 4512,
      token_in: WNEAR,
      token_out: USDC,
      min_amount_out: minOut.toString(),
    });
    expect(repay?.actions[0]?.args['amount']).toBe(minOut.toString());
    expect(r.amounts).toMatchObject({
      withdrawRaw: 20n * W,
      swapInRaw: 20n * W,
      minOutRaw: minOut,
      repayRaw: minOut,
    });
  });

  it('computes the health factor after each step from the fresh read and puts it in the preview', async () => {
    const r = await ok(base);
    const d = 250 / 0.95;
    expect(r.hf.now).toBeCloseTo(360 / d, 9);
    expect(r.hf.afterWithdraw).toBeCloseTo((360 - 20 * 1.8) / d, 9);
    expect(r.hf.afterRepay).toBeCloseTo((360 - 36) / (d - 59.7 / 0.95), 9);
    expect(r.steps).toHaveLength(3);
    expect(r.steps[0]?.preview).toMatch(/^Transaction 1 of 3/);
    expect(r.steps[0]?.preview).toContain((r.hf.afterWithdraw as number).toFixed(2));
    expect(r.steps[2]?.preview).toContain((r.hf.afterRepay as number).toFixed(2));
  });

  it('refuses a withdrawal that would take the health factor under the floor', async () => {
    const r = await prepareSwapRepay({
      ...base,
      requested: { swapInRaw: 60n * W, withdrawRaw: 60n * W },
    });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toContain('1.15');
  });

  it('swaps the wallet balance first, then withdraws only what was asked, capped by Burrow', async () => {
    const r = await ok({
      ...base,
      requested: { swapInRaw: 25n * W, withdrawRaw: 500n * W },
      collateral: { ...base.collateral, walletRaw: 5n * W, collateralRaw: 15n * W },
    });
    expect(r.amounts.withdrawRaw).toBe(15n * W);
    expect(r.amounts.swapInRaw).toBe(20n * W);
  });

  it('skips the withdrawal when the wallet holds the tokens: two transactions', async () => {
    const r = await ok({
      ...base,
      requested: { swapInRaw: 20n * W, withdrawRaw: 0n },
      collateral: { ...base.collateral, walletRaw: 30n * W },
    });
    expect(r.steps.map((s) => s.intentId)).toEqual(['swap', 'repay']);
    expect(r.hf.afterWithdraw).toBeCloseTo(r.hf.now as number, 9);
  });

  it('takes plain supply before collateral: only the collateral part lowers the health factor', async () => {
    const r = await ok({ ...base, collateral: { ...base.collateral, suppliedRaw: 5n * W } });
    expect(r.steps[0]?.tx.actions[0]?.args['actions']).toContainEqual({
      DecreaseCollateral: { max_amount: (15n * W).toString() },
    });
    expect(r.hf.afterWithdraw).toBeCloseTo((360 - 15 * 1.8) / (250 / 0.95), 9);
  });

  it('adds the wallet debt token to the repay, capped just above the debt', async () => {
    const r = await ok({ ...base, debt: { ...base.debt, walletRaw: 10n * U } });
    expect(r.amounts.repayRaw).toBe((60n * U * 9950n) / 10_000n + 10n * U);
    const small = await ok({
      ...base,
      model: { collateralAdjUsd: 360, debtAdjUsd: 30 / 0.95 },
      debt: { ...base.debt, debtRaw: 30n * U },
    });
    expect(small.amounts.repayRaw).toBe(30n * U + (30n * U) / 1000n);
    expect(small.hf.afterRepay).toBeNull();
  });

  it('registers on both tokens when the account is not registered yet', async () => {
    const r = await ok({
      ...base,
      collateral: { ...base.collateral, storageMin: 1_250_000_000_000_000_000_000n },
      debt: { ...base.debt, storageMin: 1_250_000_000_000_000_000_000n },
    });
    expect(r.steps.map((s) => s.intentId)).toEqual([
      'register-in',
      'withdraw',
      'register-out',
      'swap',
      'repay',
    ]);
    expect(r.steps[0]?.tx).toMatchObject({ receiverId: WNEAR });
    expect(r.steps[2]?.tx).toMatchObject({ receiverId: USDC });
    expect(r.steps[1]?.preview).toMatch(/^Transaction 2 of 5/);
  });

  it('refuses without a route, with nothing to swap, or when the token is its own debt', async () => {
    expect(await prepareSwapRepay({ ...base, quote: async () => null })).toMatchObject({
      ok: false,
    });
    expect(
      await prepareSwapRepay({
        ...base,
        collateral: { ...base.collateral, collateralRaw: 0n },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await prepareSwapRepay({ ...base, collateral: { ...base.collateral, token: USDC } }),
    ).toMatchObject({ ok: false });
    // Rhea may pay wNEAR out as native NEAR, which the repay could not send.
    expect(
      await prepareSwapRepay({
        ...base,
        collateral: { ...base.collateral, token: USDC },
        debt: { ...base.debt, token: WNEAR },
      }),
    ).toMatchObject({ ok: false });
  });

  it('passes the cascade validation with the protocols and the two tokens only', async () => {
    const r = await ok({
      ...base,
      collateral: { ...base.collateral, storageMin: 1_250_000_000_000_000_000_000n },
      debt: { ...base.debt, storageMin: 1_250_000_000_000_000_000_000n },
    });
    const cascade = assembleCascade(ACCOUNT, r.steps);
    expect(
      validateCascade(cascade.transactions, {
        signerId: ACCOUNT,
        allowedReceivers: new Set([BURROW, RHEA, WNEAR, USDC]),
      }),
    ).toMatchObject({ ok: true, reasons: [] });
    expect(
      validateCascade(cascade.transactions, {
        signerId: ACCOUNT,
        allowedReceivers: new Set([BURROW, WNEAR, USDC]),
      }).ok,
    ).toBe(false);
  });
});
