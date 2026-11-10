import { readFileSync } from 'node:fs';
import { accountIdSchema, type AccountId } from '@near-autopilot/core';
import { guardianConfigSchema, rebalancerConfigSchema } from '@near-autopilot/agents';
import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import { policyConfigSchema } from '@near-autopilot/policy-engine';
import { z } from 'zod';

export const marketConfigSchema = z
  .object({
    policy: policyConfigSchema,
    guardian: guardianConfigSchema,
    /** Optional; the rebalancer is only registered when configured and enabled. */
    rebalancer: rebalancerConfigSchema.optional(),
    rhea: z
      .object({
        /** Reviewed pools the quoter may use. Empty means no swaps can be quoted. */
        pools: z
          .array(
            z
              .object({
                poolId: z.number().int().nonnegative(),
                tokenA: accountIdSchema,
                tokenB: accountIdSchema,
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({ pools: [] }),
    /**
     * Yield data (YIELD_DATA=mainnet-onchain). Pools listed here are OBSERVED only; strategic use of a Rhea v1
     * pool still requires it in `rhea.pools` (the operator allowlist), and no DCL pool is reviewed.
     */
    yield: z
      .object({
        rheaV1Pools: z.array(z.number().int().nonnegative()).max(20).default([]),
        dclPools: z.array(z.string().min(1).max(200)).max(20).default([]),
        /** A reported APR above this (bps) is implausible and rejected. */
        maxAprBps: z.number().int().min(1).max(100_000).default(10_000),
        /** At or above this utilisation (bps) withdrawals may be impossible: rejected. */
        maxUtilizationBps: z.number().int().min(1).max(10_000).default(9_500),
        /** Minimum withdrawable / pooled value in USD. */
        minLiquidityUsd: z.number().int().min(0).default(1_000),
        /** Fee APR observation period bounds (seconds). */
        minObservationSeconds: z.number().int().min(60).default(3_600),
        maxObservationSeconds: z.number().int().min(60).default(604_800),
      })
      .strict()
      .refine((y) => y.minObservationSeconds <= y.maxObservationSeconds, {
        message: 'minObservationSeconds must not exceed maxObservationSeconds',
      })
      .optional(),
    /** The orchestrator agents (the collector runs AUTOPILOT_ENGINE=orchestrator); every field has a conservative default. */
    orchestrator: orchestratorConfigSchema.optional(),
  })
  .strict();

export type MarketConfig = z.output<typeof marketConfigSchema>;

export function parseMarketConfig(json: unknown, expectedSigner: AccountId): MarketConfig {
  const parsed = marketConfigSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid market config:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
  if (parsed.data.policy.signerAccountId !== expectedSigner) {
    throw new Error(
      `policy.signerAccountId (${parsed.data.policy.signerAccountId}) must equal AUTOPILOT_ACCOUNT_ID (${expectedSigner})`,
    );
  }
  return parsed.data;
}

export function loadMarketConfig(path: string, expectedSigner: AccountId): MarketConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `Cannot read market config at ${path}. It ships with the repository (config/market.json).`,
      { cause },
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Market config at ${path} is not valid JSON`, { cause });
  }
  return parseMarketConfig(json, expectedSigner);
}
