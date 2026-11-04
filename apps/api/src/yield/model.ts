import type { Decimal } from '../market-data/decimal';

/**
 * TESTNET YIELD DATA. Every estimate is read from a testnet contract at one pinned block, validated, and traceable to
 * the contract, method and block it came from. Nothing here is a forecast: lending rates are what the contract reports
 * for its current utilisation; LP fee rates are historical (an observation period is always stated).
 */
export const YIELD_LABEL = 'TESTNET YIELD — OBSERVED, NOT A FORECAST';

export type YieldSourceName = 'burrow' | 'rhea_v1' | 'rhea_dcl';

/**
 * - `lending_supply`: what a supplier earns (Burrow `supply_apr`).
 * - `lending_borrow`: what a borrower PAYS (Burrow `borrow_apr`); never a yield on supplied capital.
 * - `lp_fee`: trading fees earned by liquidity providers over an observation period (historical).
 */
export type YieldType = 'lending_supply' | 'lending_borrow' | 'lp_fee';

/** `source_reported`: the contract returns the rate. `calculated`: computed here; `formula` says how. */
export type CalculationMethod = 'source_reported' | 'calculated';

export type PriceStatus = 'fresh' | 'missing' | 'not_needed';

/**
 * - `valid`: passed every check; may reach a strategy (lending_supply only feeds the Capital Allocator).
 * - `rejected`: failed a check; recorded with its reasons, never used.
 * - `informational`: correct data that is not a yield on capital (borrow cost); shown, never used as a yield.
 */
export type ValidationStatus = 'valid' | 'rejected' | 'informational';

export type YieldRejection =
  | 'MISSING_YIELD_DATA'
  | 'STALE_YIELD_DATA'
  | 'INVALID_YIELD_DATA'
  | 'MISSING_PRICE'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'UNVERIFIED_POOL'
  | 'UNVERIFIED_ASSET'
  | 'SOURCE_UNAVAILABLE';

export interface YieldReason {
  readonly code: YieldRejection;
  readonly detail: string;
}

export interface BlockRef {
  readonly height: number;
  readonly timestamp: Date;
}

export interface YieldEstimate {
  readonly source: YieldSourceName;
  readonly network: 'testnet';
  /** Contract and view methods the numbers came from. */
  readonly contract: string;
  readonly methods: readonly string[];
  /** Burrow: the token id. Rhea v1: `pool:<id>`. DCL: the DCL pool id. */
  readonly marketId: string;
  readonly assetIds: readonly string[];
  readonly yieldType: YieldType;
  /** Simple annual rate as a fraction (0.05 = 5 %). Null when it could not be established. */
  readonly apr: Decimal | null;
  /** Compounded annual rate. Only set when the compounding is confirmed; it never is today (always null). */
  readonly apy: Decimal | null;
  readonly calculationMethod: CalculationMethod;
  readonly formula: string | null;
  readonly observationPeriodSeconds: number | null;
  /** Burrow: borrowed / (supplied + reserved). */
  readonly utilization: Decimal | null;
  /** Withdrawable (Burrow) or pooled (Rhea) amount in USD, when a fresh price exists. */
  readonly liquidityUsd: Decimal | null;
  /** Rhea: traded volume over the observation period, in USD. */
  readonly volumeUsd: Decimal | null;
  readonly priceStatus: PriceStatus;
  readonly block: BlockRef;
  /** The source's own timestamp, if it has one (Burrow `last_update_timestamp`). */
  readonly sourceTimestamp: Date | null;
  readonly validationStatus: ValidationStatus;
  readonly reasons: readonly YieldReason[];
  /** The source fields the estimate was computed from (amounts as strings), for audit and the next observation. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export type YieldSourceHealth = 'ok' | 'unavailable' | 'disabled';

export interface YieldSourceStatus {
  readonly source: YieldSourceName;
  readonly contract: string;
  readonly health: YieldSourceHealth;
  readonly detail: string | null;
  readonly marketsRead: number;
}

export interface YieldReport {
  readonly id: string;
  readonly network: 'testnet';
  readonly observedAt: Date;
  /** The single block every view of this report was read at (null if the block itself could not be read). */
  readonly block: BlockRef | null;
  readonly sources: readonly YieldSourceStatus[];
  readonly estimates: readonly YieldEstimate[];
}

export interface YieldDataProvider {
  report(): Promise<YieldReport>;
}

export interface YieldReportSink {
  record(report: YieldReport): Promise<void>;
}

/** The latest earlier observation of one Rhea v1 pool, used as the start of an LP fee observation period. */
export interface PoolObservation {
  readonly observedAt: Date;
  readonly blockHeight: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface PoolHistory {
  /** Latest stored observation of the pool at least `minAgeSeconds` older than `before`, or null. */
  previous(
    source: YieldSourceName,
    marketId: string,
    before: Date,
    minAgeSeconds: number,
  ): Promise<PoolObservation | null>;
}

export const isStrategic = (e: YieldEstimate): boolean =>
  e.validationStatus === 'valid' && e.yieldType === 'lending_supply' && e.apr !== null;
