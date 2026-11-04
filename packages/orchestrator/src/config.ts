import { accountIdSchema, usdToMicro } from '@near-autopilot/core';
import { z } from 'zod';
import { AGENT_IDS } from './proposals';

const bps = z.number().int().min(0).max(10_000);

/**
 * Orchestrator configuration. Every number here is an operator POLICY CHOICE, not a protocol fact. The orchestrator's
 * limits are meant to be at least as strict as the policy engine's; the policy engine stays the final authority and
 * is never configured from here.
 */
export const orchestratorConfigSchema = z
  .object({
    freshness: z
      .object({
        /** Snapshot and oracle prices older than this block all action. Keep <= the policy engine's maxPriceAgeSeconds. */
        maxSnapshotAgeSeconds: z.number().int().positive().default(60),
        maxPriceAgeSeconds: z.number().int().positive().default(60),
        /** Market feed (yield estimates, reference prices) older than this is ignored for discretionary decisions. */
        maxMarketAgeSeconds: z.number().int().positive().default(300),
        /** Timestamps further in the future than this are treated as corrupt. */
        maxFutureSkewSeconds: z.number().int().nonnegative().default(5),
      })
      .strict()
      .default({}),
    risk: z
      .object({
        /** Health factor below which the position is "watch": de-risking becomes eligible. */
        watchBelowBps: z.number().int().min(10_000).default(15_000),
        dangerBelowBps: z.number().int().min(10_000).default(11_000),
        /** Below this the situation is a page-level incident. */
        criticalBelowBps: z.number().int().min(10_000).default(10_500),
        /** De-risking is sized to restore this health factor. */
        targetHealthFactorBps: z.number().int().min(10_001).default(16_000),
      })
      .strict()
      .default({}),
    swap: z
      .object({
        maxSwapUsd: z.number().positive().default(100),
        maxSlippageBps: z.number().int().min(0).max(1_000).default(100),
        /** Fixed cost charged against every swap when judging benefit (estimate). */
        estimatedGasUsd: z.number().nonnegative().default(0.05),
        /** Yield differential is credited over this horizon only (estimate; linear, no compounding). */
        horizonDays: z.number().int().positive().max(365).default(30),
        /** Required: estimated benefit >= multiple * (swap cost). */
        costCoverMultiple: z.number().int().min(1).default(3),
        /** Required: estimated benefit minus cost >= this (USD). The hurdle below which "do nothing" wins. */
        minNetBenefitUsd: z.number().nonnegative().default(0.5),
      })
      .strict()
      .default({}),
    allocation: z
      .object({
        assets: z
          .array(
            z
              .object({
                token: accountIdSchema,
                minBps: bps.default(0),
                maxBps: bps.default(10_000),
                group: z.string().min(1).optional(),
              })
              .strict(),
          )
          .default([]),
        groupCaps: z
          .array(z.object({ group: z.string().min(1), maxBps: bps }).strict())
          .default([]),
        /** Do nothing unless the largest weight difference exceeds this. */
        driftThresholdBps: bps.default(500),
        maxTurnoverBps: bps.default(2_500),
      })
      .strict()
      .default({}),
    lp: z
      .object({
        /** Re-centre only if the extra fees repay the cost within this many days (estimate). */
        maxPaybackDays: z.number().int().positive().default(14),
        /** Assumed share of time a freshly centred position stays in range. An ASSUMPTION, not a forecast. */
        assumedTimeInRangeBps: bps.default(7_000),
        halfWidthTicks: z.number().int().positive().default(600),
      })
      .strict()
      .default({}),
    execution: z
      .object({
        /** An identical action within this window is a duplicate. */
        dedupeWindowSeconds: z.number().int().nonnegative().default(900),
        /** Ranked candidates tried (plan + authorize) before giving up. */
        maxAuthorizationAttempts: z.number().int().positive().max(10).default(3),
        /** A cycle claimed longer ago than this and never started executing may be taken over. */
        inProgressTimeoutSeconds: z.number().int().positive().default(300),
        /** This many consecutive failed executions engage emergency read-only mode. */
        maxConsecutiveFailures: z.number().int().positive().default(3),
        /** This many consecutive blind cycles (stale/missing data) while borrowing is a page. */
        staleCyclesBeforePage: z.number().int().positive().default(3),
        /** 0 disables. An agent that does not answer in time is treated as having proposed nothing. */
        agentTimeoutMs: z.number().int().nonnegative().default(0),
      })
      .strict()
      .default({}),
    agents: z
      .object({
        /** Invalid outputs from one agent in one cycle before it is quarantined. */
        quarantineAfterInvalid: z.number().int().positive().default(3),
        /** Order used to break ties between otherwise equal candidates. */
        priority: z.array(z.enum(AGENT_IDS)).default([...AGENT_IDS].reverse()),
      })
      .strict()
      .default({}),
    audit: z
      .object({ storeInputs: z.boolean().default(true) })
      .strict()
      .default({}),
  })
  .strict()
  .refine(
    (c) =>
      c.risk.criticalBelowBps <= c.risk.dangerBelowBps &&
      c.risk.dangerBelowBps <= c.risk.watchBelowBps,
    {
      message: 'require criticalBelowBps <= dangerBelowBps <= watchBelowBps',
      path: ['risk'],
    },
  )
  .refine((c) => c.risk.targetHealthFactorBps > c.risk.watchBelowBps, {
    message:
      'targetHealthFactorBps must exceed watchBelowBps, otherwise de-risking would immediately re-trigger',
    path: ['risk', 'targetHealthFactorBps'],
  });

export type OrchestratorConfig = z.output<typeof orchestratorConfigSchema>;
export type OrchestratorConfigInput = z.input<typeof orchestratorConfigSchema>;

/** Derived integer limits (micro-USD) so no floating point reaches decision code. */
export interface DerivedLimits {
  readonly maxSwapUsdMicro: bigint;
  readonly estimatedGasUsdMicro: bigint;
  readonly minNetBenefitUsdMicro: bigint;
}

export function deriveLimits(config: OrchestratorConfig): DerivedLimits {
  return {
    maxSwapUsdMicro: usdToMicro(config.swap.maxSwapUsd),
    estimatedGasUsdMicro: usdToMicro(config.swap.estimatedGasUsd),
    minNetBenefitUsdMicro: usdToMicro(config.swap.minNetBenefitUsd),
  };
}
