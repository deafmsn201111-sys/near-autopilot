import type { RepaySizing } from '@near-autopilot/core/loan-math';
import type { PrepareRequest, PrepareRequestIntent } from './prepare-types';

/**
 * A recommendation's intent, as the analytics API emits it on `GET /v1/analytics/account/:id` (one per card).
 * Mirrors `RecommendationIntent` in the API: the agents say what/why, and this is the concrete, parameterised action.
 */
export type RecommendationIntent =
  | {
      readonly action: 'repay' | 'repay_from_collateral' | 'supply' | 'withdraw';
      readonly token: string;
      readonly approxUsd: number;
      readonly amount?: string;
      /** Repay cards: what the amount picker needs to recompute the health factor. */
      readonly sizing?: RepaySizing;
    }
  | { readonly action: 'swap'; readonly fromToken: string; readonly approxUsd: number }
  | { readonly action: 'reposition_dcl'; readonly lptId: string; readonly poolId: string }
  | {
      /** Every idle token worth its fee, one Burrow supply each, signed together. */
      readonly action: 'supply_all';
      readonly tokens: readonly { readonly token: string; readonly approxUsd: number }[];
    }
  | {
      /** Withdraw another collateral token, swap it into the debt token, repay: separate transactions in order. */
      readonly action: 'repay_with_collateral';
      readonly token: string;
      readonly collateralToken: string;
      readonly approxUsd: number;
      readonly amount: string;
      readonly withdraw?: string;
      readonly maxSlippageBps: number;
      readonly plan: {
        readonly hfNow: number;
        readonly hfAfterWithdraw: number;
        readonly hfAfterRepay: number | null;
        readonly floorHf: number;
        readonly transactions: number;
      };
    }
  | {
      readonly action: 'recentre_dcl';
      readonly lptId: string;
      readonly poolId: string;
      readonly leftPoint: number;
      readonly rightPoint: number;
    };

export interface Recommendation {
  readonly id: string;
  readonly kind: string;
  readonly agent: string;
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly why: string;
  /** Null for advice with no one-click action. */
  readonly intent: RecommendationIntent | null;
}

/** Canonical wrapped NEAR, and the stablecoin the allowlisted Rhea pool routes NEAR to (USDC). */
export const WRAP_NEAR = 'wrap.near';
export const SWAP_STABLE = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/** Normalise a recommendation's `fromToken`: native "near" is swapped in its wrapped form. */
function normalizeFrom(token: string): string {
  return token === 'near' || token === 'NEAR' ? WRAP_NEAR : token;
}

/** The other side of the allowlisted wNEAR<->USDC pool, given the (normalised) source token. */
function swapTargetFor(from: string): string {
  return from === SWAP_STABLE ? WRAP_NEAR : SWAP_STABLE;
}

/** The tokens a card acts on, for its logos: the token, or both sides of a swap; none for advice or an LP move. */
export function intentTokens(intent: RecommendationIntent | null): string[] {
  if (!intent) return [];
  switch (intent.action) {
    case 'reposition_dcl':
    case 'recentre_dcl':
      return [];
    case 'swap': {
      const from = normalizeFrom(intent.fromToken);
      return [from, swapTargetFor(from)];
    }
    case 'repay_with_collateral':
      return [intent.collateralToken, intent.token];
    case 'supply_all':
      return intent.tokens.map((t) => t.token);
    default:
      return [intent.token];
  }
}

/**
 * Map a recommendation's intent to a concrete `prepare` request for `account`. Returns null for advice-only cards
 * (no intent), so the card shows the advice without a button. Burrow intents map straight through, with `amount`
 * (base units) when the user picked one; `swap` (reduce concentration) targets a stablecoin; `reposition_dcl` carries
 * the position id. The engine still validates everything and refuses anything it cannot assemble safely.
 */
export function recommendationToPrepare(
  intent: RecommendationIntent | null,
  account: string,
  pickedAmount?: string,
): PrepareRequest | null {
  if (!intent) return null;
  let mapped: PrepareRequestIntent;
  switch (intent.action) {
    case 'repay':
    case 'repay_from_collateral':
    case 'supply':
    case 'withdraw': {
      const amount = pickedAmount ?? intent.amount;
      mapped = {
        action: intent.action,
        token: intent.token,
        approxUsd: intent.approxUsd,
        ...(amount ? { amount } : {}),
      };
      break;
    }
    case 'swap': {
      const from = normalizeFrom(intent.fromToken);
      mapped = {
        action: 'swap',
        token: from,
        tokenOut: swapTargetFor(from),
        approxUsd: intent.approxUsd,
      };
      break;
    }
    case 'reposition_dcl':
      mapped = { action: 'reposition_dcl', lptId: intent.lptId };
      break;
    case 'supply_all':
      mapped = { action: 'supply_all', tokens: intent.tokens };
      break;
    case 'repay_with_collateral':
      mapped = {
        action: 'repay_with_collateral',
        token: intent.token,
        collateralToken: intent.collateralToken,
        approxUsd: intent.approxUsd,
        amount: intent.amount,
        ...(intent.withdraw ? { withdraw: intent.withdraw } : {}),
        maxSlippageBps: intent.maxSlippageBps,
      };
      break;
    case 'recentre_dcl':
      mapped = {
        action: 'recentre_dcl',
        lptId: intent.lptId,
        leftPoint: intent.leftPoint,
        rightPoint: intent.rightPoint,
      };
      break;
  }
  return { account, intent: mapped };
}

/** A short verb for the card's action button. */
export function actionLabel(intent: RecommendationIntent): string {
  switch (intent.action) {
    case 'repay':
      return 'Prepare repayment';
    case 'repay_from_collateral':
      return 'Prepare repayment from collateral';
    case 'supply':
      return 'Prepare deposit';
    case 'withdraw':
      return 'Prepare withdrawal';
    case 'swap':
      return 'Prepare rebalance';
    case 'reposition_dcl':
      return 'Prepare exit to wallet';
    case 'supply_all':
      return `Prepare ${intent.tokens.length} deposits`;
    case 'repay_with_collateral':
      return `Prepare ${intent.plan.transactions} transactions to repay`;
    case 'recentre_dcl':
      return 'Prepare new range';
  }
}
