import {
  MissingPriceError,
  type ActionIntent,
  type Agent,
  type AgentContext,
} from '@near-autopilot/core';
import {
  collateralValueForTargetHealthFactor,
  healthFactor,
  lendingTotals,
  priceOf,
  rawForValueUsd,
  repayAmountForTargetHealthFactor,
  tokenValueUsd,
} from '@near-autopilot/financial-engine';
import { z } from 'zod';

export const guardianConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Act when the health factor falls below this. */
    triggerHealthFactor: z.number().gt(1),
    /** Size the action to restore this health factor. */
    targetHealthFactor: z.number().gt(1),
  })
  .strict()
  .refine((c) => c.targetHealthFactor > c.triggerHealthFactor, {
    message: 'targetHealthFactor must be greater than triggerHealthFactor',
    path: ['targetHealthFactor'],
  });
export type GuardianConfig = z.output<typeof guardianConfigSchema>;

/**
 * Watches a Burrow position and de-risks it: first by repaying debt from wallet holdings of the
 * debt token, otherwise by supplying wallet tokens as extra collateral. It never borrows.
 */
export class HealthGuardianAgent implements Agent {
  readonly id = 'health-guardian';

  constructor(private readonly config: GuardianConfig) {}

  async evaluate(context: AgentContext): Promise<readonly ActionIntent[]> {
    const { snapshot } = context;
    if (!this.config.enabled || !snapshot.lending || snapshot.lending.borrowed.length === 0)
      return [];

    try {
      const totals = lendingTotals(snapshot.lending, snapshot.prices, snapshot.risk);
      const hf = healthFactor(totals);
      if (hf === null || hf >= this.config.triggerHealthFactor) return [];

      const targetBps = Math.round(this.config.targetHealthFactor * 10_000);
      const reason = `health factor ${hf.toFixed(3)} < trigger ${this.config.triggerHealthFactor}; restoring to ${this.config.targetHealthFactor}`;
      const wallet = new Map(snapshot.walletBalances.map((b) => [b.token, b.raw]));

      // 1. Repay: largest debts first.
      const debts = [...snapshot.lending.borrowed].sort((a, b) =>
        Number(
          tokenValueUsd(snapshot.prices, b.token, b.raw) -
            tokenValueUsd(snapshot.prices, a.token, a.raw),
        ),
      );
      for (const debt of debts) {
        const held = wallet.get(debt.token) ?? 0n;
        if (held === 0n) continue;
        const needed = repayAmountForTargetHealthFactor({
          totals,
          prices: snapshot.prices,
          risk: snapshot.risk,
          debtToken: debt.token,
          targetBps,
        });
        const amount = [needed, held, debt.raw].reduce((min, v) => (v < min ? v : min));
        if (amount <= 0n) continue;
        return [
          {
            id: context.ids.next(),
            agentId: this.id,
            reason,
            kind: 'lending.repay',
            protocol: 'burrow',
            token: debt.token,
            amount,
          },
        ];
      }

      // 2. Add collateral from the wallet.
      const candidates = snapshot.walletBalances
        .filter(
          (b) =>
            b.raw > 0n &&
            snapshot.risk.get(b.token)?.canBeCollateral === true &&
            snapshot.prices.has(b.token),
        )
        .sort((a, b) =>
          Number(
            tokenValueUsd(snapshot.prices, b.token, b.raw) -
              tokenValueUsd(snapshot.prices, a.token, a.raw),
          ),
        );
      for (const candidate of candidates) {
        const risk = snapshot.risk.get(candidate.token);
        if (!risk) continue;
        const value = collateralValueForTargetHealthFactor(
          totals,
          targetBps,
          risk.collateralFactorBps,
        );
        if (value <= 0n) continue;
        const needed = rawForValueUsd(value, priceOf(snapshot.prices, candidate.token));
        const amount = needed < candidate.raw ? needed : candidate.raw;
        return [
          {
            id: context.ids.next(),
            agentId: this.id,
            reason: `${reason} (adding collateral)`,
            kind: 'lending.supply',
            protocol: 'burrow',
            token: candidate.token,
            amount,
            asCollateral: true,
          },
        ];
      }
      return [];
    } catch (error) {
      // Missing price/risk data means we cannot reason safely; propose nothing.
      if (error instanceof MissingPriceError) return [];
      throw error;
    }
  }
}
