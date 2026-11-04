import { accountId, type AccountId } from '@near-autopilot/core';
import { z } from 'zod';
import type { TestnetChainReader } from './chain';
import { formatNear, TGAS, YOCTO_PER_NEAR } from './model';

/**
 * The ONLY operations the testnet tool can build: one contract, two methods, both on the testnet wNEAR token. No
 * swap, borrow, repay, LP, withdraw or rebalance can be expressed here. Adding an operation is a reviewed code change.
 */
export const WRAP_TESTNET = accountId('wrap.testnet');

export type OperationId = 'wrap.storage_deposit' | 'wrap.near_deposit';
export const OPERATION_IDS: readonly OperationId[] = ['wrap.storage_deposit', 'wrap.near_deposit'];
export const isOperationId = (v: string): v is OperationId =>
  (OPERATION_IDS as readonly string[]).includes(v);

export interface PlannedOperation {
  readonly operation: OperationId;
  readonly receiverId: AccountId;
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  readonly depositYocto: bigint;
  readonly gas: bigint;
  readonly expectedResult: string;
  readonly risks: readonly string[];
  /** Checked after a confirmed send: did the intended effect happen? */
  readonly verify: (chain: TestnetChainReader) => Promise<string>;
}

/** Bounds for near_deposit, independent of the budget: a first test wraps a token amount, not a balance. */
export const NEAR_DEPOSIT_MIN_YOCTO = YOCTO_PER_NEAR / 1000n; // 0.001
export const NEAR_DEPOSIT_MAX_YOCTO = YOCTO_PER_NEAR / 20n; // 0.05
/** A storage_deposit above this would mean the contract changed its terms: refuse rather than pay it. */
export const STORAGE_DEPOSIT_SANITY_MAX_YOCTO = YOCTO_PER_NEAR / 100n; // 0.01

const storageBalance = z.object({ total: z.string(), available: z.string() }).nullable();
const storageBounds = z.object({
  min: z.string().regex(/^\d+$/),
  max: z.string().nullable().optional(),
});
const ftBalance = z.string().regex(/^\d+$/);

export class OperationRefused extends Error {}

/** Builds an operation from live chain state; refuses anything unnecessary or out of bounds. */
export async function planOperation(
  op: OperationId,
  signer: AccountId,
  chain: TestnetChainReader,
  options: { amountYocto?: bigint } = {},
): Promise<PlannedOperation> {
  const exports = await chain.exports(WRAP_TESTNET);
  const registered = storageBalance.parse(
    await chain.view(WRAP_TESTNET, 'storage_balance_of', { account_id: signer }),
  );

  if (op === 'wrap.storage_deposit') {
    for (const m of ['storage_deposit', 'storage_balance_bounds', 'storage_balance_of']) {
      if (!exports.includes(m)) throw new OperationRefused(`${WRAP_TESTNET} does not export ${m}`);
    }
    if (registered !== null) {
      throw new OperationRefused(
        `${signer} is already registered on ${WRAP_TESTNET}: nothing to do`,
      );
    }
    const bounds = storageBounds.parse(
      await chain.view(WRAP_TESTNET, 'storage_balance_bounds', {}),
    );
    const deposit = BigInt(bounds.min);
    if (deposit <= 0n || deposit > STORAGE_DEPOSIT_SANITY_MAX_YOCTO) {
      throw new OperationRefused(
        `storage_balance_bounds.min is ${formatNear(deposit)} NEAR, outside the expected range`,
      );
    }
    return {
      operation: op,
      receiverId: WRAP_TESTNET,
      methodName: 'storage_deposit',
      args: { account_id: signer, registration_only: true },
      depositYocto: deposit,
      gas: 30n * TGAS,
      expectedResult: `${signer} becomes registered on ${WRAP_TESTNET} (storage_balance_of returns a balance); ${formatNear(deposit)} NEAR is held as storage deposit, refundable via storage_unregister.`,
      risks: [
        'The deposit is locked as token storage, not spent; it is refundable only by unregistering (storage_unregister).',
        'Gas is burnt even if the call fails.',
      ],
      verify: async (c) => {
        const after = storageBalance.parse(
          await c.view(WRAP_TESTNET, 'storage_balance_of', { account_id: signer }),
        );
        return after === null
          ? 'NOT registered after the transaction'
          : `registered: storage total ${formatNear(BigInt(after.total))} NEAR`;
      },
    };
  }

  // wrap.near_deposit
  if (!exports.includes('near_deposit') || !exports.includes('ft_balance_of')) {
    throw new OperationRefused(`${WRAP_TESTNET} does not export near_deposit / ft_balance_of`);
  }
  if (registered === null) {
    throw new OperationRefused(
      `${signer} is not registered on ${WRAP_TESTNET}: run wrap.storage_deposit first`,
    );
  }
  const amount = options.amountYocto;
  if (amount === undefined) throw new OperationRefused('near_deposit needs --amount (NEAR)');
  if (amount < NEAR_DEPOSIT_MIN_YOCTO || amount > NEAR_DEPOSIT_MAX_YOCTO) {
    throw new OperationRefused(
      `near_deposit amount must be between ${formatNear(NEAR_DEPOSIT_MIN_YOCTO)} and ${formatNear(NEAR_DEPOSIT_MAX_YOCTO)} NEAR`,
    );
  }
  const before = BigInt(
    ftBalance.parse(await chain.view(WRAP_TESTNET, 'ft_balance_of', { account_id: signer })),
  );
  return {
    operation: op,
    receiverId: WRAP_TESTNET,
    methodName: 'near_deposit',
    args: {},
    depositYocto: amount,
    gas: 30n * TGAS,
    expectedResult: `${formatNear(amount)} NEAR is wrapped: ${signer}'s wNEAR balance goes from ${formatNear(before)} to ${formatNear(before + amount)} (wrap.testnet, 24 decimals).`,
    risks: [
      'The NEAR becomes wNEAR (1:1, test token); unwrapping back needs a separate near_withdraw transaction.',
      'Gas is burnt even if the call fails.',
    ],
    verify: async (c) => {
      const after = BigInt(
        ftBalance.parse(await c.view(WRAP_TESTNET, 'ft_balance_of', { account_id: signer })),
      );
      return after - before === amount
        ? `wNEAR balance increased by exactly ${formatNear(amount)}`
        : `wNEAR balance changed by ${formatNear(after - before)}, expected ${formatNear(amount)}`;
    },
  };
}
