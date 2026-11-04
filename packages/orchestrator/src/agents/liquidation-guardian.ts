import type { TokenId } from '@near-autopilot/core';
import { assessLendingPosition, tokenValueUsd } from '@near-autopilot/financial-engine';
import type { ProposalAgent } from '../ports';
import { RISK_RANK, type AgentObservation } from '../types';
import {
  afterRepay,
  afterSupply,
  buildLendingModel,
  smallestAmountReaching,
  targetHfWad,
} from '../risk-state';
import { envelope, noAction } from './envelope';

/**
 * Deterministic Liquidation Guardian. When the position falls to the watch level it proposes the smallest repayment
 * (from wallet holdings of a debt token) that restores the target health factor, and as an alternative the smallest
 * collateral top-up. It never proposes to borrow or withdraw: those proposal kinds do not exist.
 * The decision engine re-derives the sizing itself and may shrink it; it does not rely on this agent being right.
 */
export class LiquidationGuardianAgent implements ProposalAgent {
  readonly id = 'liquidation-guardian' as const;

  async propose(obs: AgentObservation): Promise<unknown> {
    const { snapshot, risk, config } = obs;
    if (RISK_RANK[risk.level] < RISK_RANK.watch)
      return envelope(this.id, obs, [noAction('healthy', `position risk is ${risk.level}`)]);
    const built = buildLendingModel(snapshot);
    if (!built.ok)
      return envelope(this.id, obs, [noAction('insufficient_data', 'position cannot be valued')]);

    const model = built.model;
    const target = targetHfWad(config);
    const wallet = new Map<TokenId, bigint>();
    for (const b of snapshot.walletBalances)
      wallet.set(b.token, (wallet.get(b.token) ?? 0n) + b.raw);
    const hfOf = (m: typeof model) => assessLendingPosition(m).healthFactorWad;
    const proposals: Record<string, unknown>[] = [];
    const why = `health factor below ${config.risk.watchBelowBps / 10_000}; restoring to ${config.risk.targetHealthFactorBps / 10_000}`;

    // Repay: the largest debt we can actually pay from the wallet.
    const debts = [...model.debt].sort((a, b) => {
      const va = tokenValueUsd(snapshot.prices, a.id as TokenId, a.amount);
      const vb = tokenValueUsd(snapshot.prices, b.id as TokenId, b.amount);
      return va === vb ? (a.id < b.id ? -1 : 1) : va > vb ? -1 : 1;
    });
    for (const d of debts) {
      const held = wallet.get(d.id as TokenId) ?? 0n;
      const max = held < d.amount ? held : d.amount;
      if (max <= 0n) continue;
      const amount = smallestAmountReaching(max, target, (a) =>
        hfOf(afterRepay(model, d.id as TokenId, a)),
      );
      if (amount > 0n) {
        proposals.push({
          kind: 'lending.repay',
          token: d.id,
          amount: amount.toString(),
          rationale: `repay ${d.id}: ${why}`,
        });
        break;
      }
    }

    // Collateral top-up from the most valuable eligible wallet token.
    const eligible = snapshot.walletBalances
      .filter(
        (b) =>
          b.raw > 0n &&
          snapshot.risk.get(b.token)?.canBeCollateral === true &&
          snapshot.prices.has(b.token),
      )
      .map((b) => ({ ...b, value: tokenValueUsd(snapshot.prices, b.token, b.raw) }))
      .sort((a, b) =>
        a.value === b.value ? (a.token < b.token ? -1 : 1) : a.value > b.value ? -1 : 1,
      );
    for (const c of eligible) {
      const amount = smallestAmountReaching(c.raw, target, (a) => {
        const m = afterSupply(model, snapshot, c.token, a);
        return m ? hfOf(m) : null;
      });
      if (amount > 0n) {
        proposals.push({
          kind: 'lending.supply_collateral',
          token: c.token,
          amount: amount.toString(),
          rationale: `add ${c.token} as collateral: ${why}`,
        });
        break;
      }
    }
    return envelope(
      this.id,
      obs,
      proposals.length > 0
        ? proposals
        : [noAction('other', 'wallet holds nothing that could reduce risk')],
    );
  }
}
