import type { TokenId } from '@near-autopilot/core';

export interface PoolRoute {
  readonly poolId: number;
  readonly tokenA: TokenId;
  readonly tokenB: TokenId;
}

export interface PoolRegistry {
  /** Pool ids that trade the pair directly, in either direction. */
  candidatePools(tokenIn: TokenId, tokenOut: TokenId): readonly number[];
}

/**
 * Explicit, operator-curated pool list. The system never discovers pools on its own: swapping
 * only through pools a human has reviewed is a deliberate safety property.
 */
export class StaticPoolRegistry implements PoolRegistry {
  constructor(private readonly routes: readonly PoolRoute[]) {}

  candidatePools(tokenIn: TokenId, tokenOut: TokenId): readonly number[] {
    return this.routes
      .filter(
        (r) =>
          (r.tokenA === tokenIn && r.tokenB === tokenOut) ||
          (r.tokenA === tokenOut && r.tokenB === tokenIn),
      )
      .map((r) => r.poolId);
  }
}
