import { accountId, type AccountId } from '@near-autopilot/core';

/**
 * Evidence tiers used throughout this package and docs/rhea-dcl-capability-matrix.md:
 *   A  read in source code of an official Rhea/Ref repository (ref-finance/ref-sdk, ref-finance/ref-ui)
 *   B  observed in a live probe / third-party report, not in source we could read
 *   C  method name only (appears in a method list, args unknown)
 * Nothing in this file is tier C. Every constant names the file that proves it.
 */

/**
 * Rhea/Ref v2 DCL ("dclv2") contract per deployment.
 *   testnet      ref-sdk  src/constant.ts  getConfig('testnet').REF_DCL_SWAP_CONTRACT_ID
 *                ref-ui   src/services/config.ts  (testnet block) REF_UNI_V3_SWAP_CONTRACT_ID
 *   testnet-dev  ref-sdk  getConfig('dev')   ; ref-ui "pub_testnet/dev" block
 *   mainnet      both repos
 * Existence of code on these accounts is NOT asserted here: use `verifyDeployedAbi` to check.
 */
export type DclDeployment = 'mainnet' | 'testnet' | 'testnet-dev';

export const DCL_CONTRACT_IDS: Readonly<Record<DclDeployment, AccountId>> = {
  mainnet: accountId('dclv2.ref-labs.near'),
  testnet: accountId('dclv2.ref-dev.testnet'),
  'testnet-dev': accountId('refv2-dev.ref-dev.testnet'),
};

/**
 * Every testnet DCL account named anywhere in ref-sdk / ref-ui, in order of how authoritative the reference is.
 * Only the first is used by default; run `verifyDeployedAbi` on each to learn which actually has code.
 */
export const DCL_TESTNET_CANDIDATES: readonly AccountId[] = [
  accountId('dclv2.ref-dev.testnet'),
  accountId('refv2-dev.ref-dev.testnet'),
  accountId('dcl.ref-dev.testnet'),
  accountId('mock-dcl.ref-dev.testnet'),
];

/** Legacy testnet DCL ("dclv1") still referenced by ref-ui for migration reads. Not used by this adapter. */
export const LEGACY_TESTNET_DCL_V1 = accountId('dclv1.ref-dev.testnet');

/** Testnet pool ref-ui hides (DCL_POOL_BLACK_LIST, src/services/config.ts testnet block). */
export const TESTNET_POOL_BLACKLIST_IN_REF_UI: readonly string[] = [
  'usdt.fakes.testnet|wrap.testnet|100',
];

/** ref-sdk src/dcl-swap/dcl-pool.ts DCL_POOL_FEE_LIST; units are 1/1_000_000 (2000 = 0.2%). */
export const DCL_FEE_TIERS = [100, 400, 2000, 10000] as const;
export type DclFee = (typeof DCL_FEE_TIERS)[number];

/** ref-sdk src/utils.ts feeToPointDelta. */
const POINT_DELTA_BY_FEE: Readonly<Record<DclFee, number>> = {
  100: 1,
  400: 8,
  2000: 40,
  10000: 200,
};

export function isDclFee(fee: number): fee is DclFee {
  return (DCL_FEE_TIERS as readonly number[]).includes(fee);
}

export function feeToPointDelta(fee: number): number {
  if (!isDclFee(fee))
    throw new RangeError(`Unsupported DCL fee ${fee}; expected one of ${DCL_FEE_TIERS.join(', ')}`);
  return POINT_DELTA_BY_FEE[fee];
}

/** ref-sdk src/constant.ts POINTLEFTRANGE / POINTRIGHTRANGE; ref-ui compute_liquidity.ts LEFT/RIGHT_MOST_POINT. */
export const POINT_MIN = -800_000;
export const POINT_MAX = 800_000;

export const ONE_YOCTO = 1n;
const NEAR = 10n ** 24n;

/** Gas values copied from ref-sdk / ref-ui call sites (units of gas, not Tgas). */
export const DCL_GAS = {
  /** ft_transfer_call carrying a swap/limit-order message. ref-sdk swap.ts. */
  swapTransferCall: 180_000_000_000_000n,
  /** ft_transfer_call carrying the "Deposit" message. ref-ui swapV3.ts add_liquidity. */
  depositTransferCall: 150_000_000_000_000n,
  addLiquidity: 150_000_000_000_000n,
  appendLiquidity: 150_000_000_000_000n,
  removeLiquidity: 150_000_000_000_000n,
  withdrawAsset: 100_000_000_000_000n,
  cancelOrder: 180_000_000_000_000n,
  createPool: 180_000_000_000_000n,
  storageDeposit: 30_000_000_000_000n,
} as const;

export const DCL_DEPOSITS = {
  /** create_pool attaches 0.1 NEAR (ref-ui swapV3.ts create_pool). */
  createPool: NEAR / 10n,
  /** First-time registration on the DCL contract: 0.5 NEAR (ref-ui get_user_storage_detail, ref-sdk limit order). */
  firstRegistration: NEAR / 2n,
  /** NEP-145 registration on a fungible token: 0.1 NEAR (ref-sdk STORAGE_TO_REGISTER_WITH_MFT). */
  tokenRegistration: NEAR / 10n,
} as const;

/**
 * Methods whose exact name AND argument names were read in source (tier A).
 * `verifyDeployedAbi` checks that a deployed WASM actually exports them.
 */
export const DCL_VERIFIED_VIEW_METHODS = [
  'get_pool',
  'list_pools',
  'get_liquidity',
  'list_liquidities',
  'list_user_assets',
  'get_marketdepth',
  'get_pointorder_range',
  'quote',
  'quote_by_output',
  'get_order',
  'find_order',
  'list_active_orders',
  'list_history_orders',
  'get_user_storage_detail',
  'storage_balance_of',
  'get_metadata',
  'mft_balance_of',
] as const;

export const DCL_VERIFIED_CALL_METHODS = [
  'create_pool',
  'add_liquidity',
  'append_liquidity',
  'remove_liquidity',
  'withdraw_asset',
  'cancel_order',
  'storage_deposit',
  'burn_v_liquidity',
] as const;

/**
 * Methods that appear in consumer code but whose argument shape we could not read
 * (so they are deliberately NOT implemented), or that appear only in third-party reports.
 */
export const DCL_UNIMPLEMENTED_METHODS = [
  'batch_add_liquidity',
  'batch_remove_liquidity',
  'batch_update_liquidity',
  'batch_burn_v_liquidity',
  'predict_add_liquidity',
] as const;
