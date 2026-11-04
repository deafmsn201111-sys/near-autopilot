import type {
  AccountId,
  ContractViewer,
  SwapQuote,
  SwapQuoteRequest,
  SwapQuoter,
} from '@near-autopilot/core';
import { UnexpectedResponseError, u128StringSchema } from '@near-autopilot/core';
import type { PoolRegistry } from './pool-registry';

export interface RheaQuoterOptions {
  /** Rhea (formerly Ref Finance) exchange contract. */
  readonly contractId: AccountId;
  readonly pools: PoolRegistry;
}

/** Quotes by calling the exchange's own `get_return` view on each candidate pool. */
export class RheaSwapQuoter implements SwapQuoter {
  constructor(
    private readonly viewer: ContractViewer,
    private readonly options: RheaQuoterOptions,
  ) {}

  async quote(request: SwapQuoteRequest): Promise<SwapQuote | null> {
    if (request.amountIn <= 0n) return null;
    const poolIds = this.options.pools.candidatePools(request.tokenIn, request.tokenOut);

    const results = await Promise.all(
      poolIds.map(async (poolId) => {
        const raw = await this.viewer.view(this.options.contractId, 'get_return', {
          pool_id: poolId,
          token_in: request.tokenIn,
          amount_in: request.amountIn.toString(),
          token_out: request.tokenOut,
        });
        const parsed = u128StringSchema.safeParse(raw);
        if (!parsed.success) {
          throw new UnexpectedResponseError(
            `${this.options.contractId}#get_return`,
            `pool ${poolId}: expected U128 string`,
          );
        }
        return { poolId, amountOut: parsed.data };
      }),
    );

    let best: { poolId: number; amountOut: bigint } | undefined;
    for (const r of results)
      if (r.amountOut > 0n && (!best || r.amountOut > best.amountOut)) best = r;
    if (!best) return null;
    return {
      protocol: 'rhea',
      poolId: best.poolId,
      amountIn: request.amountIn,
      amountOut: best.amountOut,
    };
  }
}
