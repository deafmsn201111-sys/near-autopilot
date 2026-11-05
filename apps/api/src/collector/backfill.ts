import type { AccountId } from '@near-autopilot/core';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { z } from 'zod';
import { decimalFromJsonNumber, deviationBps, formatDecimal } from '../market-data/decimal';
import type { HttpJsonClient } from '../market-data/http';
import { blockAt, finalBlock, PinnedViewer } from '../yield/pinned-viewer';
import type { BlockRef } from '../yield/model';
import { truncate } from '../yield/math';
import { DEFAULT_FILTER, type TokenPrice } from './model';
import { classifyPool, readV1Pool } from './rhea-discovery';
import type { PoolObservationRow } from './store';

/**
 * HISTORY BACKFILL — MAINNET, READ-ONLY. Re-reads tracked Rhea v1 pools at past blocks through an ARCHIVAL RPC
 * (`get_pool`, `get_pool_volumes`, exchange `metadata`: view calls at a block height, nothing is signed) so the 24H, 7D
 * and 30D fee windows have a real start point. Each point is the chain state at that block; its TVL is valued with
 * DefiLlama HISTORICAL prices at the block time (NEAR additionally cross-checked against Coinbase 5-minute candles).
 * Points are stored like live ones and marked `raw.backfill`; the window math and every check are unchanged.
 */
export const BACKFILL_SOURCE = 'archival-rpc';

export interface BackfillTarget {
  readonly poolKey: string;
  readonly poolId: number;
  readonly tokens: readonly string[];
  /** Aligned with `tokens`, from the live registry (ft_metadata). */
  readonly decimals: readonly (number | null)[];
}

export interface BackfillDeps {
  /** ARCHIVAL mainnet RPC whose chain id was checked. */
  readonly rpc: Pick<NearRpcClient, 'call'>;
  readonly http: HttpJsonClient;
  readonly defillamaUrl: string;
  readonly coinbaseUrl: string;
  readonly rheaContract: AccountId;
  readonly store: {
    pointTimes(poolKey: string): Promise<Date[]>;
    insertPoolObservations(rows: readonly PoolObservationRow[]): Promise<void>;
  };
  readonly now: () => Date;
  readonly log: (msg: string, data?: Record<string, unknown>) => void;
}

export interface BackfillOptions {
  readonly days: number;
  readonly stepHours: number;
  /** A target with a stored point of the pool closer than this is skipped (re-runs are cheap and idempotent). */
  readonly skipWithinHours: number;
}

export interface BackfillSummary {
  readonly targets: number;
  readonly blocks: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly missing: number;
  readonly failed: number;
  readonly unvalued: number;
}

/* ------------------------------------------------------------ block at a time ------------------------------------------------------------ */

/** A real block whose timestamp is within `toleranceMs` of `target` (secant steps; skipped heights are stepped over). */
export async function findBlockAt(
  rpc: Pick<NearRpcClient, 'call'>,
  target: Date,
  ref: BlockRef,
  toleranceMs = 10 * 60_000,
): Promise<BlockRef> {
  let msPerBlock = 1_000; // refined from every probe
  let best = ref;
  let anchor = ref;
  for (let step = 0; step < 8; step += 1) {
    const off = best.timestamp.getTime() - target.getTime();
    if (Math.abs(off) <= toleranceMs) return best;
    const guess = Math.max(1, Math.round(best.height - off / msPerBlock));
    let probe: BlockRef | null = null;
    for (let h = guess; h < guess + 20 && !probe; h += 1) {
      try {
        probe = await blockAt(rpc, h);
      } catch {
        // skipped height or not served: try the next one
      }
    }
    if (!probe) throw new Error(`no block found near height ${guess}`);
    const dh = probe.height - anchor.height;
    if (dh !== 0)
      msPerBlock = Math.max(
        200,
        Math.abs((probe.timestamp.getTime() - anchor.timestamp.getTime()) / dh),
      );
    anchor = probe;
    best = probe;
  }
  throw new Error(`no block within ${toleranceMs / 60_000} min of ${target.toISOString()}`);
}

/* ------------------------------------------------------------ historical prices ------------------------------------------------------------ */

const llamaHistorical = z.object({
  coins: z.record(
    z.object({
      price: z.number(),
      timestamp: z.number(),
      confidence: z.number().optional(),
      decimals: z.number().int().optional(),
    }),
  ),
});
const coinbaseCandles = z.array(
  z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).rest(z.unknown()),
);

