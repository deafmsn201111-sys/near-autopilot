import { accountIdSchema, hasAtMostDecimals } from '@near-autopilot/core';
import { z } from 'zod';

const yocto = z
  .string()
  .regex(/^\d+$/)
  .transform((v) => BigInt(v));

/** USD limits are enforced in micro-USD, so a config value must convert to it exactly (no silent rounding). */
const usdAmount = (base: z.ZodNumber) =>
  base.max(1_000_000_000).refine((v) => hasAtMostDecimals(v, 6), {
    message: 'must have at most 6 decimal places (micro-USD precision)',
  });

/** 0.05 NEAR kept free for gas. */
const DEFAULT_NATIVE_RESERVE = '50000000000000000000000';

export const policyConfigSchema = z
  .object({
    /** Master switch / kill switch. When false every action is rejected. */
    enabled: z.boolean().default(true),
    /** The only account allowed to sign. */
    signerAccountId: accountIdSchema,
    /** Contracts a transaction may be addressed to (token contracts and protocol contracts). */
    allowedContracts: z.array(accountIdSchema).min(1),
    /** Where ft_transfer_call may send tokens (protocol contracts only; never arbitrary accounts). */
    allowedRecipients: z.array(accountIdSchema).min(1),
    allowedTokens: z.array(accountIdSchema).min(1),
    allowedMethods: z.array(z.string().min(1)).min(1).default(['ft_transfer_call']),
    maxDepositYocto: yocto.default('1'),
    maxActionUsd: usdAmount(z.number().positive()),
    dailyLimitUsd: usdAmount(z.number().positive()),
    /** Actions above this value are held for a human instead of executing. */
    approvalThresholdUsd: usdAmount(z.number().nonnegative()),
    maxSlippageBps: z.number().int().min(0).max(1_000),
    /** Max shortfall of a quote versus the oracle-implied output. */
    maxOracleDeviationBps: z.number().int().min(0).max(2_000),
    maxPriceAgeSeconds: z.number().int().positive().default(120),
    minNativeReserveYocto: yocto.default(DEFAULT_NATIVE_RESERVE),
    /** Minimum gap between executed swaps. Risk-reducing actions are exempt. */
    cooldownSeconds: z.number().int().nonnegative().default(300),
    approvalTtlSeconds: z.number().int().positive().default(120),
  })
  .strict()
  .refine((c) => c.approvalThresholdUsd <= c.maxActionUsd, {
    message: 'approvalThresholdUsd must be <= maxActionUsd',
    path: ['approvalThresholdUsd'],
  })
  .refine((c) => c.maxActionUsd <= c.dailyLimitUsd, {
    message: 'maxActionUsd must be <= dailyLimitUsd',
    path: ['maxActionUsd'],
  });

export type PolicyConfig = z.output<typeof policyConfigSchema>;
export type PolicyConfigInput = z.input<typeof policyConfigSchema>;
