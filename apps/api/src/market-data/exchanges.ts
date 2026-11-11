import { z } from 'zod';
import type { ExchangeMarket, ReferenceAsset } from './assets';
import { parseDecimal, type Decimal } from './decimal';
import { failureKind } from '../public-text';
import { MarketHttpError, type HttpJsonClient } from './http';
import type {
  ExchangeName,
  ObservationStatus,
  PriceObservation,
  PriceSource,
  SourceResult,
} from './model';
import type { FreshnessRules } from './sources';

/**
 * Public exchange market data (no key, read-only GETs): the LAST TRADE of one market, as the exchange wrote it (exact
 * decimal string) with the trade's own timestamp. Freshness is judged on the trade time, not on the fetch time.
 */
export interface LastTrade {
  readonly price: Decimal | null;
  readonly at: Date | null;
}

const coinbaseTicker = z.object({ price: z.string(), time: z.string() }).passthrough();
// Kraken: result[pair] = [[price, volume, time(s, float), side, type, misc, id], ...] oldest first; plus "last".
const krakenTrades = z.object({
  error: z.array(z.string()),
  result: z.record(z.unknown()).optional(),
});
const krakenRow = z.tuple([z.string(), z.string(), z.number()]).rest(z.unknown());
const binanceTrades = z.array(z.object({ price: z.string(), time: z.number() }).passthrough());

export async function fetchLastTrade(
  http: HttpJsonClient,
  baseUrl: string,
  m: ExchangeMarket,
): Promise<LastTrade> {
  const bad = (what: string) => new MarketHttpError('invalid_response', what, false);
  if (m.source === 'coinbase') {
    const r = coinbaseTicker.safeParse(
      await http.getJson(`${baseUrl}/products/${encodeURIComponent(m.symbol)}/ticker`),
    );
    if (!r.success) throw bad('unexpected Coinbase ticker shape');
    return { price: parseDecimal(r.data.price), at: new Date(r.data.time) };
  }
  if (m.source === 'kraken') {
    const r = krakenTrades.safeParse(
      await http.getJson(`${baseUrl}/0/public/Trades?pair=${encodeURIComponent(m.symbol)}&count=5`),
    );
    if (!r.success || r.data.error.length > 0 || !r.data.result)
      throw bad(r.success ? `Kraken error: ${r.data.error.join(', ')}` : 'unexpected Kraken shape');
    const pairs = Object.entries(r.data.result).filter(([k]) => k !== 'last');
    // Exactly one pair was asked for; Kraken may rename it (e.g. XXBTZUSD), never return two.
    if (pairs.length !== 1) throw bad('Kraken returned no or several pairs');
    const rows = z.array(krakenRow).safeParse(pairs[0]?.[1]);
    if (!rows.success || rows.data.length === 0) throw bad('Kraken returned no trades');
    const latest = rows.data.reduce((a, b) => (b[2] > a[2] ? b : a));
    return { price: parseDecimal(latest[0]), at: new Date(Math.round(latest[2] * 1000)) };
  }
  const r = binanceTrades.safeParse(
    await http.getJson(`${baseUrl}/api/v3/trades?symbol=${encodeURIComponent(m.symbol)}&limit=1`),
  );
  if (!r.success || r.data.length === 0) throw bad('unexpected Binance trades shape');
  const t = r.data[r.data.length - 1];
  return { price: t ? parseDecimal(t.price) : null, at: t ? new Date(t.time) : null };
}

function judgeTrade(
  t: LastTrade,
  now: Date,
  rules: FreshnessRules,
): { status: ObservationStatus; reason: string | null; ageMs: number | null } {
  if (!t.price || t.price.mantissa <= 0n)
    return { status: 'invalid', reason: 'price is missing, zero or negative', ageMs: null };
  if (!t.at || Number.isNaN(t.at.getTime()))
    return { status: 'invalid', reason: 'no valid trade time', ageMs: null };
  const ageMs = now.getTime() - t.at.getTime();
  if (ageMs < -rules.maxFutureSkewMs)
    return {
      status: 'future',
      reason: `trade timestamped ${Math.round(-ageMs / 1000)}s in the future`,
      ageMs,
    };
  if (ageMs > rules.maxAgeMs)
    return {
      status: 'stale',
      reason: `last trade ${Math.round(ageMs / 1000)}s old (limit ${Math.round(rules.maxAgeMs / 1000)}s)`,
      ageMs,
    };
  return { status: 'valid', reason: null, ageMs };
}

export interface ExchangeSourceOptions {
  readonly name: ExchangeName;
  readonly baseUrl: string;
  readonly http: HttpJsonClient;
  readonly freshness?: FreshnessRules;
}

/** One exchange as a `PriceSource`. Assets without a market on this exchange get no observation from it. */
export class ExchangeSource implements PriceSource {
  readonly name: ExchangeName;

  constructor(private readonly o: ExchangeSourceOptions) {
    this.name = o.name;
  }

  async observe(assets: readonly ReferenceAsset[], now: Date): Promise<SourceResult> {
    const out = new Map<string, PriceObservation[]>();
    const rules = this.o.freshness ?? { maxAgeMs: 180_000, maxFutureSkewMs: 5_000 };
    const markets = assets.flatMap((a) =>
      (a.exchanges ?? []).filter((m) => m.source === this.name).map((m) => ({ a, m })),
    );
    let bad = 0;
    let failed = 0;
    for (const { a, m } of markets) {
      const assetId = `${this.name}:${m.symbol}`;
      let obs: PriceObservation;
      try {
        const t = await fetchLastTrade(this.o.http, this.o.baseUrl, m);
        const j = judgeTrade(t, now, rules);
        obs = {
          source: this.name,
          network: 'mainnet',
          assetId,
          contract: null,
          priceUsd: t.price,
          quoteCurrency: m.quote,
          confidence: null,
          publishedAt: t.at,
          fetchedAt: now,
          ageMs: j.ageMs,
          status: j.status,
          reason: j.reason,
        };
      } catch (e) {
        failed += 1;
        obs = {
          source: this.name,
          network: 'mainnet',
          assetId,
          contract: null,
          priceUsd: null,
          quoteCurrency: m.quote,
          confidence: null,
          publishedAt: null,
          fetchedAt: now,
          ageMs: null,
          status: 'unavailable',
          reason: e instanceof MarketHttpError ? failureKind(e) : 'request failed',
        };
      }
      if (obs.status !== 'valid') bad += 1;
      out.set(a.token, [...(out.get(a.token) ?? []), obs]);
    }
    const health =
      markets.length > 0 && failed === markets.length ? 'unavailable' : bad > 0 ? 'degraded' : 'ok';
    return {
      observations: out,
      status: {
        source: this.name,
        health,
        detail: bad === 0 ? null : `${bad} of ${markets.length} market(s) not valid`,
      },
    };
  }
}