/** Curated tokens use their high-confidence coingecko key; everything else DefiLlama `near:<contract>`. */
const CURATED_KEYS: Readonly<Record<string, string>> = {
  'wrap.near': 'coingecko:near',
  'usdt.tether-token.near': 'coingecko:tether',
  '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 'coingecko:usd-coin',
};
const NEAR_TOKEN = 'wrap.near';
const NEAR_CROSS_CHECK_BPS = 150n;
const SEARCH_WIDTH_S = 2 * 3600;

/**
 * Prices at `at` for valuing a past pool state. Rules: the DefiLlama point must be within 2 h of `at`; confidence
 * >= 0.9 is OK, >= 0.5 LOW_CONFIDENCE, below is not used. NEAR is OK only when a Coinbase 5-minute close within 10 min
 * agrees within 150 bps; disagreeing -> no NEAR price; no candle -> LOW_CONFIDENCE.
 */
export async function historicalPrices(
  http: HttpJsonClient,
  urls: { readonly defillama: string; readonly coinbase: string },
  tokens: readonly string[],
  at: Date,
): Promise<Map<string, TokenPrice>> {
  const out = new Map<string, TokenPrice>();
  const ts = Math.floor(at.getTime() / 1000);
  const keyOf = (t: string) => CURATED_KEYS[t] ?? `near:${t}`;
  for (let i = 0; i < tokens.length; i += 80) {
    const batch = tokens.slice(i, i + 80);
    const keys = batch.map((t) => encodeURIComponent(keyOf(t))).join(',');
    let coins: z.infer<typeof llamaHistorical>['coins'];
    try {
      coins = llamaHistorical.parse(
        await http.getJson(
          `${urls.defillama}/prices/historical/${ts}/${keys}?searchWidth=${SEARCH_WIDTH_S / 3600}h`,
        ),
      ).coins;
    } catch {
      continue; // these tokens stay unvalued at this point
    }
    for (const t of batch) {
      const c = coins[keyOf(t)];
      const usd = c ? decimalFromJsonNumber(c.price) : null;
      if (!c || !usd || usd.mantissa <= 0n || Math.abs(c.timestamp - ts) > SEARCH_WIDTH_S) continue;
      const conf = c.confidence ?? 0;
      if (conf < 0.5) continue;
      out.set(t, {
        usd,
        quality: conf >= 0.9 ? 'OK' : 'LOW_CONFIDENCE',
        source: 'defillama',
        sourceAssetId: `${keyOf(t)}@${c.timestamp}`,
      });
    }
  }
  const near = out.get(NEAR_TOKEN);
  if (near && tokens.includes(NEAR_TOKEN)) {
    let close = null;
    try {
      const start = new Date((ts - 600) * 1000).toISOString();
      const end = new Date((ts + 600) * 1000).toISOString();
      const rows = coinbaseCandles.parse(
        await http.getJson(
          `${urls.coinbase}/products/NEAR-USD/candles?granularity=300&start=${start}&end=${end}`,
        ),
      );
      const nearest = rows.reduce<(typeof rows)[number] | null>(
        (b, r) => (!b || Math.abs(r[0] - ts) < Math.abs(b[0] - ts) ? r : b),
        null,
      );
      close =
        nearest && Math.abs(nearest[0] - ts) <= 600 ? decimalFromJsonNumber(nearest[4]) : null;
    } catch {
      close = null;
    }
    if (!close || close.mantissa <= 0n) out.set(NEAR_TOKEN, { ...near, quality: 'LOW_CONFIDENCE' });
    else if (deviationBps(near.usd, close) > NEAR_CROSS_CHECK_BPS) out.delete(NEAR_TOKEN);
    else out.set(NEAR_TOKEN, { ...near, sourceAssetId: `${near.sourceAssetId}+coinbase:NEAR-USD` });
  }
  return out;
}

/* ------------------------------------------------------------ the run ------------------------------------------------------------ */

const adminSchema = z.object({ admin_fee_bps: z.number().int() }).passthrough();

