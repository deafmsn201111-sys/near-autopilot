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
  | { readonly action: 'reposition_dcl'; readonly lptId: string; readonly poolId: string };

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
      return 'Prepare reposition';
  }
}
