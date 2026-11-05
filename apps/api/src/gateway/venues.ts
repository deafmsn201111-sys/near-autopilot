import { errorMessage, type AccountId, type ContractViewer } from '@near-autopilot/core';
import {
  DEFAULT_SWAP_GAS,
  RheaSwapQuoter,
  StaticPoolRegistry,
  type PoolRegistry,
} from '@near-autopilot/rhea-adapter';
import { z } from 'zod';
import type { RouteRequest, VenueId, VenueQuote } from './best-execution';
import type { OneClickClient } from './one-click';

/** What every venue is asked: the trade, the account it is for, the slippage tolerance and the gas price to cost it. */
export interface VenueRequest extends RouteRequest {
  readonly account: string;
  readonly slippageBps: number;
  readonly gasPriceYocto: bigint;
  /** Gas the plan itself attaches (a Rhea plan); otherwise the venue's own default. */
  readonly attachedGas?: bigint;
  /** The pool an approved plan names: Rhea is quoted on exactly that pool, not on the best configured one. */
  readonly poolId?: number;
  readonly now: () => Date;
}

export interface Venue {
  readonly id: VenueId;
  quote(r: VenueRequest): Promise<VenueQuote>;
}

/** ft_transfer of the input token to a 1Click deposit address: the only transaction the user would sign. */
export const ONE_CLICK_DEPOSIT_GAS = 30_000_000_000_000n;

/**
 * Rhea: the exchange's own `get_return` view (read-only). On the plan's pool when one is named, otherwise the best of
 * the operator-configured pools for the pair (the system never discovers pools to trade through).
 */
export class RheaVenue implements Venue {
  readonly id = 'rhea' as const;
  constructor(
    private readonly viewer: ContractViewer,
    private readonly o: { readonly contractId: AccountId; readonly pools: PoolRegistry },
  ) {}

  async quote(r: VenueRequest): Promise<VenueQuote> {
    try {
      if (
        r.poolId !== undefined &&
        !this.o.pools.candidatePools(r.tokenIn, r.tokenOut).includes(r.poolId)
      )
        return {
          venue: this.id,
          ok: false,
          quotedAt: r.now(),
          reason: `pool ${r.poolId} is not an operator-configured pool for this pair`,
        };
      const pools =
        r.poolId === undefined
          ? this.o.pools
          : new StaticPoolRegistry([{ poolId: r.poolId, tokenA: r.tokenIn, tokenB: r.tokenOut }]);
      const q = await new RheaSwapQuoter(this.viewer, {
        contractId: this.o.contractId,
        pools,
      }).quote(r);
      const quotedAt = r.now();
      if (!q)
        return {
          venue: this.id,
          ok: false,
          quotedAt,
          reason: 'no configured pool trades this pair',
        };
      return {
        venue: this.id,
        ok: true,
        quotedAt,
        amountOut: q.amountOut,
        minAmountOut: (q.amountOut * BigInt(10_000 - r.slippageBps)) / 10_000n,
        feeBps: null,
        gasUpperBoundYocto: (r.attachedGas ?? DEFAULT_SWAP_GAS) * r.gasPriceYocto,
        settlement: 'atomic',
        ref: `pool:${q.poolId}`,
        detail: 'get_return view at final; pool fee included',
      };
    } catch (e) {
      return {
        venue: this.id,
        ok: false,
        quotedAt: r.now(),
        reason: `quote failed: ${errorMessage(e)}`,
      };
    }
  }
}

/** NEAR Intents via 1Click, dry quotes only (see one-click.ts). */
export class OneClickVenue implements Venue {
  readonly id = 'near-intents-1click' as const;
  constructor(private readonly client: OneClickClient) {}

  async quote(r: VenueRequest): Promise<VenueQuote> {
    try {
      const q = await this.client.dryQuote({
        tokenIn: r.tokenIn,
        tokenOut: r.tokenOut,
        amountIn: r.amountIn,
        slippageBps: r.slippageBps,
        account: r.account,
        now: r.now(),
      });
      return {
        venue: this.id,
        ok: true,
        quotedAt: q.quotedAt,
        amountOut: q.amountOut,
        minAmountOut: q.minAmountOut,
        feeBps: q.appFeeBps,
        gasUpperBoundYocto: ONE_CLICK_DEPOSIT_GAS * r.gasPriceYocto,
        settlement: 'async',
        ref: `correlation:${q.correlationId}`,
        detail: `dry quote, no deposit address; app fee ${q.appFeeBps} bps included; est. ${q.timeEstimateSeconds}s to settle`,
      };
    } catch (e) {
      return {
        venue: this.id,
        ok: false,
        quotedAt: r.now(),
        reason: `quote failed: ${errorMessage(e)}`,
      };
    }
  }
}

/** Current NEAR gas price (yoctoNEAR per gas unit), a read-only RPC call. */
export async function gasPrice(rpc: {
  call(method: string, params: unknown): Promise<unknown>;
}): Promise<bigint> {
  const r = z
    .object({ gas_price: z.string().regex(/^\d+$/) })
    .parse(await rpc.call('gas_price', [null]));
  return BigInt(r.gas_price);
}
