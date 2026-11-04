import type { Decimal } from './decimal';
import type { ReferenceAsset } from './assets';

/** Printed wherever a mainnet price is applied to a testnet token. */
export const REFERENCE_LABEL = 'REFERENCE_PRICE — NOT A REAL TESTNET TOKEN PRICE';
/** Shadow analysis: a real mainnet price of the mainnet token itself, applied to a SIMULATED portfolio. */
export const MAINNET_PRICE_LABEL = 'MAINNET PRICE — SIMULATED PORTFOLIO, NOTHING EXECUTED';
export const SHADOW_FLOW_LABEL = 'MAINNET READ-ONLY DATA → SIMULATED PORTFOLIO (NO EXECUTION)';
export type PriceLabel = typeof REFERENCE_LABEL | typeof MAINNET_PRICE_LABEL;
/** Where the prices are used: testnet execution (dry-run) or nowhere (shadow analysis). */
export type ExecutionNetwork = 'testnet' | 'none';
export const DATA_FLOW_LABEL = 'MAINNET MARKET DATA → TESTNET EXECUTION';

export type SourceName = 'pyth' | 'defillama';

/** Why one source's value for one asset is, or is not, usable. Only `valid` observations are ever used. */
export type ObservationStatus =
  | 'valid'
  | 'stale'
  | 'future'
  | 'invalid'
  | 'low_confidence'
  | 'not_found'
  | 'mapping_mismatch'
  | 'unavailable';

export interface PriceObservation {
  readonly source: SourceName;
  /** Always mainnet: this module only ever reads mainnet market data. */
  readonly network: 'mainnet';
  /** Pyth feed id, or DefiLlama coin key. */
  readonly assetId: string;
  readonly contract: string | null;
  readonly priceUsd: Decimal | null;
  readonly quoteCurrency: 'USD';
  /** Source-reported confidence (Pyth: confidence interval in USD; DefiLlama: 0..1 score), as text. */
  readonly confidence: string | null;
  readonly publishedAt: Date | null;
  readonly fetchedAt: Date;
  readonly ageMs: number | null;
  readonly status: ObservationStatus;
  readonly reason: string | null;
}

/**
 * - `corroborated`: at least two PROVIDERS returned valid prices within the asset's deviation limit.
 * - `single_source`: exactly one provider is valid (all of its keys agree). Usable, flagged.
 * - `price_disputed`: valid prices disagree beyond the limit. Excluded from every decision until reviewed.
 * - `unpriced`: no valid price, or the testnet<->mainnet mapping failed its checks.
 */
export type AssetPriceStatus = 'corroborated' | 'single_source' | 'price_disputed' | 'unpriced';

export interface AssetPrice {
  readonly testnetToken: string;
  readonly referenceSymbol: string;
  readonly mainnetContract: string;
  readonly status: AssetPriceStatus;
  /** The price used (highest-priority valid observation), or null if not usable. */
  readonly priceUsd: Decimal | null;
  readonly chosen: PriceObservation | null;
  /** A lower-priority valid observation, used only as a cross-check. */
  readonly crossCheck: PriceObservation | null;
  /** Largest pairwise deviation among valid observations. */
  readonly spreadBps: bigint | null;
  readonly observations: readonly PriceObservation[];
  readonly reason: string | null;
  readonly label: PriceLabel;
}

export type SourceHealth = 'ok' | 'degraded' | 'unavailable';

export interface SourceStatus {
  readonly source: SourceName;
  readonly health: SourceHealth;
  readonly detail: string | null;
}

export interface MarketReport {
  readonly id: string;
  readonly fetchedAt: Date;
  readonly marketNetwork: 'mainnet';
  readonly executionNetwork: ExecutionNetwork;
  readonly assets: readonly AssetPrice[];
  readonly sources: readonly SourceStatus[];
  /** 24h high-low range of the reference price in bps (hourly DefiLlama points). A volatility PROXY. */
  readonly range24hBps: ReadonlyMap<string, number>;
}

export interface MarketDataProvider {
  report(): Promise<MarketReport>;
}

export interface SourceResult {
  readonly observations: ReadonlyMap<string, readonly PriceObservation[]>;
  readonly status: SourceStatus;
}

export interface PriceSource {
  readonly name: SourceName;
  observe(assets: readonly ReferenceAsset[], now: Date): Promise<SourceResult>;
}

export interface MarketReportSink {
  record(report: MarketReport): Promise<void>;
}

export const usable = (a: AssetPrice): boolean =>
  a.status === 'corroborated' || a.status === 'single_source';
