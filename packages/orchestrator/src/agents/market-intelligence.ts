import type { TokenId, UnitPrice } from '@near-autopilot/core';
import type { ProposalAgent } from '../ports';
import { MAX_PROPOSALS_PER_OUTPUT } from '../proposals';
import type { AgentObservation } from '../types';
import { envelope, noAction } from './envelope';

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** |a - b| / b in bps, exact integer arithmetic on two oracle-format prices. Null if b is zero. */
export function priceDivergenceBps(a: UnitPrice, b: UnitPrice): bigint | null {
  const num = a.multiplier * pow10(b.decimals);
  const den = b.multiplier * pow10(a.decimals);
  if (den === 0n) return null;
  return ((num > den ? num - den : den - num) * 10_000n) / den;
}

const severityFor = (value: bigint, steps: readonly [bigint, number][]): number => {
  let s = 0;
  for (const [threshold, sev] of steps) if (value >= threshold) s = sev;
  return s;
};

/**
 * Deterministic Market Intelligence. It never recommends trading: it only reports conditions that should make the
 * rest of the system MORE careful - the oracle disagreeing with an independent price source, or realised volatility
 * spiking. An LLM-backed variant can replace it (see `LlmAgent`); the proposal schema is the same, so the worst a
 * manipulated signal can do is defer a discretionary trade.
 */
export class MarketIntelligenceAgent implements ProposalAgent {
  readonly id = 'market-intelligence' as const;

  constructor(private readonly options: { signalTtlSeconds?: number } = {}) {}

  async propose(obs: AgentObservation): Promise<unknown> {
    const market = obs.market;
    if (!market)
      return envelope(this.id, obs, [noAction('insufficient_data', 'no market data available')]);
    const validUntil = new Date(
      obs.now.getTime() + (this.options.signalTtlSeconds ?? 900) * 1000,
    ).toISOString();

    const tokens = new Set<TokenId>([
      ...obs.snapshot.walletBalances.filter((b) => b.raw > 0n).map((b) => b.token),
      ...(obs.snapshot.lending?.collateral ?? []).map((b) => b.token),
      ...(obs.snapshot.lending?.borrowed ?? []).map((b) => b.token),
    ]);
    const proposals: Array<Record<string, unknown> & { severity: number }> = [];
    for (const token of [...tokens].sort()) {
      const oracle = obs.snapshot.prices.get(token);
      const reference = market.referencePrices.get(token);
      if (oracle && reference) {
        const bps = priceDivergenceBps(oracle, reference);
        const severity =
          bps === null
            ? 0
            : severityFor(bps, [
                [100n, 2],
                [300n, 3],
                [500n, 4],
                [1000n, 5],
              ]);
        if (severity > 0) {
          proposals.push({
            kind: 'market.signal',
            token,
            signal: 'oracle_divergence',
            severity,
            validUntil,
            rationale: `oracle differs from the reference price by ${bps} bps`,
          });
        }
      }
      const vol = market.volatility24hBps.get(token);
      if (vol !== undefined) {
        const severity = severityFor(BigInt(vol), [
          [1500n, 3],
          [3000n, 4],
          [6000n, 5],
        ]);
        if (severity > 0)
          proposals.push({
            kind: 'market.signal',
            token,
            signal: 'volatility_spike',
            severity,
            validUntil,
            rationale: `24h realised volatility ${vol} bps`,
          });
      }
    }
    // The envelope schema caps the proposal count; exceeding it would get the WHOLE output rejected and every caution
    // signal lost. Keep the most severe ones (stable order otherwise): any one of them already defers discretionary trades.
    const kept = proposals
      .map((p, i) => ({ p, i }))
      .sort((a, b) => b.p.severity - a.p.severity || a.i - b.i)
      .slice(0, MAX_PROPOSALS_PER_OUTPUT)
      .map(({ p }) => p);
    return envelope(
      this.id,
      obs,
      kept.length > 0 ? kept : [noAction('healthy', 'no abnormal conditions found')],
    );
  }
}
