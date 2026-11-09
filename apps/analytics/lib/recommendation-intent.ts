import type { PrepareRequest, PrepareRequestIntent } from './prepare-types';

/**
 * A recommendation's intent, as the analytics API emits it on `GET /v1/analytics/account/:id` (one per card).
 * Mirrors `RecommendationIntent` in the API: the agents say what/why, and this is the concrete, parameterised action.
 */
export type RecommendationIntent =
  | { readonly action: 'repay'; readonly token: string; readonly approxUsd: number }
  | { readonly action: 'supply'; readonly token: string; readonly approxUsd: number }
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

/** A sensible default token to move concentrated holdings into when a recommendation does not name one. */
export const DEFAULT_SWAP_TARGET = 'usdt.tether-token.near';

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
      mapped = { action: intent.action, token: intent.token, approxUsd: intent.approxUsd };
      break;
    case 'swap':
      if (intent.fromToken === DEFAULT_SWAP_TARGET) return null; // nothing to do: already the target
      mapped = {
        action: 'swap',
        token: intent.fromToken,
        tokenOut: DEFAULT_SWAP_TARGET,
        approxUsd: intent.approxUsd,
      };
      break;
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
