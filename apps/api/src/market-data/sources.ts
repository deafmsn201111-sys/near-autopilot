import { z } from 'zod';
import type { ReferenceAsset } from './assets';
import { compareDecimal, decimalFromJsonNumber, type Decimal } from './decimal';
import { MarketHttpError, type HttpJsonClient } from './http';
import type { ObservationStatus, PriceObservation, PriceSource, SourceResult } from './model';

export interface FreshnessRules {
  /** Older than this: `stale`. */
  readonly maxAgeMs: number;
  /** Further in the future than this: `future` (clock or data corruption). */
  readonly maxFutureSkewMs: number;
}

/** 401/403 means "not on our plan", not an outage: reported as such so nobody waits for it to come back. */
const statusOf = (e: unknown): ObservationStatus =>
  e instanceof MarketHttpError && e.kind === 'unauthorized' ? 'not_entitled' : 'unavailable';

const errorText = (e: unknown): string =>
  e instanceof MarketHttpError ? `${e.kind}: ${e.message}` : 'request failed';

function judge(
  price: Decimal | null,
  publishedAt: Date | null,
  now: Date,
  rules: FreshnessRules,
): { status: ObservationStatus; reason: string | null; ageMs: number | null } {
  if (!price || price.mantissa <= 0n)
    return { status: 'invalid', reason: 'price is missing, zero or negative', ageMs: null };
  if (!publishedAt || Number.isNaN(publishedAt.getTime()))
    return { status: 'invalid', reason: 'no valid timestamp', ageMs: null };
  const ageMs = now.getTime() - publishedAt.getTime();
  if (ageMs < -rules.maxFutureSkewMs)
    return {
      status: 'future',
      reason: `timestamped ${Math.round(-ageMs / 1000)}s in the future`,
      ageMs,
    };
  if (ageMs > rules.maxAgeMs)
    return {
      status: 'stale',
      reason: `${Math.round(ageMs / 1000)}s old (limit ${Math.round(rules.maxAgeMs / 1000)}s)`,
      ageMs,
    };
  return { status: 'valid', reason: null, ageMs };
}

const unavailable = (
  source: PriceObservation['source'],
  assetId: string,
  contract: string | null,
  now: Date,
  reason: string,
  status: ObservationStatus = 'unavailable',
): PriceObservation => ({
  source,
  network: 'mainnet',
  assetId,
  contract,
  priceUsd: null,
  quoteCurrency: 'USD',
  confidence: null,
  publishedAt: null,
  fetchedAt: now,
  ageMs: null,
  status,
  reason,
});

/* ------------------------------------------------------------------ Pyth ------------------------------------------------------------------ */

const pythFeedsSchema = z.array(
  z.object({
    id: z.string(),
    attributes: z
      .object({ symbol: z.string(), quote_currency: z.string().optional() })
      .passthrough(),
  }),
);

const pythLatestSchema = z.object({
  parsed: z.array(
    z.object({
      id: z.string(),
      price: z.object({
        price: z.string(),
        conf: z.string(),
        expo: z.number().int(),
        publish_time: z.number().int(),
      }),
    }),
  ),
});

export interface PythSourceOptions {
  readonly baseUrl: string;
  /** Hermes requires a key since Aug 2026. Without one the source reports itself unavailable and is not called. */
  readonly apiKey: string | undefined;
  readonly http: HttpJsonClient;
  readonly freshness?: FreshnessRules;
  /** Confidence interval wider than this share of the price (bps) -> `low_confidence`. */
  readonly maxConfidenceBps?: number;
}

/**
 * Pyth Hermes (mainnet price service). Feed ids are verified against the public `/v2/price_feeds` metadata before the
 * first use (id -> symbol, USD quote); prices come from `/v2/updates/price/latest` as exact integer + exponent.
 */
export class PythSource implements PriceSource {
  readonly name = 'pyth' as const;
  private verified: Map<string, string> | null = null;

  constructor(private readonly o: PythSourceOptions) {}

  private async verifyFeeds(assets: readonly ReferenceAsset[]): Promise<Map<string, string>> {
    if (this.verified) return this.verified;
    const symbols = new Map<string, string>();
    const bases = [
      ...new Set(assets.flatMap((a) => (a.pyth ? [a.pyth.symbol.split(/[./]/)[1] ?? ''] : []))),
    ];
    for (const base of bases) {
      const raw = await this.o.http.getJson(
        `${this.o.baseUrl}/v2/price_feeds?query=${encodeURIComponent(base)}&asset_type=crypto`,
      );
      const feeds = pythFeedsSchema.safeParse(raw);
      if (!feeds.success)
        throw new MarketHttpError('invalid_response', 'unexpected price_feeds shape', false);
      for (const f of feeds.data)
        if ((f.attributes.quote_currency ?? 'USD') === 'USD')
          symbols.set(f.id.toLowerCase(), f.attributes.symbol);
    }
    this.verified = symbols;
    return symbols;
  }

