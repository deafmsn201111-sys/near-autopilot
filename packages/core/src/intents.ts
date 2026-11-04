import type { ProtocolId, TokenId } from './ids';

interface IntentBase {
  readonly id: string;
  readonly agentId: string;
  /** Human-readable justification, persisted for audit. */
  readonly reason: string;
}

export interface SwapIntent extends IntentBase {
  readonly kind: 'swap';
  readonly protocol: 'rhea';
  readonly tokenIn: TokenId;
  readonly tokenOut: TokenId;
  readonly amountIn: bigint;
  readonly poolId: number;
  readonly quotedAmountOut: bigint;
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
}

export interface LendingRepayIntent extends IntentBase {
  readonly kind: 'lending.repay';
  readonly protocol: 'burrow';
  readonly token: TokenId;
  readonly amount: bigint;
}

export interface LendingSupplyIntent extends IntentBase {
  readonly kind: 'lending.supply';
  readonly protocol: 'burrow';
  readonly token: TokenId;
  readonly amount: bigint;
  readonly asCollateral: boolean;
}

/**
 * What an agent wants to do. v1 deliberately has no borrow/withdraw intents: the system
 * can only reduce risk or rebalance spot holdings, never increase leverage.
 */
export type ActionIntent = SwapIntent | LendingRepayIntent | LendingSupplyIntent;
export type IntentKind = ActionIntent['kind'];

export function intentProtocol(intent: ActionIntent): ProtocolId {
  return intent.protocol;
}

export function intentTokens(intent: ActionIntent): readonly TokenId[] {
  return intent.kind === 'swap' ? [intent.tokenIn, intent.tokenOut] : [intent.token];
}

export function describeIntent(intent: ActionIntent): string {
  switch (intent.kind) {
    case 'swap':
      return `swap ${intent.amountIn} ${intent.tokenIn} -> ${intent.tokenOut} on Rhea (pool ${intent.poolId})`;
    case 'lending.repay':
      return `repay ${intent.amount} ${intent.token} on Burrow`;
    case 'lending.supply':
      return `supply ${intent.amount} ${intent.token} on Burrow${intent.asCollateral ? ' as collateral' : ''}`;
  }
}
