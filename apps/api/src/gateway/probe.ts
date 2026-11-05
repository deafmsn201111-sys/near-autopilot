import type { ApiEnv } from '@near-autopilot/config';
import {
  accountIdSchema,
  errorMessage,
  type ContractViewer,
  type Logger,
  type TokenId,
} from '@near-autopilot/core';
import { rawForValueUsd } from '@near-autopilot/financial-engine';
import { StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import type { AutopilotConfig } from '../autopilot-config';
import { ReferencePriceOracle } from '../market-data/adapters';
import { HttpJsonClient } from '../market-data/http';
import type { MarketReport } from '../market-data/model';
import type { AutopilotRepository } from '../repository';
import { OneClickClient } from './one-click';
import { routeSwap, type RouteDeps } from './shadow-gateway';
import { gasPrice, OneClickVenue, RheaVenue, type Venue } from './venues';

/**
 * REFERENCE ROUTE PROBE (shadow collector, read-only): the same venue comparison the gateway makes, for fixed-size
 * reference trades, so the Rhea vs NEAR Intents record does not depend on an agent happening to propose a swap.
 * Quotes only: a Rhea view call and a 1Click DRY quote per size. Stored with origin `probe`.
 */
export interface RouteProbeDeps extends RouteDeps {
  readonly repo: Pick<AutopilotRepository, 'insertExecutionRoute'>;
  readonly ids: () => string;
  readonly tokenIn: TokenId;
  readonly tokenOut: TokenId;
  /** Reference sizes in whole USD of the input token. */
  readonly sizesUsd: readonly number[];
}

export async function probeRoutes(
  d: RouteProbeDeps,
): Promise<{ records: number; detail: string; degraded: boolean }> {
  const { prices } = await d.prices.getPrices([d.tokenIn]);
  const priceIn = prices.get(d.tokenIn);
  if (!priceIn) throw new Error(`no usable price for ${d.tokenIn}: reference sizes cannot be set`);
  const parts: string[] = [];
  let routed = 0;
  let stored = 0;
  // One size at a time: 1Click answers slowly, and the probe must not burst its public endpoint.
  for (const usd of d.sizesUsd) {
    try {
      const amountIn = rawForValueUsd(BigInt(Math.round(usd * 1_000_000)), priceIn);
      const route = await routeSwap(d, { tokenIn: d.tokenIn, tokenOut: d.tokenOut, amountIn });
      await d.repo.insertExecutionRoute({
        id: d.ids(),
        createdAt: d.clock.now(),
        origin: 'probe',
        decisionId: null,
        intentId: null,
        planHash: null,
        ...route,
      });
      stored += 1;
      if (route.chosenVenue) routed += 1;
      parts.push(`$${usd}: ${route.chosenVenue ?? 'none'}`);
    } catch (e) {
      parts.push(`$${usd}: failed (${errorMessage(e)})`);
    }
  }
  return { records: stored, detail: parts.join('; '), degraded: routed < d.sizesUsd.length };
}

/**
 * The collector's probe for one cycle: Rhea quoted through the cycle's BLOCK-PINNED viewer, prices from the cycle's
 * own market report, so the record lines up with everything else stored for that snapshot.
 */
export function collectorRouteProbe(o: {
  readonly env: Pick<
    ApiEnv,
    'RHEA_CONTRACT_ID' | 'ONE_CLICK_URL' | 'ONE_CLICK_QUOTE_ACCOUNT' | 'AUTOPILOT_ACCOUNT_ID'
  >;
  readonly config: AutopilotConfig;
  readonly repo: Pick<AutopilotRepository, 'insertExecutionRoute'>;
  readonly logger: Logger;
  readonly ids: () => string;
  readonly now: () => Date;
  readonly sizesUsd?: readonly number[];
  readonly fetchImpl?: typeof fetch;
}) {
  const pool = o.config.rhea.pools[0];
  const oneClick =
    o.env.ONE_CLICK_URL === ''
      ? null
      : new OneClickVenue(
          new OneClickClient({
            http: new HttpJsonClient({
              fetchImpl: o.fetchImpl,
              timeoutMs: 30_000,
              maxRetries: 1,
              maxConcurrent: 1,
            }),
            baseUrl: o.env.ONE_CLICK_URL,
          }),
        );
  return async (
    market: MarketReport,
    viewer: ContractViewer,
    rpc: { call(method: string, params: unknown): Promise<unknown> },
  ) => {
    if (!pool) throw new Error('no Rhea pool configured (config.rhea.pools)');
    const venues: Venue[] = [
      new RheaVenue(viewer, {
        contractId: o.env.RHEA_CONTRACT_ID,
        pools: new StaticPoolRegistry(o.config.rhea.pools),
      }),
      ...(oneClick ? [oneClick] : []),
    ];
    return probeRoutes({
      venues,
      prices: new ReferencePriceOracle({ report: async () => market, latest: () => market }),
      gasPrice: () => gasPrice(rpc),
      nearToken: accountIdSchema.parse('wrap.near'),
      account: o.env.ONE_CLICK_QUOTE_ACCOUNT ?? o.env.AUTOPILOT_ACCOUNT_ID,
      limits: {
        maxQuoteAgeSeconds: o.config.policy.maxPriceAgeSeconds,
        maxOracleDeviationBps: o.config.policy.maxOracleDeviationBps,
        slippageBps: o.config.policy.maxSlippageBps,
      },
      clock: { now: o.now },
      logger: o.logger,
      repo: o.repo,
      ids: o.ids,
      tokenIn: pool.tokenA,
      tokenOut: pool.tokenB,
      sizesUsd: o.sizesUsd ?? [10, 100],
    });
  };
}
