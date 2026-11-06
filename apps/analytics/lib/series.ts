import 'server-only';
import { tryApi } from './api';

/** Time series the charts read: stored observations and stored engine results, never computed in the browser. */
export interface PriceSeries {
  asset: string;
  curated: boolean;
  maxDeviationBps: number | null;
  limitBps: number | null;
  points: { t: number; price: number | null; spreadBps: number | null; sources: number }[];
}
export interface PoolSeries {
  poolKey: string;
  points: { t: number; tvl: number | null }[];
}
export interface MarketSeries {
  token: string;
  points: {
    t: number;
    supplyApr: number | null;
    borrowApr: number | null;
    utilization: number | null;
  }[];
}
export interface RiskReport {
  hours: number;
  label: string;
  bands: {
    watch: number;
    danger: number;
    critical: number;
    target: number;
    liquidation: number;
  };
  portfolios: {
    portfolioId: string;
    description: string | null;
    latest: {
      at: string | null;
      level: string | null;
      healthFactor: number | null;
      ltvBps: number | null;
      collateralUsd: number | null;
      debtUsd: number | null;
      stress: { scenario: string; status: string; healthFactor: number | null }[];
      collateralDropToLiquidation: number | null;
    } | null;
    history: { t: number; healthFactor: number | null; level: string | null }[];
  }[];
}
export interface Freshness {
  now: string;
  running: boolean;
  lastStatus: string | null;
  dataAsOf: string | null;
  nextRunAt: string | null;
  intervalSeconds: number;
}

export const priceSeries = (hours = 24) =>
  tryApi<{ assets: PriceSeries[] }>(`/v1/analytics/series/prices?hours=${hours}`);
export const poolSeries = (hours = 24) =>
  tryApi<{ pools: PoolSeries[] }>(`/v1/analytics/series/pools?hours=${hours}`);
export const marketSeries = (hours = 48) =>
  tryApi<{ markets: MarketSeries[] }>(`/v1/analytics/series/markets?hours=${hours}`);
export const riskReport = (hours = 72) => tryApi<RiskReport>(`/v1/analytics/risk?hours=${hours}`);
export const freshness = () => tryApi<Freshness>('/v1/analytics/freshness');

/** Lookup by key; an unknown key is an empty series (the sparkline then says "no history"). */
export function index<T extends { points: unknown[] }>(
  list: readonly T[] | undefined,
  key: (x: T) => string,
): Map<string, T> {
  return new Map((list ?? []).map((x) => [key(x), x] as const));
}