  async observe(assets: readonly ReferenceAsset[], now: Date): Promise<SourceResult> {
    const out = new Map<string, PriceObservation[]>();
    const feeds = assets.filter((a) => a.pyth);
    const fail = (
      reason: string,
      health: 'unavailable' | 'degraded' = 'unavailable',
      status: ObservationStatus = 'unavailable',
    ): SourceResult => {
      for (const a of feeds)
        out.set(a.testnetToken, [
          unavailable('pyth', a.pyth?.feedId ?? '', null, now, reason, status),
        ]);
      return { observations: out, status: { source: 'pyth', health, detail: reason } };
    };
    if (!this.o.apiKey)
      return fail('PYTH_API_KEY is not set (Hermes requires an API key since Aug 2026)');

    let known: Map<string, string>;
    try {
      known = await this.verifyFeeds(feeds);
    } catch (e) {
      return fail(`feed metadata: ${errorText(e)}`, 'unavailable', statusOf(e));
    }
    const ids = feeds.flatMap((a) => {
      const feed = a.pyth;
      if (!feed) return [];
      if (known.get(feed.feedId) !== feed.symbol) {
        out.set(a.testnetToken, [
          unavailable(
            'pyth',
            feed.feedId,
            null,
            now,
            `feed id is not ${feed.symbol} in Pyth metadata`,
            'mapping_mismatch',
          ),
        ]);
        return [];
      }
      return [feed.feedId];
    });
    if (ids.length === 0)
      return {
        observations: out,
        status: { source: 'pyth', health: 'degraded', detail: 'no verified feeds' },
      };

    // One request per feed: an entitlement covers feeds individually (e.g. stablecoins but not NEAR), so one refused
    // feed must not take the others down. The key travels only in the Authorization header, never in an error.
    const fetched = await Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await this.o.http.getJson(
            `${this.o.baseUrl}/v2/updates/price/latest?ids[]=${id}&parsed=true&encoding=hex`,
            { authorization: `Bearer ${this.o.apiKey}` },
          );
          const r = pythLatestSchema.safeParse(raw);
          if (!r.success)
            throw new MarketHttpError('invalid_response', 'unexpected price update shape', false);
          return { id, parsed: r.data.parsed, error: null, status: 'valid' as const };
        } catch (e) {
          return { id, parsed: [], error: errorText(e), status: statusOf(e) };
        }
      }),
    );
    for (const f of fetched) {
      if (!f.error) continue;
      const a = feeds.find((x) => x.pyth?.feedId === f.id);
      if (a) out.set(a.testnetToken, [unavailable('pyth', f.id, null, now, f.error, f.status)]);
    }
    if (fetched.every((f) => f.error))
      return {
        observations: out,
        status: { source: 'pyth', health: 'unavailable', detail: fetched[0]?.error ?? 'no feed' },
      };
    const parsed = { parsed: fetched.flatMap((f) => f.parsed) };
    const rules = this.o.freshness ?? { maxAgeMs: 60_000, maxFutureSkewMs: 5_000 };
    const maxConf = BigInt(this.o.maxConfidenceBps ?? 200);
    for (const a of feeds) {
      const feed = a.pyth;
      if (!feed || out.has(a.testnetToken)) continue;
      const p = parsed.parsed.find((x) => x.id.toLowerCase() === feed.feedId);
      if (!p) {
        out.set(a.testnetToken, [
          unavailable(
            'pyth',
            feed.feedId,
            null,
            now,
            'feed missing from the response',
            'not_found',
          ),
        ]);
        continue;
      }
      const price = /^-?\d+$/.test(p.price.price)
        ? { mantissa: BigInt(p.price.price), exponent: p.price.expo }
        : null;
      const conf = /^\d+$/.test(p.price.conf) ? BigInt(p.price.conf) : null;
      const publishedAt = new Date(p.price.publish_time * 1000);
      const judged = judge(price, publishedAt, now, rules);
      let { status, reason } = judged;
      const { ageMs } = judged;
      if (
        status === 'valid' &&
        price &&
        (conf === null || conf * 10_000n > price.mantissa * maxConf)
      ) {
        status = 'low_confidence';
        reason = `confidence interval wider than ${maxConf} bps of the price`;
      }
      out.set(a.testnetToken, [
        {
          source: 'pyth',
          network: 'mainnet',
          assetId: feed.feedId,
          contract: null,
          priceUsd: price,
          quoteCurrency: 'USD',
          confidence: conf === null ? null : `${conf}e${p.price.expo}`,
          publishedAt,
          fetchedAt: now,
          ageMs,
          status,
          reason,
        },
      ]);
    }
    const bad = [...out.values()].flat().filter((o) => o.status !== 'valid').length;
    return {
      observations: out,
      status: {
        source: 'pyth',
        health: bad === 0 ? 'ok' : 'degraded',
        detail: bad === 0 ? null : `${bad} feed(s) not valid`,
      },
    };
  }
}

/* ------------------------------------------------------------------ DefiLlama ------------------------------------------------------------------ */

const llamaPricesSchema = z.object({
  coins: z.record(
    z.object({
      price: z.number(),
      symbol: z.string(),
      timestamp: z.number(),
      confidence: z.number().optional(),
      decimals: z.number().int().optional(),
    }),
  ),
});

