import {
  accountIdSchema,
  type PriceMap,
  type PriceOracle,
  type TokenId,
  type UnitPrice,
} from '@near-autopilot/core';
import type { MarketContext, MarketProvider } from '@near-autopilot/orchestrator';
import { referenceAssetFor } from './assets';
import { toUnitPrice } from './decimal';
import { usable, type AssetPrice, type MarketDataProvider, type MarketReport } from './model';

function unitPrice(a: AssetPrice, which: 'chosen' | 'crossCheck'): UnitPrice | null {
  const asset = referenceAssetFor(a.testnetToken);
  const price = which === 'chosen' ? a.priceUsd : a.crossCheck?.priceUsd;
  if (!asset || !price || !usable(a)) return null;
  return toUnitPrice(price, asset.testnetDecimals);
}

/** Oldest publish time among the prices actually used; the report time if none is used. */
function pricesAsOf(report: MarketReport, assets: readonly AssetPrice[]): Date {
  const times = assets.flatMap((a) =>
    a.chosen?.publishedAt ? [a.chosen.publishedAt.getTime()] : [],
  );
  return new Date(times.length > 0 ? Math.min(...times) : report.fetchedAt.getTime());
}

/**
 * Snapshot prices for TESTNET tokens from MAINNET reference data (testnet profile only, see packages/config). Only
 * `corroborated` and `single_source` assets are priced; disputed and unpriced ones are absent, so every caller
 * fails closed exactly as it does for an oracle without a price.
 */
export class ReferencePriceOracle implements PriceOracle {
  constructor(private readonly market: MarketDataProvider) {}

  async getPrices(tokens: readonly TokenId[]): Promise<{ prices: PriceMap; asOf: Date }> {
    const report = await this.market.report();
    const prices = new Map<TokenId, UnitPrice>();
    const used: AssetPrice[] = [];
    for (const token of tokens) {
      const a = report.assets.find((x) => x.testnetToken === token);
      const p = a ? unitPrice(a, 'chosen') : null;
      if (a && p) {
        prices.set(token, p);
        used.push(a);
      }
    }
    return { prices, asOf: pricesAsOf(report, used) };
  }
}

/**
 * The orchestrator's market context. `referencePrices` are the CROSS-CHECK observations (a lower-priority source), so
 * Market Intelligence compares two sources rather than a price with itself. No yield source exists: allocation stays
 * `insufficient_data`. No LP positions are read for the account.
 */
export class ReferenceMarketProvider implements MarketProvider {
  constructor(private readonly market: MarketDataProvider) {}

  async get(): Promise<MarketContext | null> {
    const report = await this.market.report();
    const used = report.assets.filter(usable);
    if (used.length === 0) return null;
    const referencePrices = new Map<TokenId, UnitPrice>();
    const volatility24hBps = new Map<TokenId, number>();
    for (const a of used) {
      const token = accountIdSchema.parse(a.testnetToken);
      const p = unitPrice(a, 'crossCheck');
      if (p) referencePrices.set(token, p);
      const v = report.range24hBps.get(a.testnetToken);
      if (v !== undefined) volatility24hBps.set(token, v);
    }
    return {
      asOf: pricesAsOf(report, used),
      estimatedYieldWad: new Map(),
      referencePrices,
      volatility24hBps,
      lpPositions: [],
    };
  }
}
