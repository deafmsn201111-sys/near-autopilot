import { z } from 'zod';
import { decimalFromJsonNumber } from '../market-data/decimal';
import type { HttpJsonClient } from '../market-data/http';
import { usable, type MarketReport, type PriceObservation } from '../market-data/model';
import type { TokenPrice } from './model';

const coinsSchema = z.object({
  coins: z.record(
    z.object({
      price: z.number(),
      symbol: z.string().optional(),
      timestamp: z.number(),
      confidence: z.number().optional(),
      decimals: z.number().int().optional(),
    }),
  ),
});

export interface LongTailRules {
  /** At or above this DefiLlama confidence a long-tail price is OK; below, LOW_CONFIDENCE (discovery only). */
  readonly okConfidence: number;
  /** Below this it is not used at all. */
  readonly minConfidence: number;
  /** Older than this (s) it is not used at all: long-tail tokens update rarely, so this is deliberately wide. */
  readonly maxAgeSeconds: number;
}

export const DEFAULT_LONG_TAIL: LongTailRules = {
  okConfidence: 0.9,
  minConfidence: 0.5,
  maxAgeSeconds: 6 * 3600,
};

export interface LongTailResult {
  readonly prices: Map<string, TokenPrice>;
  /** DefiLlama-reported decimals, to be checked against on-chain ft_metadata before use. */
  readonly reportedDecimals: Map<string, number>;
  readonly observations: PriceObservation[];
  readonly requests: number;
  readonly failures: number;
}

const BATCH = 100;

/** DefiLlama `near:<contract>` prices for many tokens, in batches. One failed batch only loses its own tokens. */
export async function longTailPrices(
  http: HttpJsonClient,
  baseUrl: string,
  tokens: readonly string[],
  now: Date,
  rules: LongTailRules = DEFAULT_LONG_TAIL,
  /**
   * When each answer ARRIVED. Ages are measured from it, not from the cycle start `now`: in a long cycle (a registry
   * scan) the batches are fetched tens of seconds after the start, and a fresh quote must not look "from the future".
   * Defaults to `now` (tests with a fixed clock).
   */
  receivedAt: () => Date = () => now,
): Promise<LongTailResult> {
  const prices = new Map<string, TokenPrice>();
  const reportedDecimals = new Map<string, number>();
  const observations: PriceObservation[] = [];
  let requests = 0;
  let failures = 0;
  for (let i = 0; i < tokens.length; i += BATCH) {
    const batch = tokens.slice(i, i + BATCH);
    requests += 1;
    let coins: z.infer<typeof coinsSchema>['coins'];
    try {
      const keys = batch.map((t) => encodeURIComponent(`near:${t}`)).join(',');
      coins = coinsSchema.parse(await http.getJson(`${baseUrl}/prices/current/${keys}`)).coins;
    } catch {
      failures += 1;
      continue;
    }
    const at = receivedAt();
    for (const token of batch) {
      const c = coins[`near:${token}`];
      if (!c) continue;
      const usd = decimalFromJsonNumber(c.price);
      const publishedAt = new Date(c.timestamp * 1000);
      const ageMs = at.getTime() - publishedAt.getTime();
      const conf = c.confidence ?? 0;
      let status: PriceObservation['status'] = 'valid';
      let reason: string | null = null;
      if (!usd || usd.mantissa <= 0n) [status, reason] = ['invalid', 'non-positive price'];
      else if (ageMs > rules.maxAgeSeconds * 1000)
        [status, reason] = ['stale', `older than ${rules.maxAgeSeconds} s`];
      else if (ageMs < -5_000) [status, reason] = ['future', 'timestamp in the future'];
      else if (conf < rules.minConfidence)
        [status, reason] = ['low_confidence', `confidence ${conf}`];
      observations.push({
        source: 'defillama',
        network: 'mainnet',
        assetId: `near:${token}`,
        contract: token,
        priceUsd: usd,
        quoteCurrency: 'USD',
        confidence: String(conf),
        publishedAt,
        fetchedAt: at,
        ageMs,
        status,
        reason,
      });
      if (status !== 'valid' || !usd) continue;
      if (c.decimals !== undefined) reportedDecimals.set(token, c.decimals);
      prices.set(token, {
        usd,
        quality: conf >= rules.okConfidence ? 'OK' : 'LOW_CONFIDENCE',
        source: 'defillama',
        sourceAssetId: `near:${token}`,
      });
    }
  }
  return { prices, reportedDecimals, observations, requests, failures };
}

/** Curated prices (Pyth first, DefiLlama coingecko second, cross-checked): OK whenever usable. They override long tail. */
export function curatedPrices(report: MarketReport): Map<string, TokenPrice> {
  const out = new Map<string, TokenPrice>();
  for (const a of report.assets) {
    if (!usable(a) || !a.priceUsd || !a.chosen) continue;
    out.set(a.testnetToken, {
      usd: a.priceUsd,
      quality: 'OK',
      source: a.chosen.source,
      sourceAssetId: a.chosen.assetId,
    });
  }
  return out;
}
