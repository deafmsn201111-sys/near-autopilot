import { z } from 'zod';

/**
 * Wire format shared by the API (producer) and dashboard (consumer).
 * Amounts are decimal strings; USD values are decimal strings with 2-6 fractional digits.
 */
const usdString = z.string().regex(/^-?\d+\.\d{2,6}$/);
const rawString = z.string().regex(/^\d+$/);

export const holdingDtoSchema = z.object({
  token: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
  raw: rawString,
  valueUsd: usdString.nullable(),
});

export const portfolioDtoSchema = z.object({
  accountId: z.string(),
  asOf: z.string(),
  pricesAsOf: z.string(),
  nativeBalanceYocto: rawString,
  walletValueUsd: usdString,
  suppliedValueUsd: usdString,
  borrowedValueUsd: usdString,
  netValueUsd: usdString,
  /** null when there is no debt. */
  healthFactor: z.number().nullable(),
  wallet: z.array(holdingDtoSchema),
  collateral: z.array(holdingDtoSchema),
  supplied: z.array(holdingDtoSchema),
  borrowed: z.array(holdingDtoSchema),
});
export type PortfolioDto = z.infer<typeof portfolioDtoSchema>;

export const proposalStatusSchema = z.enum([
  'rejected',
  /** Approved by policy; execution not yet resolved. A row stuck here after a crash needs manual review. */
  'approved',
  'requires_approval',
  'planning_failed',
  'dry_run',
  'executed',
  'failed',
]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalDtoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string(),
  kind: z.string(),
  summary: z.string(),
  reason: z.string(),
  status: proposalStatusSchema,
  valueUsd: usdString.nullable(),
  violations: z.array(z.object({ rule: z.string(), message: z.string() })),
  txHash: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type ProposalDto = z.infer<typeof proposalDtoSchema>;

export const runDtoSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  error: z.string().nullable(),
  proposalCount: z.number().int(),
});
export type RunDto = z.infer<typeof runDtoSchema>;

export const policyDtoSchema = z.object({
  enabled: z.boolean(),
  executionMode: z.enum(['dry-run', 'live']),
  maxActionUsd: usdString,
  dailyLimitUsd: usdString,
  approvalThresholdUsd: usdString,
  maxSlippageBps: z.number().int(),
  maxOracleDeviationBps: z.number().int(),
  cooldownSeconds: z.number().int(),
  allowedContracts: z.array(z.string()),
  allowedTokens: z.array(z.string()),
  guardian: z.object({ triggerHealthFactor: z.number(), targetHealthFactor: z.number() }),
});
export type PolicyDto = z.infer<typeof policyDtoSchema>;

export const runsResponseSchema = z.object({ runs: z.array(runDtoSchema) });
export const proposalsResponseSchema = z.object({ proposals: z.array(proposalDtoSchema) });
export const triggerRunResponseSchema = z.object({
  run: runDtoSchema,
  proposals: z.array(proposalDtoSchema),
});
