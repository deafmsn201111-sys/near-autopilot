import type { TokenId, UnitPrice } from '@near-autopilot/core';
import type { ProposalAgent } from '../ports';
import type { AgentObservation } from '../types';
import { envelope, noAction } from './envelope';

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** USD value of `raw` units at an oracle-format price, in micro-USD (1e6). Floor division; null if the price is absent. */
function valueMicro(raw: bigint, price: UnitPrice | undefined): bigint | null {
  if (!price) return null;
  return (raw * price.multiplier * 1_000_000n) / pow10(price.decimals);
}

/** A token's share of gross portfolio assets (bps) → concentration severity. Below 60% there is no signal. */
const severityForExposure = (bps: bigint): number => {
  if (bps >= 9500n) return 5;
  if (bps >= 9000n) return 4;
  if (bps >= 7500n) return 3;
  if (bps >= 6000n) return 2;
  return 0;
};

/**
 * Deterministic Portfolio Intelligence (brief §7). It understands how the portfolio is composed and raises a
 * `concentration` signal when a single asset dominates gross assets. Like every signal it can only make the system
 * MORE careful — the decision engine treats the signal as a caution on that token, so the capital allocator will
 * defer adding more of an already-dominant asset. It never proposes a trade, and it reads plain snapshot data only.
 */
export class PortfolioIntelligenceAgent implements ProposalAgent {
  readonly id = 'portfolio-intelligence' as const;

  async propose(obs: AgentObservation): Promise<unknown> {
    const s = obs.snapshot;
    // Gross asset exposure per token: wallet + Burrow supplied + Burrow collateral. Borrowed is debt, not an asset,
    // and is deliberately excluded so a loan cannot hide concentration.
    const assets = [
      ...s.walletBalances,
      ...(s.lending?.supplied ?? []),
      ...(s.lending?.collateral ?? []),
    ];
    const byToken = new Map<TokenId, bigint>();
    let total = 0n;
    let anyUnpriced = false;
    for (const a of assets) {
      if (a.raw <= 0n) continue;
      const v = valueMicro(a.raw, s.prices.get(a.token));
      if (v === null) {
        anyUnpriced = true;
        continue;
      }
      byToken.set(a.token, (byToken.get(a.token) ?? 0n) + v);
      total += v;
    }

    if (total <= 0n) {
      return envelope(this.id, obs, [
        noAction(
          'insufficient_data',
          anyUnpriced ? 'some assets are unpriced' : 'no priced assets to assess',
        ),
      ]);
    }

    let topToken: TokenId | null = null;
    let topValue = 0n;
    for (const [token, v] of byToken) {
      if (v > topValue) {
        topValue = v;
        topToken = token;
      }
    }
    const bps = (topValue * 10_000n) / total;
    const severity = severityForExposure(bps);
    if (topToken === null || severity === 0) {
      return envelope(this.id, obs, [
        noAction('healthy', 'no single asset dominates the portfolio'),
      ]);
    }

    return envelope(this.id, obs, [
      {
        kind: 'portfolio.signal',
        token: topToken,
        signal: 'concentration',
        severity,
        exposureBps: Number(bps),
        rationale: `${(Number(bps) / 100).toFixed(1)}% of portfolio assets sit in a single token`,
      },
    ]);
  }
}
