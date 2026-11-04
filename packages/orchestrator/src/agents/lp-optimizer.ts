import { tickAtSqrtRatio } from '@near-autopilot/financial-engine';
import { evaluateLpReposition } from '../lp-economics';
import type { ProposalAgent } from '../ports';
import type { AgentObservation } from '../types';
import { envelope, noAction } from './envelope';

/**
 * Deterministic LP Optimizer. For each known concentrated-liquidity position it considers a range centred on the
 * current price and proposes moving there only if the ESTIMATED extra fees repay the move within the configured
 * number of days. Its proposals are advisory: no component in this repository can sign a liquidity-management
 * transaction, so the decision engine can recommend but never execute them.
 */
export class LpOptimizerAgent implements ProposalAgent {
  readonly id = 'lp-optimizer' as const;

  async propose(obs: AgentObservation): Promise<unknown> {
    const market = obs.market;
    if (!market || market.lpPositions.length === 0)
      return envelope(this.id, obs, [
        noAction('insufficient_data', 'no liquidity positions to evaluate'),
      ]);
    const half = obs.config.lp.halfWidthTicks;
    const proposals: Record<string, unknown>[] = [];
    for (const view of [...market.lpPositions].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      let centre: number;
      try {
        centre = tickAtSqrtRatio(view.sqrtPrice);
      } catch {
        continue;
      }
      const tickLower = centre - half;
      const tickUpper = centre + half;
      const ev = evaluateLpReposition(view, tickLower, tickUpper, obs.config);
      if (ev.ok) {
        proposals.push({
          kind: 'lp.reposition',
          positionId: view.id,
          tickLower,
          tickUpper,
          rationale: `ESTIMATE: re-centring costs ${ev.costQuote} and adds ~${ev.extraFeesPerDayQuote}/day in fees; payback ~${ev.paybackDays} days`,
        });
      }
    }
    return envelope(
      this.id,
      obs,
      proposals.length > 0
        ? proposals
        : [noAction('no_edge', 'no re-centring clears the payback hurdle')],
    );
  }
}
