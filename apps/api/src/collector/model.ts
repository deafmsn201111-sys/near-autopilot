import type { Decimal } from '../market-data/decimal';
import type { SourceName } from '../market-data/model';

/**
 * Autonomous shadow collector: MAINNET, READ-ONLY. Everything here is analytics on public chain state and public price
 * feeds. Nothing in this module can sign, and discovery never adds anything to an execution allowlist.
 */
export const SHADOW_BANNER = 'SHADOW MODE — MAINNET READ-ONLY — NO TRANSACTIONS';

export type PriceQuality = 'OK' | 'LOW_CONFIDENCE' | 'UNPRICED';

/** A price the collector may use, with how far it may be trusted. */
export interface TokenPrice {
  readonly usd: Decimal;
  readonly quality: Exclude<PriceQuality, 'UNPRICED'>;
  readonly source: SourceName;
  readonly sourceAssetId: string;
}

export type PoolCategory =
  | 'DISCOVERED'
  | 'LIQUID'
  | 'ANALYTICS_ELIGIBLE'
  | 'LP_SIMULATION_ELIGIBLE'
  | 'LOW_LIQUIDITY'
  | 'UNSUPPORTED'
  | 'DATA_INVALID';

/** Yield/LP model support per pool type. Anything but SIMPLE_POOL has no implemented model. */
export type ModelStatus = 'SUPPORTED' | 'UNSUPPORTED_POOL_MODEL';

export interface ReasonCode {
  readonly code: string;
  readonly detail: string;
}

/** One pool as read from the chain at one block (v1 `get_pools` entry or DCL `list_pools` entry). */
export interface DiscoveredPool {
  readonly poolKey: string;
  readonly family: 'v1' | 'dcl';
  readonly contract: string;
  readonly poolType: string;
  readonly tokens: readonly string[];
  readonly reserves: readonly bigint[];
  /** v1: total_fee in bps. DCL: fee in 1e-6 converted to bps (2000 -> 20 bps). */
  readonly feeBps: number | null;
  /** v1 only, filled for tracked pools: cumulative input volume per token. */
  readonly volumesIn: readonly bigint[] | null;
  readonly state: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PoolClassification {
  readonly category: PoolCategory;
  readonly modelStatus: ModelStatus;
  readonly tvlUsd: Decimal | null;
  readonly priceQuality: PriceQuality;
  /** How TVL was valued: every token priced, or 2x the priced side of a two-token constant-product pool. */
  readonly tvlMethod: 'all_tokens' | 'priced_side_x2' | null;
  readonly reasons: readonly ReasonCode[];
  /** Tracked pools get an observation (reserves, volumes) every cycle; the rest only on registry scans. */
  readonly tracked: boolean;
}

export interface CollectorFilter {
  /** A $100 position (policy maxActionUsd) stays <= 1 % of a $10k pool: entry impact stays small. */
  readonly minTvlUsd: number;
  /** Fee history needed before a pool is analysed / simulated (seconds). */
  readonly minHistorySeconds: number;
  /** Minimum traded volume over that history (USD) for LP simulation: no volume, no fees. */
  readonly minWindowVolumeUsd: number;
  /** Largest gap between the pool's implied price and the reference price (policy.maxOracleDeviationBps). */
  readonly maxPriceDeviationBps: number;
}

export const DEFAULT_FILTER: CollectorFilter = {
  minTvlUsd: 10_000,
  minHistorySeconds: 3_600,
  minWindowVolumeUsd: 100,
  maxPriceDeviationBps: 150,
};

export interface SourceRun {
  readonly source: string;
  readonly health: 'ok' | 'degraded' | 'unavailable' | 'skipped';
  readonly detail: string | null;
  readonly records: number;
  readonly durationMs: number;
}
