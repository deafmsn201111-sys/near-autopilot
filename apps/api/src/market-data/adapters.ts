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
import { toWad } from '../yield/math';
import { isStrategic, type YieldDataProvider, type YieldReport } from '../yield/model';

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

/** Per-token yields for the Capital Allocator (valid Burrow supply rates only) and why the others are missing. */
export function yieldContext(
  report: YieldReport,
  tokens: readonly TokenId[],
): {
  estimatedYieldWad: Map<TokenId, bigint>;
  yieldNotes: Map<TokenId, string>;
  lpNote: string;
  asOf: Date | null;
} {
  const estimatedYieldWad = new Map<TokenId, bigint>();
  const yieldNotes = new Map<TokenId, string>();
  const burrow = report.sources.find((s) => s.source === 'burrow');
  for (const token of tokens) {
    const supply = report.estimates.find(
      (e) => e.source === 'burrow' && e.yieldType === 'lending_supply' && e.marketId === token,
    );
    if (supply && isStrategic(supply) && supply.apr) {
      estimatedYieldWad.set(token, toWad(supply.apr));
    } else if (supply) {
      yieldNotes.set(token, supply.reasons.map((r) => `${r.code}: ${r.detail}`).join('; '));
    } else {
      yieldNotes.set(
        token,
        burrow?.health === 'ok'
          ? 'MISSING_YIELD_DATA: Burrow does not list this token'
          : `SOURCE_UNAVAILABLE: burrow ${burrow?.detail ?? 'not read'}`,
      );
    }
  }
  const lp = report.estimates.filter((e) => e.yieldType === 'lp_fee');
  const usableLp = lp.filter((e) => e.validationStatus === 'valid');
  const codes = [...new Set(lp.flatMap((e) => e.reasons.map((r) => r.code)))];
  const lpSources = report.sources
    .filter((s) => s.source !== 'burrow' && s.health !== 'ok')
    .map((s) => `${s.source} ${s.health}${s.detail ? ` (${s.detail})` : ''}`);
  const lpNote =
    `${lp.length} pool(s) observed, ${usableLp.length} usable` +
    (codes.length > 0 ? `; rejected: ${codes.join(', ')}` : '') +
    (lpSources.length > 0 ? `; ${lpSources.join('; ')}` : '');
  return { estimatedYieldWad, yieldNotes, lpNote, asOf: report.block?.timestamp ?? null };
}

/**
 * The orchestrator's market context. `referencePrices` are the CROSS-CHECK observations (a lower-priority source), so
 * Market Intelligence compares two sources rather than a price with itself. Yields, when a yield provider is given,
 * are the VALID Burrow supply rates of the allocation tokens (testnet, one pinned block); every other token carries a
 * reason. No LP positions are read for the account, so the LP Optimizer has nothing to re-centre.
 */
export class ReferenceMarketProvider implements MarketProvider {
  constructor(
    private readonly market: MarketDataProvider,
    private readonly yields: YieldDataProvider | null = null,
    private readonly yieldTokens: readonly TokenId[] = [],
  ) {}

  async get(): Promise<MarketContext | null> {
    const report = await this.market.report();
    const yieldReport = this.yields ? await this.yields.report() : null;
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
    const y = yieldReport ? yieldContext(yieldReport, this.yieldTokens) : null;
    const pricesAt = pricesAsOf(report, used);
    // The context is as old as its oldest input: the data guard then judges prices and yields together.
    const asOf = y?.asOf && y.asOf < pricesAt ? y.asOf : pricesAt;
    return {
      asOf,
      estimatedYieldWad: y?.estimatedYieldWad ?? new Map(),
      referencePrices,
      volatility24hBps,
      lpPositions: [],
      notes: y ? { yield: y.yieldNotes, lp: y.lpNote } : { lp: 'no yield source configured' },
      provenance: {
        marketReportId: report.id,
        ...(yieldReport ? { yieldReportId: yieldReport.id } : {}),
      },
    };
  }
}
