import { accountId, type AccountId, type Network } from '@near-autopilot/core';

/**
 * Evidence tiers used here and in docs/burrow-capability-matrix.md:
 *   S  read in the CONTRACT source: github.com/burrowfdn/burrowland @ 0dbfa18 (contract v0.7.0)
 *      and github.com/NearDeFi/price-oracle @ df2efbe
 *   A  read in the official frontend: github.com/burrowfdn/burrow-cash @ bcb204b
 *   (a method is only implemented here if it has S or A evidence; most have both)
 * The deployed contracts may be NEWER than the commits above. `verifyBurrowDeployment` therefore
 * re-checks method names against the deployed WASM before any transaction is built.
 */

export type BurrowDeploymentId = 'mainnet' | 'mainnet-beta';

export interface BurrowDeploymentInfo {
  readonly network: Network;
  readonly contractId: AccountId;
}

/**
 * Burrow contract per deployment.
 *   mainnet / mainnet-beta  A: burrow-cash `store/constants.ts` CONTRACT_MAIN / CONTRACT_BETA
 * Whether each account currently has code deployed is NOT assumed: verification checks it.
 * The oracle account is deliberately absent: it is read from the contract's own `get_config`.
 */
export const BURROW_DEPLOYMENTS: Readonly<Record<BurrowDeploymentId, BurrowDeploymentInfo>> = {
  mainnet: { network: 'mainnet', contractId: accountId('contract.main.burrow.near') },
  'mainnet-beta': { network: 'mainnet', contractId: accountId('contract.beta.burrow.near') },
};

/** Burrow view methods this adapter calls (S + A). */
export const BURROW_VIEW_METHODS = [
  'get_account',
  'get_asset',
  'get_assets_paged_detailed',
  'get_config',
  'storage_balance_of',
] as const;

/**
 * Burrow methods that must be exported by the deployment before ANY transaction is built.
 * `ft_on_transfer` is how `ft_transfer_call` reaches the contract (S: fungible_token.rs);
 * `execute` is the direct action entry point (S: actions.rs); `execute_with_pyth` runs priced actions.
 */
export const BURROW_REQUIRED_EXPORTS = [
  ...BURROW_VIEW_METHODS,
  'execute',
  'ft_on_transfer',
  'execute_with_pyth',
] as const;

/** Oracle methods this adapter relies on (S: price-oracle src/lib.rs). */
export const ORACLE_REQUIRED_EXPORTS = ['get_price_data', 'oracle_call'] as const;

/** A fungible token must at least export this to be sent to Burrow. */
export const TOKEN_REQUIRED_EXPORTS = ['ft_transfer_call', 'ft_balance_of'] as const;

/** Gas copied from burrow-cash call sites (A): repay.ts / supply.ts use 100 Tgas; utils `call` uses 50 Tgas. */
export const BURROW_GAS = {
  ftTransferCall: 100_000_000_000_000n,
  execute: 50_000_000_000_000n,
  /** `execute_with_pyth`: Burrow fetches prices in a promise, then runs the actions (and any ft_transfer) in a
   *  callback; 300 Tgas, as the working mainnet call and burrow-cash use. */
  executeWithPyth: 300_000_000_000_000n,
} as const;

/** Burrow views reject a missing/zero ratio; contract asserts `volatility_ratio < 10000` (S: asset_config.rs). */
export const BPS = 10_000n;
