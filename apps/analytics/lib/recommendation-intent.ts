import type { PrepareRequest, PrepareRequestIntent } from './prepare-types';

/**
 * A recommendation's intent, as the analytics API emits it on `GET /v1/analytics/account/:id` (one per card).
 * Mirrors `RecommendationIntent` in the API: the agents say what/why, and this is the concrete, parameterised action.
 */
export type RecommendationIntent =
  | {
      readonly action: 'repay' | 'supply';
      readonly token: string;
      readonly approxUsd: number;
      readonly amount?: string;
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
  readonly intent: RecommendationIntent;
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
 * Map a recommendation's intent to a concrete `prepare` request for `account`. Returns null when the intent cannot be
 * turned into a one-click action the engine supports yet (so the card simply shows the advice without a button).
 * `repay`/`supply` map straight through; `swap` (reduce concentration) targets a stablecoin; `reposition_dcl` carries
 * the position id. The engine still validates everything and refuses anything it cannot assemble safely.
 */
export function recommendationToPrepare(
  intent: RecommendationIntent,
  account: string,
): PrepareRequest | null {
  let mapped: PrepareRequestIntent | null = null;
  switch (intent.action) {
    case 'repay':
    case 'supply':
      mapped = {
        action: intent.action,
        token: intent.token,
        approxUsd: intent.approxUsd,
        ...(intent.amount ? { amount: intent.amount } : {}),
      };
      break;
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
  return mapped ? { account, intent: mapped } : null;
}

/** A short verb for the card's action button. */
export function actionLabel(intent: RecommendationIntent): string {
  switch (intent.action) {
    case 'repay':
      return 'Prepare repayment';
    case 'supply':
      return 'Prepare deposit';
    case 'swap':
      return 'Prepare rebalance';
    case 'reposition_dcl':
      return 'Prepare reposition';
  }
}
