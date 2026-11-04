import type { ReferenceAsset } from './assets';
import { deviationBps } from './decimal';
import {
  REFERENCE_LABEL,
  type AssetPrice,
  type MarketDataProvider,
  type MarketReport,
  type MarketReportSink,
  type PriceObservation,
  type PriceSource,
  type SourceStatus,
} from './model';
import type { DefiLlamaSource } from './sources';

/**
 * Combines the sources for one asset. Pure. Priority: the sources' order (Pyth first), then each source's own key
 * order. Rules, in order:
 *  1. testnet decimals differ from the mapping -> `unpriced` (the mapping is wrong for this token);
 *  2. no valid observation -> `unpriced`, with every source's reason;
 *  3. valid observations spread beyond the asset's limit -> `price_disputed`, no price;
 *  4. otherwise the highest-priority valid observation is the price; `corroborated` if two different providers
 *     are valid, else `single_source`.
 * Nothing else is tried: there is no further fallback and no default price.
 */
export function resolveAsset(
  asset: ReferenceAsset,
  observations: readonly PriceObservation[],
  testnetDecimals: number | null,
): AssetPrice {
  const base = {
    testnetToken: asset.testnetToken,
    referenceSymbol: asset.reference.symbol,
    mainnetContract: asset.reference.mainnetContract,
    observations,
    label: REFERENCE_LABEL,
  } as const;
  const none = { priceUsd: null, chosen: null, crossCheck: null } as const;
  if (testnetDecimals !== asset.testnetDecimals) {
    return {
      ...base,
      ...none,
      spreadBps: null,
      status: 'unpriced',
      reason:
        testnetDecimals === null
          ? 'testnet token metadata unavailable: mapping cannot be checked'
          : `testnet decimals ${testnetDecimals} differ from the mapping (${asset.testnetDecimals})`,
    };
  }
  const valid = observations.filter((o) => o.status === 'valid' && o.priceUsd !== null);
  if (valid.length === 0) {
    return {
      ...base,
      ...none,
      spreadBps: null,
      status: 'unpriced',
      reason:
        observations
          .map((o) => `${o.source} ${o.assetId}: ${o.status}${o.reason ? ` (${o.reason})` : ''}`)
          .join('; ') || 'no source',
    };
  }
  let spread = 0n;
  for (const a of valid)
    for (const b of valid) {
      if (a === b || !a.priceUsd || !b.priceUsd) continue;
      const d = deviationBps(a.priceUsd, b.priceUsd);
      if (d > spread) spread = d;
    }
  if (spread > BigInt(asset.maxDeviationBps)) {
    return {
      ...base,
      ...none,
      spreadBps: spread,
      status: 'price_disputed',
      reason: `valid sources differ by ${spread} bps (limit ${asset.maxDeviationBps}): excluded until reviewed`,
    };
  }
  const [chosen, ...rest] = valid;
  const crossCheck = rest.find((o) => o.source !== chosen?.source) ?? rest[0] ?? null;
  const providers = new Set(valid.map((o) => o.source));
  return {
    ...base,
    priceUsd: chosen?.priceUsd ?? null,
    chosen: chosen ?? null,
    crossCheck,
    spreadBps: valid.length > 1 ? spread : null,
    status: providers.size >= 2 ? 'corroborated' : 'single_source',
    reason:
      providers.size >= 2 ? null : `only ${chosen?.source ?? 'one source'} returned a valid price`,
  };
}

export interface ReferenceMarketDataOptions {
  readonly assets: readonly ReferenceAsset[];
  /** In priority order. */
  readonly sources: readonly PriceSource[];
  /** For the 24h range (volatility proxy). Optional. */
  readonly history?: Pick<DefiLlamaSource, 'range24hBps'>;
  /** Live testnet decimals of a token (ft_metadata), or null if unreadable. */
  readonly testnetDecimals: (token: string) => Promise<number | null>;
  readonly sink?: MarketReportSink;
  readonly now: () => Date;
  readonly ids: () => string;
  /** Reports are reused for this long, so one cycle sees one consistent set of prices. */
  readonly ttlMs?: number;
  readonly onError?: (message: string) => void;
}

/** The `MarketDataProvider`: mainnet market data, resolved per testnet asset. Agents never see a source directly. */
export class ReferenceMarketData implements MarketDataProvider {
  private cached: { at: number; value: Promise<MarketReport> } | null = null;

  constructor(private readonly o: ReferenceMarketDataOptions) {}

  report(): Promise<MarketReport> {
    const nowMs = this.o.now().getTime();
    if (this.cached && nowMs - this.cached.at < (this.o.ttlMs ?? 30_000)) return this.cached.value;
    const value = this.fetch();
    this.cached = { at: nowMs, value };
    value.catch(() => {
      if (this.cached?.value === value) this.cached = null;
    });
    return value;
  }

  private async fetch(): Promise<MarketReport> {
    const now = this.o.now();
    const { assets } = this.o;
    const results = await Promise.all(
      this.o.sources.map(async (s) => {
        try {
          return await s.observe(assets, now);
        } catch {
          // A source must never take the others down; it is reported, not silently dropped.
          const status: SourceStatus = {
            source: s.name,
            health: 'unavailable',
            detail: 'source failed',
          };
          return { observations: new Map<string, readonly PriceObservation[]>(), status };
        }
      }),
    );
    const decimals = await Promise.all(
      assets.map((a) => this.o.testnetDecimals(a.testnetToken).catch(() => null)),
    );
    const resolved = assets.map((a, i) =>
      resolveAsset(
        a,
        results.flatMap((r) => r.observations.get(a.testnetToken) ?? []),
        decimals[i] ?? null,
      ),
    );
    const keyOf = (a: AssetPrice) =>
      a.chosen?.source === 'defillama'
        ? a.chosen.assetId
        : a.observations.find((o) => o.source === 'defillama')?.assetId;
    const pricedKeys = resolved.filter((a) => a.priceUsd !== null).flatMap((a) => keyOf(a) ?? []);
    const byKey = (await this.o.history?.range24hBps(pricedKeys)) ?? new Map<string, number>();
    const range24hBps = new Map<string, number>();
    for (const a of resolved) {
      const key = keyOf(a);
      const v = key === undefined ? undefined : byKey.get(key);
      if (a.priceUsd !== null && v !== undefined) range24hBps.set(a.testnetToken, v);
    }
    const report: MarketReport = {
      id: this.o.ids(),
      fetchedAt: now,
      marketNetwork: 'mainnet',
      executionNetwork: 'testnet',
      assets: resolved,
      sources: results.map((r) => r.status),
      range24hBps,
    };
    if (this.o.sink) {
      try {
        await this.o.sink.record(report);
      } catch {
        this.o.onError?.('could not persist the market report');
      }
    }
    return report;
  }
}
