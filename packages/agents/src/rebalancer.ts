import {
  MissingPriceError,
  accountIdSchema,
  usdToMicro,
  type ActionIntent,
  type Agent,
  type AgentContext,
  type TokenId,
} from '@near-autopilot/core';
import { minAmountOut, planRebalance } from '@near-autopilot/financial-engine';
import { z } from 'zod';

export const rebalancerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Target weights in basis points per token; must sum to 10000. */
    targets: z
      .array(
        z
          .object({ token: accountIdSchema, weightBps: z.number().int().min(0).max(10_000) })
          .strict(),
      )
      .min(2),
    /** Rebalance when the largest drift from target exceeds this many bps. */
    driftThresholdBps: z.number().int().positive(),
    maxTradeUsd: z.number().positive(),
    slippageBps: z.number().int().min(0).max(1_000),
  })
  .strict()
  .refine((c) => c.targets.reduce((sum, t) => sum + t.weightBps, 0) === 10_000, {
    message: 'target weights must sum to 10000 bps',
    path: ['targets'],
  });
export type RebalancerConfig = z.output<typeof rebalancerConfigSchema>;

/** Keeps wallet holdings near target weights with one capped Rhea swap per evaluation. */
export class RebalancerAgent implements Agent {
  readonly id = 'rebalancer';
  private readonly targets: ReadonlyMap<TokenId, number>;

  constructor(private readonly config: RebalancerConfig) {
    this.targets = new Map(config.targets.map((t) => [t.token, t.weightBps]));
  }

  async evaluate(context: AgentContext): Promise<readonly ActionIntent[]> {
    if (!this.config.enabled) return [];
    const { snapshot } = context;

    let plan;
    try {
      plan = planRebalance({
        balances: snapshot.walletBalances,
        prices: snapshot.prices,
        targets: this.targets,
        thresholdBps: this.config.driftThresholdBps,
        maxTradeUsd: usdToMicro(this.config.maxTradeUsd),
      });
    } catch (error) {
      if (error instanceof MissingPriceError) return [];
      throw error;
    }
    if (!plan) return [];

    const quote = await context.quoter.quote({
      tokenIn: plan.sell.token,
      tokenOut: plan.buy.token,
      amountIn: plan.sellAmountRaw,
    });
    if (!quote) return [];

    return [
      {
        id: context.ids.next(),
        agentId: this.id,
        reason: `${plan.sell.token} is ${plan.sell.driftBps} bps over target and ${plan.buy.token} is ${-plan.buy.driftBps} bps under`,
        kind: 'swap',
        protocol: 'rhea',
        tokenIn: plan.sell.token,
        tokenOut: plan.buy.token,
        amountIn: plan.sellAmountRaw,
        poolId: quote.poolId,
        quotedAmountOut: quote.amountOut,
        minAmountOut: minAmountOut(quote.amountOut, this.config.slippageBps),
        slippageBps: this.config.slippageBps,
      },
    ];
  }
}
