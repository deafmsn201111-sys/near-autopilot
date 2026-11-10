import type { MarketDataDto } from '@near-autopilot/core';
import { formatDecimal } from './decimal';
import { SHADOW_FLOW_LABEL, type MarketDataProvider } from './model';
import { observationJson } from './store';

const disabledView = (executionNetwork: 'mainnet'): MarketDataDto => ({
  enabled: false,
  flow: SHADOW_FLOW_LABEL,
  marketNetwork: 'mainnet',
  executionNetwork,
  fetchedAt: null,
  sources: [],
  assets: [],
  error: null,
});

/** Read-only view of the current market report for the API (the same cached report the cycle uses). */
export function marketDataView(
  market: MarketDataProvider | null,
  executionNetwork: 'mainnet',
): { current(): Promise<MarketDataDto> } {
  return {
    async current() {
      if (!market) return disabledView(executionNetwork);
      try {
        // Read-only: the last report a cycle or the collector built; a page view never fetches prices.
        const r = market.latest ? market.latest() : await market.report();
        if (!r)
          return {
            ...disabledView(executionNetwork),
            enabled: true,
            error: 'no market report yet: run a cycle (or wait for the collector)',
          };
        return {
          enabled: true,
          flow: SHADOW_FLOW_LABEL,
          marketNetwork: r.marketNetwork,
          executionNetwork: r.executionNetwork,
          fetchedAt: r.fetchedAt.toISOString(),
          sources: r.sources.map((s) => ({ ...s })),
          assets: r.assets.map((a) => ({
            token: a.token,
            referenceSymbol: a.referenceSymbol,
            mainnetContract: a.mainnetContract,
            status: a.status,
            priceUsd: a.priceUsd ? formatDecimal(a.priceUsd) : null,
            source: a.chosen?.source ?? null,
            sourceAssetId: a.chosen?.assetId ?? null,
            publishedAt: a.chosen?.publishedAt?.toISOString() ?? null,
            ageMs: a.chosen?.ageMs ?? null,
            spreadBps: a.spreadBps === null ? null : Number(a.spreadBps),
            range24hBps: r.range24hBps.get(a.token) ?? null,
            reason: a.reason,
            label: a.label,
            observations: a.observations.map(observationJson),
          })),
          error: null,
        };
      } catch {
        return {
          ...disabledView(executionNetwork),
          enabled: true,
          error: 'market data could not be fetched',
        };
      }
    },
  };
}