const llamaChartSchema = z.object({
  coins: z.record(
    z.object({ prices: z.array(z.object({ timestamp: z.number(), price: z.number() })) }),
  ),
});

export interface DefiLlamaSourceOptions {
  readonly baseUrl: string;
  readonly http: HttpJsonClient;
  readonly freshness?: FreshnessRules;
  /** DefiLlama's own 0..1 confidence score below this -> `low_confidence`. */
  readonly minConfidence?: number;
}

/** DefiLlama coins API (mainnet prices; no key). Each asset is looked up under every configured key. */
export class DefiLlamaSource implements PriceSource {
  readonly name = 'defillama' as const;

  constructor(private readonly o: DefiLlamaSourceOptions) {}

  async observe(assets: readonly ReferenceAsset[], now: Date): Promise<SourceResult> {
    const out = new Map<string, PriceObservation[]>();
    const keys = [...new Set(assets.flatMap((a) => a.defillama.map((k) => k.key)))];
    let coins: z.infer<typeof llamaPricesSchema>['coins'];
    try {
      const raw = await this.o.http.getJson(`${this.o.baseUrl}/prices/current/${keys.join(',')}`);
      const r = llamaPricesSchema.safeParse(raw);
      if (!r.success)
        throw new MarketHttpError('invalid_response', 'unexpected prices shape', false);
      coins = r.data.coins;
    } catch (e) {
      const reason = errorText(e);
      for (const a of assets)
        out.set(
          a.testnetToken,
          a.defillama.map((k) => unavailable('defillama', k.key, contractOf(k.key), now, reason)),
        );
      return {
        observations: out,
        status: { source: 'defillama', health: 'unavailable', detail: reason },
      };
    }
    const rules = this.o.freshness ?? { maxAgeMs: 300_000, maxFutureSkewMs: 5_000 };
    const minConf = this.o.minConfidence ?? 0.9;
    for (const a of assets) {
      out.set(
        a.testnetToken,
        a.defillama.map((k): PriceObservation => {
          const c = coins[k.key];
          if (!c)
            return unavailable(
              'defillama',
              k.key,
              contractOf(k.key),
              now,
              'no price for this key',
              'not_found',
            );
          const price = decimalFromJsonNumber(c.price);
          const publishedAt = new Date(c.timestamp * 1000);
          const judged = judge(price, publishedAt, now, rules);
          let { status, reason } = judged;
          const { ageMs } = judged;
          if (c.symbol.toUpperCase() !== k.symbol.toUpperCase()) {
            status = 'mapping_mismatch';
            reason = `symbol is ${c.symbol}, expected ${k.symbol}`;
          } else if (k.decimals !== null && c.decimals !== k.decimals) {
            status = 'mapping_mismatch';
            reason = `mainnet decimals ${c.decimals ?? 'unknown'}, expected ${k.decimals}`;
          } else if (status === 'valid' && (c.confidence === undefined || c.confidence < minConf)) {
            status = 'low_confidence';
            reason = `DefiLlama confidence ${c.confidence ?? 'missing'} < ${minConf}`;
          }
          return {
            source: 'defillama',
            network: 'mainnet',
            assetId: k.key,
            contract: contractOf(k.key),
            priceUsd: price,
            quoteCurrency: 'USD',
            confidence: c.confidence === undefined ? null : String(c.confidence),
            publishedAt,
            fetchedAt: now,
            ageMs,
            status,
            reason,
          };
        }),
      );
    }
    const missing = keys.filter((k) => !coins[k]).length;
    return {
      observations: out,
      status: {
        source: 'defillama',
        health: missing === 0 ? 'ok' : 'degraded',
        detail: missing === 0 ? null : `${missing} key(s) not found`,
      },
    };
  }

  /** 24h high-low range in bps of each key's hourly prices. Best effort: a failure just means "no volatility data". */
  async range24hBps(keys: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (keys.length === 0) return out;
    try {
      const raw = await this.o.http.getJson(
        `${this.o.baseUrl}/chart/${keys.join(',')}?span=25&period=1h`,
      );
      const r = llamaChartSchema.safeParse(raw);
      if (!r.success) return out;
      for (const [key, { prices }] of Object.entries(r.data.coins)) {
        const ds = prices
          .map((p) => decimalFromJsonNumber(p.price))
          .filter((d): d is Decimal => d !== null && d.mantissa > 0n);
        if (ds.length < 12) continue; // fewer than half the hours: not a 24h range
        const sorted = [...ds].sort(compareDecimal);
        const lo = sorted[0];
        const hi = sorted[sorted.length - 1];
        if (!lo || !hi) continue;
        const e = Math.min(lo.exponent, hi.exponent);
        const l = lo.mantissa * 10n ** BigInt(lo.exponent - e);
        const h = hi.mantissa * 10n ** BigInt(hi.exponent - e);
        out.set(key, Number(((h - l) * 10_000n) / l));
      }
    } catch {
      // no volatility data this cycle
    }
    return out;
  }
}

/** "near:wrap.near" -> "wrap.near"; "coingecko:near" -> null (not a contract). */
function contractOf(key: string): string | null {
  return key.startsWith('near:') ? key.slice('near:'.length) : null;
}
