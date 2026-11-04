import {
  accountId,
  type ActionIntent,
  type AssetRisk,
  type LendingRepayIntent,
  type PlannedTransaction,
  type PortfolioSnapshot,
  type SwapIntent,
  type TokenId,
  type UnitPrice,
} from '@near-autopilot/core';
import { FixedClock, SequentialIds } from '@near-autopilot/core/testing';
import {
  PolicyEngine,
  policyConfigSchema,
  type PolicyConfig,
  type PolicyConfigInput,
  type PolicyInput,
} from '../src';

export const ALICE = accountId('alice.near');
export const REF = accountId('v2.ref-finance.near');
export const BURROW = accountId('contract.main.burrow.near');
export const WNEAR = accountId('wrap.near');
export const USDT = accountId('usdt.tether-token.near');
export const NOW = new Date('2026-11-03T12:00:00Z');

const NEAR_PRICE: UnitPrice = { multiplier: 50_000n, decimals: 28 }; // $5
const USDT_PRICE: UnitPrice = { multiplier: 10_000n, decimals: 10 }; // $1

export const baseConfigInput: PolicyConfigInput = {
  signerAccountId: ALICE,
  allowedContracts: [WNEAR, USDT, REF, BURROW],
  allowedRecipients: [REF, BURROW],
  allowedTokens: [WNEAR, USDT],
  maxActionUsd: 100,
  dailyLimitUsd: 500,
  approvalThresholdUsd: 75,
  maxSlippageBps: 100,
  maxOracleDeviationBps: 200,
};

export const makeConfig = (overrides: Partial<PolicyConfigInput> = {}): PolicyConfig =>
  policyConfigSchema.parse({ ...baseConfigInput, ...overrides });

export const makeEngine = (config: PolicyConfig = makeConfig(), clock = new FixedClock(NOW)) => ({
  engine: new PolicyEngine(config, { clock, ids: new SequentialIds('d') }),
  clock,
});

export const risk: ReadonlyMap<TokenId, AssetRisk> = new Map();

export function makeSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    accountId: ALICE,
    takenAt: NOW,
    pricesAsOf: NOW,
    nativeBalance: 10n ** 24n,
    walletBalances: [
      { token: WNEAR, raw: 100n * 10n ** 24n },
      { token: USDT, raw: 500_000_000n },
    ],
    lending: null,
    prices: new Map([
      [WNEAR, NEAR_PRICE],
      [USDT, USDT_PRICE],
    ]),
    risk,
    tokens: new Map(),
    ...overrides,
  };
}

/** 10 NEAR ($50) -> 49.5 USDt (100 bps worse than oracle), 50 bps slippage floor. */
export const swapIntent = (overrides: Partial<SwapIntent> = {}): SwapIntent => ({
  id: 'intent-1',
  agentId: 'rebalancer',
  reason: 'test',
  kind: 'swap',
  protocol: 'rhea',
  tokenIn: WNEAR,
  tokenOut: USDT,
  amountIn: 10n * 10n ** 24n,
  poolId: 7,
  quotedAmountOut: 49_500_000n,
  minAmountOut: 49_252_500n,
  slippageBps: 50,
  ...overrides,
});

export const repayIntent = (overrides: Partial<LendingRepayIntent> = {}): LendingRepayIntent => ({
  id: 'intent-2',
  agentId: 'guardian',
  reason: 'test',
  kind: 'lending.repay',
  protocol: 'burrow',
  token: USDT,
  amount: 20_000_000n,
  ...overrides,
});

/** Hand-built to match what the adapters emit; policy-engine must not depend on adapters. */
export function planFor(intent: ActionIntent): PlannedTransaction {
  if (intent.kind === 'swap') {
    return {
      intentId: intent.id,
      signerId: ALICE,
      receiverId: intent.tokenIn,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: REF,
            amount: intent.amountIn.toString(),
            msg: JSON.stringify({
              force: 0,
              actions: [
                {
                  pool_id: intent.poolId,
                  token_in: intent.tokenIn,
                  token_out: intent.tokenOut,
                  amount_in: intent.amountIn.toString(),
                  min_amount_out: intent.minAmountOut.toString(),
                },
              ],
            }),
          },
          gas: 180_000_000_000_000n,
          deposit: 1n,
        },
      ],
    };
  }
  // Mirrors burrow-adapter builders: Repay / IncreaseCollateral capped in inner units (USDt: 12 extra decimals).
  const capped = (action: 'Repay' | 'IncreaseCollateral') =>
    JSON.stringify({
      Execute: {
        actions: [
          {
            [action]: {
              token_id: intent.token,
              max_amount: (intent.amount * 10n ** 12n).toString(),
            },
          },
        ],
      },
    });
  const msg =
    intent.kind === 'lending.repay'
      ? capped('Repay')
      : intent.asCollateral
        ? capped('IncreaseCollateral')
        : '';
  return {
    intentId: intent.id,
    signerId: ALICE,
    receiverId: intent.token,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: BURROW, amount: intent.amount.toString(), msg },
        gas: 300_000_000_000_000n,
        deposit: 1n,
      },
    ],
  };
}

export const input = (
  intent: ActionIntent = swapIntent(),
  overrides: Partial<PolicyInput> = {},
): PolicyInput => ({
  intent,
  plan: planFor(intent),
  snapshot: makeSnapshot(),
  history: { spentLast24hUsdMicro: 0n, lastExecutedAt: null },
  ...overrides,
});
