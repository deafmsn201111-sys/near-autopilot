import type { ReferenceAsset } from './assets';
import { compareDecimal, deviationBps } from './decimal';
import { mul, truncate } from '../yield/math';
import {
  MAINNET_PRICE_LABEL,
  type AssetPrice,
  type MarketDataProvider,
  type MarketReport,
  type MarketReportSink,
  type PriceObservation,
  type PriceLabel,
  type PriceSource,
  type SourceStatus,
} from './model';
import type { DefiLlamaSource } from './sources';

/**
 * Combines the sources for one asset. Pure. Priority: the sources' order (Pyth first), then each source's own key
 * order. Rules, in order:
 *  1. token decimals differ from the mapping -> `unpriced` (the mapping is wrong for this token);
 *  2. no valid observation -> `unpriced`, with every source's reason;
 *  3. valid observations spread beyond the asset's limit -> `price_disputed`, no price;
 *  4. otherwise the highest-priority valid observation is the price; `corroborated` if two different providers
 *     are valid, else `single_source`.
 * Nothing else is tried: there is no further fallback and no default price.
 */
export function resolveAsset(
  asset: ReferenceAsset,
  observations: readonly PriceObservation[],
  decimals: number | null,
  label: PriceLabel = MAINNET_PRICE_LABEL,
): AssetPrice {
  const base = {
    token: asset.token,
    referenceSymbol: asset.reference.symbol,
    mainnetContract: asset.reference.mainnetContract,
    observations,
    label,
  } as const;
  const none = { priceUsd: null, chosen: null, crossCheck: null } as const;
  if (decimals !== asset.decimals) {
    return {
      ...base,
      ...none,
      spreadBps: null,
      status: 'unpriced',
      reason:
        decimals === null
          ? 'token metadata unavailable: mapping cannot be checked'
          : `token decimals ${decimals} differ from the mapping (${asset.decimals})`,
    };
  }
  // Only USD quotes are comparable; a USDT quote must have gone through convertQuotes first.
  const valid = observations.filter(
    (o) => o.status === 'valid' && o.priceUsd !== null && o.quoteCurrency === 'USD',
  );
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
  if (asset.quorum) return resolveQuorum(asset, valid, base);
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

const maxSpread = (xs: readonly PriceObservation[]): bigint => {
  let spread = 0n;
  for (const a of xs)
    for (const b of xs) {
      if (a === b || !a.priceUsd || !b.priceUsd) continue;
      const d = deviationBps(a.priceUsd, b.priceUsd);
      if (d > spread) spread = d;
    }
  return spread;
};

/**
 * Quorum resolution (NEAR): one observation per provider (its highest-priority valid key), the median of those, and
 * every provider within `quorum.maxDeviationBps` of the median agrees. At least `quorum.min` agreeing providers:
 * `corroborated`, priced at the median observation (a real observation, never an average). Fewer: no price —
 * `price_disputed` if enough providers answered but disagree, else `unpriced`. There is no single-source fallback.
 */
function resolveQuorum(
  asset: ReferenceAsset,
  valid: readonly PriceObservation[],
  base: Pick<
    AssetPrice,
    'token' | 'referenceSymbol' | 'mainnetContract' | 'observations' | 'label'
  >,
): AssetPrice {
  const q = asset.quorum ?? { min: 2, maxDeviationBps: asset.maxDeviationBps };
  const none = { priceUsd: null, chosen: null, crossCheck: null } as const;
  const perProvider: PriceObservation[] = [];
  for (const o of valid)
    if (o.priceUsd && o.quoteCurrency === 'USD' && !perProvider.some((x) => x.source === o.source))
      perProvider.push(o);
  if (perProvider.length < q.min)
    return {
      ...base,
      ...none,
      spreadBps: perProvider.length > 1 ? maxSpread(perProvider) : null,
      status: 'unpriced',
      reason: `quorum not met: ${perProvider.length} of ${q.min} required providers valid (${
        perProvider.map((o) => o.source).join(', ') || 'none'
      })`,
    };
  const sorted = [...perProvider].sort((a, b) =>
    a.priceUsd && b.priceUsd ? compareDecimal(a.priceUsd, b.priceUsd) : 0,
  );
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const agree = sorted.filter(
    (o) =>
      median?.priceUsd &&
      o.priceUsd &&
      deviationBps(o.priceUsd, median.priceUsd) <= BigInt(q.maxDeviationBps),
  );
  const outliers = sorted.filter((o) => !agree.includes(o));
  const outlierText = outliers
    .map(
      (o) =>
        `${o.source} ${o.priceUsd && median?.priceUsd ? deviationBps(o.priceUsd, median.priceUsd) : '?'} bps`,
    )
    .join(', ');
  if (agree.length < q.min || !median)
    return {
      ...base,
      ...none,
      spreadBps: maxSpread(sorted),
      status: 'price_disputed',
      reason: `quorum not met: ${agree.length} of ${q.min} providers within ${q.maxDeviationBps} bps of the median (${outlierText}): excluded until reviewed`,
    };
  return {
    ...base,
    priceUsd: median.priceUsd,
    chosen: median,
    crossCheck: agree.find((o) => o !== median) ?? null,
    spreadBps: maxSpread(agree),
    status: 'corroborated',
    reason:
      outliers.length > 0
        ? `quorum ${agree.length}/${sorted.length}; outliers excluded: ${outlierText}`
        : null,
  };
}

/**
 * Converts USDT-quoted observations to USD with a corroborated USDT/USD price (never a single-source one). The
 * converted observation keeps its own status, takes the OLDER of the two timestamps, and names the conversion in its
 * asset id. Without a usable USDT price the observation becomes `unavailable`: nothing is assumed to be 1.00.
 */
export function convertQuotes(
  observations: readonly PriceObservation[],
  usdt: AssetPrice | null,
  now: Date,
): PriceObservation[] {
  return observations.map((o) => {
    if (o.quoteCurrency !== 'USDT') return o;
    const rate = usdt?.status === 'corroborated' ? usdt.priceUsd : null;
    if (!rate || !usdt?.chosen)
      return {
        ...o,
        priceUsd: null,
        quoteCurrency: 'USD',
        status: o.status === 'valid' ? 'unavailable' : o.status,
        reason: o.reason ?? 'no corroborated USDT/USD price to convert the USDT quote',
      };
    const times = [o.publishedAt, usdt.chosen.publishedAt].flatMap((d) =>
      d && !Number.isNaN(d.getTime()) ? [d.getTime()] : [],
    );
    const publishedAt = times.length === 2 ? new Date(Math.min(...times)) : o.publishedAt;
    return {
      ...o,
      assetId: `${o.assetId}×USDT/USD(${usdt.chosen.source})`,
      priceUsd: o.priceUsd ? truncate(mul(o.priceUsd, rate)) : null,
      quoteCurrency: 'USD',
      publishedAt,
      ageMs: publishedAt ? now.getTime() - publishedAt.getTime() : o.ageMs,
    };
  });
}

export interface ReferenceMarketDataOptions {
  readonly assets: readonly ReferenceAsset[];
  /** In priority order. */
  readonly sources: readonly PriceSource[];
  /** For the 24h range (volatility proxy). Optional. */
  readonly history?: Pick<DefiLlamaSource, 'range24hBps'>;
  /** Live decimals of a token (ft_metadata), or null if unreadable. */
  readonly tokenDecimals: (token: string) => Promise<number | null>;
  readonly sink?: MarketReportSink;
  readonly now: () => Date;
  readonly ids: () => string;
  /** Reports are reused for this long, so one cycle sees one consistent set of prices. */
  readonly ttlMs?: number;
  readonly onError?: (message: string) => void;
}

/** The `MarketDataProvider`: mainnet market data, resolved per asset. Agents never see a source directly. */
export class ReferenceMarketData implements MarketDataProvider {
  private cached: { at: number; value: Promise<MarketReport> } | null = null;

  constructor(private readonly o: ReferenceMarketDataOptions) {}

  private last: MarketReport | null = null;

  report(): Promise<MarketReport> {
    const nowMs = this.o.now().getTime();
    if (this.cached && nowMs - this.cached.at < (this.o.ttlMs ?? 30_000)) return this.cached.value;
    const value = this.fetch();
    this.cached = { at: nowMs, value };
    value.then(
      (r) => {
        this.last = r;
      },
      () => {
        if (this.cached?.value === value) this.cached = null;
      },
    );
    return value;
  }

  /** The last report built, without fetching (page views must not create observations). */
  latest(): MarketReport | null {
    return this.last;
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
      assets.map((a) => this.o.tokenDecimals(a.token).catch(() => null)),
    );
    const label = MAINNET_PRICE_LABEL;
    const raw = (a: ReferenceAsset) => results.flatMap((r) => r.observations.get(a.token) ?? []);
    // USDT/USD first (it never needs a conversion itself), then everything with its USDT quotes converted.
    const usdtIndex = assets.findIndex((a) => a.convertsQuote === 'USDT');
    const usdtAsset = usdtIndex >= 0 ? assets[usdtIndex] : undefined;
    const usdt = usdtAsset
      ? resolveAsset(usdtAsset, raw(usdtAsset), decimals[usdtIndex] ?? null, label)
      : null;
    const resolved = assets.map((a, i) =>
      resolveAsset(a, convertQuotes(raw(a), usdt, now), decimals[i] ?? null, label),
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
      if (a.priceUsd !== null && v !== undefined) range24hBps.set(a.token, v);
    }
    const report: MarketReport = {
      id: this.o.ids(),
      fetchedAt: now,
      marketNetwork: 'mainnet',
      executionNetwork: 'none',
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
