import type { AccountId, PortfolioSnapshot } from '@near-autopilot/core';
import type { OrchestratorConfig } from './config';
import type { DataIssue, DataQuality, MarketContext } from './types';

/**
 * Stale-data protection. Pure: the caller supplies `now`, so the same inputs always give the same verdict.
 *
 * The orchestrator runs this twice per cycle: once when the observation is taken, and again immediately before an
 * approved plan is executed, because agents, quoting and policy evaluation take real time (an LLM call can take
 * many seconds) and a verdict that was true at the start may be false by the end.
 *
 * Rules:
 *  - a snapshot or price set older than the limit, or timestamped in the future, blocks everything;
 *  - a position that is borrowing must be fully priced and have risk parameters, otherwise it cannot be valued;
 *  - missing or stale MARKET data only blocks discretionary actions: de-risking depends on the snapshot, not on the feed.
 */
export function checkDataQuality(args: {
  now: Date;
  expectedAccount: AccountId;
  snapshot: PortfolioSnapshot | null;
  market: MarketContext | null;
  config: OrchestratorConfig;
}): DataQuality {
  const { now, snapshot, market, config } = args;
  const f = config.freshness;
  const issues: DataIssue[] = [];
  const ageS = (d: Date) => (now.getTime() - d.getTime()) / 1000;

  if (!snapshot) {
    issues.push({
      code: 'SNAPSHOT_UNAVAILABLE',
      blocking: true,
      detail: 'no snapshot could be taken',
    });
  } else {
    if (snapshot.accountId !== args.expectedAccount) {
      issues.push({
        code: 'ACCOUNT_MISMATCH',
        blocking: true,
        detail: `snapshot is for ${snapshot.accountId}, expected ${args.expectedAccount}`,
      });
    }
    const checks: [string, Date, number, 'SNAPSHOT_STALE' | 'PRICES_STALE'][] = [
      ['snapshot', snapshot.takenAt, f.maxSnapshotAgeSeconds, 'SNAPSHOT_STALE'],
      ['oracle prices', snapshot.pricesAsOf, f.maxPriceAgeSeconds, 'PRICES_STALE'],
    ];
    for (const [label, at, max, code] of checks) {
      if (Number.isNaN(at.getTime())) {
        issues.push({ code, blocking: true, detail: `${label} timestamp is invalid` });
      } else if (ageS(at) < -f.maxFutureSkewSeconds) {
        issues.push({
          code: 'FUTURE_TIMESTAMP',
          blocking: true,
          detail: `${label} is timestamped ${Math.round(-ageS(at))}s in the future`,
        });
      } else if (ageS(at) > max) {
        issues.push({
          code,
          blocking: true,
          detail: `${label} is ${Math.round(ageS(at))}s old (limit ${max}s)`,
        });
      }
    }
    const borrowing = (snapshot.lending?.borrowed ?? []).some((b) => b.raw > 0n);
    if (borrowing) {
      const tokens = [
        ...(snapshot.lending?.collateral ?? []),
        ...(snapshot.lending?.borrowed ?? []),
      ]
        .filter((b) => b.raw > 0n)
        .map((b) => b.token);
      const noPrice = tokens.filter((t) => !snapshot.prices.has(t));
      const noRisk = tokens.filter((t) => !snapshot.risk.has(t));
      if (noPrice.length > 0)
        issues.push({
          code: 'MISSING_PRICES',
          blocking: true,
          detail: `no oracle price for ${[...new Set(noPrice)].join(', ')}`,
        });
      if (noRisk.length > 0)
        issues.push({
          code: 'MISSING_RISK_PARAMS',
          blocking: true,
          detail: `no risk parameters for ${[...new Set(noRisk)].join(', ')}`,
        });
    }
  }

  let marketUsable = false;
  if (!market) {
    issues.push({ code: 'MARKET_UNAVAILABLE', blocking: false, detail: 'no market data' });
  } else if (Number.isNaN(market.asOf.getTime())) {
    // NaN compares false against every limit, so without this an invalid date would count as fresh.
    issues.push({ code: 'MARKET_STALE', blocking: false, detail: 'market timestamp is invalid' });
  } else if (ageS(market.asOf) < -f.maxFutureSkewSeconds) {
    issues.push({
      code: 'FUTURE_TIMESTAMP',
      blocking: false,
      detail: 'market data is timestamped in the future',
    });
  } else if (ageS(market.asOf) > f.maxMarketAgeSeconds) {
    issues.push({
      code: 'MARKET_STALE',
      blocking: false,
      detail: `market data is ${Math.round(ageS(market.asOf))}s old (limit ${f.maxMarketAgeSeconds}s)`,
    });
  } else {
    marketUsable = true;
  }

  const blocking = issues.some((i) => i.blocking);
  return { checkedAt: now, issues, blocking, marketUsable: marketUsable && !blocking };
}
