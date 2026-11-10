import type { YieldDataDto } from '@near-autopilot/core';
import { formatDecimal } from '../market-data/decimal';
import { MAINNET_YIELD_LABEL, type YieldDataProvider, type YieldReport } from './model';

const disabled: YieldDataDto = {
  enabled: false,
  label: MAINNET_YIELD_LABEL,
  network: null,
  observedAt: null,
  blockHeight: null,
  sources: [],
  counts: { valid: 0, rejected: 0, informational: 0 },
  estimates: [],
  error: null,
};

export function yieldReportDto(r: YieldReport): YieldDataDto {
  const count = (s: string) => r.estimates.filter((e) => e.validationStatus === s).length;
  return {
    enabled: true,
    label: MAINNET_YIELD_LABEL,
    network: r.network,
    observedAt: r.observedAt.toISOString(),
    blockHeight: r.block?.height ?? null,
    sources: r.sources.map((s) => ({ ...s })),
    counts: {
      valid: count('valid'),
      rejected: count('rejected'),
      informational: count('informational'),
    },
    estimates: r.estimates.map((e) => ({
      source: e.source,
      network: e.network,
      contract: e.contract,
      methods: [...e.methods],
      marketId: e.marketId,
      assetIds: [...e.assetIds],
      yieldType: e.yieldType,
      apr: e.apr ? formatDecimal(e.apr) : null,
      apy: e.apy ? formatDecimal(e.apy) : null,
      calculationMethod: e.calculationMethod,
      formula: e.formula,
      observationPeriodSeconds: e.observationPeriodSeconds,
      utilization: e.utilization ? formatDecimal(e.utilization) : null,
      liquidityUsd: e.liquidityUsd ? formatDecimal(e.liquidityUsd) : null,
      volumeUsd: e.volumeUsd ? formatDecimal(e.volumeUsd) : null,
      priceStatus: e.priceStatus,
      blockHeight: e.block.height,
      blockTimestamp: e.block.timestamp.toISOString(),
      sourceTimestamp: e.sourceTimestamp?.toISOString() ?? null,
      validationStatus: e.validationStatus,
      reasons: e.reasons.map((x) => ({ ...x })),
    })),
    error: null,
  };
}

/** Read-only view of the current yield report (the same cached report the cycle uses). */
export function yieldDataView(yields: YieldDataProvider | null): {
  current(): Promise<YieldDataDto>;
} {
  return {
    async current() {
      if (!yields) return disabled;
      try {
        // Read-only: show the last report a cycle or the collector built; never read the chain from a page view.
        const last = yields.latest ? yields.latest() : await yields.report();
        return last
          ? yieldReportDto(last)
          : {
              ...disabled,
              enabled: true,
              error: 'no yield report yet: run a cycle (or wait for the collector)',
            };
      } catch {
        return { ...disabled, enabled: true, error: 'yield data could not be read' };
      }
    },
  };
}

export const disabledYieldView = disabled;
