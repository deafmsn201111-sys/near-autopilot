import { accountId, type AccountId } from '@near-autopilot/core';
import { z } from 'zod';
import type { TestnetChainReader } from './chain';
import { formatNear, TGAS, YOCTO_PER_NEAR } from './model';

/**
 * The ONLY operations the testnet tool can build: two on the testnet wNEAR token, and one deposit of wNEAR into the
 * Burrow testnet contract (the same `ft_transfer_call` with an empty message that the agent's Burrow planner builds
 * for a supply, burrow-adapter builders.ts `buildSupply`). No swap, borrow, repay, LP, withdraw or rebalance can be
 * expressed here. Adding an operation is a reviewed code change.
 */
export const WRAP_TESTNET = accountId('wrap.testnet');
export const BURROW_TESTNET = accountId('contract.1638481328.burrow.testnet');

export type OperationId = 'wrap.storage_deposit' | 'wrap.near_deposit' | 'burrow.supply_wnear';
export const OPERATION_IDS: readonly OperationId[] = [
  'wrap.storage_deposit',
  'wrap.near_deposit',
  'burrow.supply_wnear',
];
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
  if (op === 'burrow.supply_wnear') return planBurrowSupply(signer, chain, options.amountYocto);
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

/** Burrow testnet supply: the gas the agent's builder attaches to ft_transfer_call (burrow-adapter BURROW_GAS). */
const BURROW_FT_TRANSFER_CALL_GAS = 100n * TGAS;

const burrowAccount = z
  .object({
    supplied: z.array(z.object({ token_id: z.string(), balance: z.string().regex(/^\d+$/) })),
  })
  .passthrough()
  .nullable();
const burrowAsset = z
  .object({
    config: z.object({ can_deposit: z.boolean(), extra_decimals: z.number().int() }).passthrough(),
  })
  .passthrough()
  .nullable();

const suppliedWnear = async (chain: TestnetChainReader, signer: AccountId): Promise<bigint> => {
  const a = burrowAccount.parse(
    await chain.view(BURROW_TESTNET, 'get_account', { account_id: signer }),
  );
  return BigInt(a?.supplied.find((x) => x.token_id === WRAP_TESTNET)?.balance ?? '0');
};

/**
 * Deposit wNEAR into Burrow (testnet) as a plain supply: earns the supply rate, NOT collateral, nothing borrowed.
 * Refuses unless the account is already registered with Burrow (its storage deposit, 0.1 NEAR on testnet, is not
 * something this tool pays: with fees it would exceed the 0.1 NEAR per-operation limit) and holds the wNEAR.
 */
async function planBurrowSupply(
  signer: AccountId,
  chain: TestnetChainReader,
  amount: bigint | undefined,
): Promise<PlannedOperation> {
  const exports = await chain.exports(BURROW_TESTNET);
  for (const m of ['get_account', 'get_asset', 'storage_balance_of', 'ft_on_transfer']) {
    if (!exports.includes(m)) throw new OperationRefused(`${BURROW_TESTNET} does not export ${m}`);
  }
  if (amount === undefined)
    throw new OperationRefused('burrow.supply_wnear needs --amount (wNEAR)');
  if (amount < NEAR_DEPOSIT_MIN_YOCTO || amount > NEAR_DEPOSIT_MAX_YOCTO) {
    throw new OperationRefused(
      `the amount must be between ${formatNear(NEAR_DEPOSIT_MIN_YOCTO)} and ${formatNear(NEAR_DEPOSIT_MAX_YOCTO)} wNEAR`,
    );
  }
  const registered = storageBalance.parse(
    await chain.view(BURROW_TESTNET, 'storage_balance_of', { account_id: signer }),
  );
  if (registered === null) {
    const bounds = storageBounds.parse(
      await chain.view(BURROW_TESTNET, 'storage_balance_bounds', {}),
    );
    throw new OperationRefused(
      `${signer} is not registered with ${BURROW_TESTNET}: its storage deposit is ${formatNear(BigInt(bounds.min))} NEAR, which with fees exceeds the ${formatNear(YOCTO_PER_NEAR / 10n)} NEAR per-operation limit, so this tool does not pay it`,
    );
  }
  const asset = burrowAsset.parse(
    await chain.view(BURROW_TESTNET, 'get_asset', { token_id: WRAP_TESTNET }),
  );
  if (!asset?.config.can_deposit)
    throw new OperationRefused(`Burrow does not accept deposits of ${WRAP_TESTNET}`);
  const held = BigInt(
    ftBalance.parse(await chain.view(WRAP_TESTNET, 'ft_balance_of', { account_id: signer })),
  );
  if (held < amount) {
    throw new OperationRefused(
      `${signer} holds ${formatNear(held)} wNEAR, less than ${formatNear(amount)}: wrap NEAR first (wrap.near_deposit)`,
    );
  }
  const before = await suppliedWnear(chain, signer);
  // Burrow keeps balances in inner units: token amount x 10^extra_decimals (0 for wNEAR on testnet).
  const scale = 10n ** BigInt(asset.config.extra_decimals);
  return {
    operation: 'burrow.supply_wnear',
    receiverId: WRAP_TESTNET,
    methodName: 'ft_transfer_call',
    args: { receiver_id: BURROW_TESTNET, amount: amount.toString(), msg: '' },
    depositYocto: 1n,
    gas: BURROW_FT_TRANSFER_CALL_GAS,
    expectedResult: `${formatNear(amount)} wNEAR moves from ${signer} into Burrow as a supply (not collateral, nothing borrowed): Burrow's supplied wNEAR for ${signer} goes from ${formatNear(before / scale)} to about ${formatNear(before / scale + amount)}.`,
    risks: [
      'The wNEAR sits in the Burrow testnet contract and earns its supply rate; taking it back needs a separate withdraw transaction.',
      'If Burrow refuses the deposit, the token contract refunds the wNEAR; the gas is burnt either way.',
    ],
    verify: async (c) => {
      const after = await suppliedWnear(c, signer);
      const added = (after - before) / scale;
      return added >= amount
        ? `Burrow supplied wNEAR increased by ${formatNear(added)}`
        : `Burrow supplied wNEAR changed by ${formatNear(added)}, expected ${formatNear(amount)}`;
    },
  };
}