export async function runBackfill(
  d: BackfillDeps,
  targets: readonly BackfillTarget[],
  o: BackfillOptions,
): Promise<BackfillSummary> {
  const head = await finalBlock(d.rpc);
  const now = d.now();
  const times = new Map<string, number[]>();
  for (const t of targets)
    times.set(
      t.poolKey,
      (await d.store.pointTimes(t.poolKey)).map((x) => x.getTime()),
    );
  const tokens = [...new Set(targets.flatMap((t) => t.tokens))].sort();
  const decimals = new Map<string, number | null>();
  for (const t of targets) t.tokens.forEach((tok, i) => decimals.set(tok, t.decimals[i] ?? null));
  const skipMs = o.skipWithinHours * 3_600_000;
  const steps = Math.floor((o.days * 24) / o.stepHours);
  let blocks = 0;
  let inserted = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let unvalued = 0;
  let ref = head;
  for (let s = 1; s <= steps; s += 1) {
    const target = new Date(now.getTime() - s * o.stepHours * 3_600_000);
    const due = targets.filter(
      (t) => !(times.get(t.poolKey) ?? []).some((x) => Math.abs(x - target.getTime()) < skipMs),
    );
    skipped += targets.length - due.length;
    if (due.length === 0) continue;
    let block: BlockRef;
    try {
      block = await findBlockAt(d.rpc, target, ref);
    } catch (e) {
      failed += due.length;
      d.log('backfill: no block for target', { target: target.toISOString(), error: String(e) });
      continue;
    }
    ref = block;
    blocks += 1;
    const viewer = new PinnedViewer(d.rpc, block);
    let admin: number | null = null;
    try {
      const m = adminSchema.safeParse(await viewer.view(d.rheaContract, 'metadata', {}));
      admin = m.success ? m.data.admin_fee_bps : null;
    } catch {
      admin = null;
    }
    const prices = await historicalPrices(
      d.http,
      { defillama: d.defillamaUrl, coinbase: d.coinbaseUrl },
      [...new Set(due.flatMap((t) => t.tokens))].filter((t) => tokens.includes(t)),
      block.timestamp,
    );
    const rows: PoolObservationRow[] = [];
    for (const t of due) {
      let pool;
      try {
        pool = await readV1Pool(viewer, d.rheaContract, t.poolId);
      } catch {
        missing += 1; // the pool did not exist yet, or the archival node refused this state
        continue;
      }
      if (pool.tokens.join() !== t.tokens.join()) {
        missing += 1;
        continue;
      }
      const c = classifyPool({
        pool,
        decimals,
        prices,
        filter: DEFAULT_FILTER,
        historySeconds: 0,
        windowVolumeUsd: null,
      });
      if (!c.tvlUsd) unvalued += 1;
      rows.push({
        id: `${pool.poolKey}@${block.height}`,
        snapshotId: `backfill:${now.toISOString()}`,
        poolKey: pool.poolKey,
        blockHeight: block.height,
        blockTimestamp: block.timestamp,
        reserves: pool.reserves.map(String),
        volumesIn: pool.volumesIn ? pool.volumesIn.map(String) : null,
        feeBps: pool.feeBps,
        adminFeeBps: admin,
        tvlUsd: c.tvlUsd ? formatDecimal(truncate(c.tvlUsd)) : null,
        priceQuality: c.priceQuality,
        quality: 'OK',
        raw: {
          ...pool.raw,
          backfill: {
            source: BACKFILL_SOURCE,
            ranAt: now.toISOString(),
            target: target.toISOString(),
            prices: Object.fromEntries(
              pool.tokens.flatMap((tok) => {
                const p = prices.get(tok);
                return p
                  ? [
                      [
                        tok,
                        { usd: formatDecimal(p.usd), quality: p.quality, source: p.sourceAssetId },
                      ],
                    ]
                  : [];
              }),
            ),
          },
        },
      });
    }
    await d.store.insertPoolObservations(rows);
    inserted += rows.length;
    for (const r of rows) times.get(r.poolKey)?.push(block.timestamp.getTime());
    d.log('backfill: block done', {
      step: s,
      of: steps,
      height: block.height,
      at: block.timestamp.toISOString(),
      rows: rows.length,
    });
  }
  return { targets: targets.length, blocks, inserted, skipped, missing, failed, unvalued };
}

/** v1 pool key -> pool id ("v1:4512" -> 4512), or null for anything else. */
export function v1PoolId(poolKey: string): number | null {
  const m = /^v1:(\d+)$/.exec(poolKey);
  return m ? Number(m[1]) : null;
}
