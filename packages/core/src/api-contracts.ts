import { z } from 'zod';

/**
 * Wire format shared by the API (producer) and dashboard (consumer).
 * Amounts are decimal strings; USD values are decimal strings with 2-6 fractional digits.
 */
const usdString = z.string().regex(/^-?\d+\.\d{2,6}$/);
const rawString = z.string().regex(/^\d+$/);

/**
 * Where a value came from. `chain`: read from the NEAR network named in `network`. `simulation`: a deterministic demo
 * portfolio served by an in-process mock RPC; nothing was read from or sent to any network. Every DTO that shows
 * portfolio or pipeline data carries both, so a consumer can never mistake simulated or testnet data for mainnet.
 */
export const dataSourceSchema = z.enum(['chain', 'simulation']);
export type DataSource = z.infer<typeof dataSourceSchema>;
const provenance = {
  dataSource: dataSourceSchema,
  network: z.enum(['mainnet', 'testnet']),
};
export interface Provenance {
  readonly dataSource: DataSource;
  readonly network: 'mainnet' | 'testnet';
}

export const holdingDtoSchema = z.object({
  token: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
  raw: rawString,
  valueUsd: usdString.nullable(),
});

export const portfolioDtoSchema = z.object({
  ...provenance,
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
  /**
   * Tracked tokens with and without a usable oracle price. A token without one is excluded from totals and from every
   * decision; it is never valued at zero.
   */
  pricing: z.object({ priced: z.array(z.string()), unpriced: z.array(z.string()) }),
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
  ...provenance,
  /** `dry-run`: planned and policy-checked, never sent. `live`: signed and sent. null: never reached execution. */
  executionMode: z.enum(['dry-run', 'live']).nullable(),
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
  ...provenance,
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed']),
  error: z.string().nullable(),
  /** What the cycle saw and decided, including why it did nothing (missing prices, insufficient_data, ...). */
  outcome: z.string().nullable(),
  proposalCount: z.number().int(),
});
export type RunDto = z.infer<typeof runDtoSchema>;

export const policyDtoSchema = z.object({
  ...provenance,
  /** Which decision pipeline runs: packages/agents (`legacy`) or packages/orchestrator. */
  engine: z.enum(['legacy', 'orchestrator']),
  /** Demo portfolio id when dataSource is `simulation`, else null. */
  simulationPortfolio: z.string().nullable(),
  /** `mainnet-reference`: MAINNET market data priced onto TESTNET tokens (labelled reference prices). */
  marketData: z.enum(['none', 'mainnet-reference', 'mainnet-live']),
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

/** A manually confirmed testnet transaction (apps/api testnet-tx). Amounts are NEAR decimal strings. */
export const testnetTxDtoSchema = z.object({
  id: z.string(),
  status: z.enum([
    'prepared',
    'approved',
    'submitted',
    'confirmed',
    'rejected',
    'failed',
    'expired',
    'unknown',
  ]),
  operation: z.string(),
  signerId: z.string(),
  receiverId: z.string(),
  methodName: z.string(),
  depositNear: z.string(),
  maxCostNear: z.string(),
  actualCostNear: z.string().nullable(),
  txHash: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestnetTxDto = z.infer<typeof testnetTxDtoSchema>;
export const testnetTxResponseSchema = z.object({
  budgetNear: z.string(),
  spentNear: z.string(),
  transactions: z.array(testnetTxDtoSchema),
});
export type TestnetTxResponse = z.infer<typeof testnetTxResponseSchema>;
/** Price providers: two oracles/aggregators and three exchanges (NEAR/USD quorum). */
export const marketSourceSchema = z.enum(['pyth', 'defillama', 'coinbase', 'kraken', 'binance']);
/** One source's value for one asset (always MAINNET market data). */
export const marketObservationDtoSchema = z.object({
  source: marketSourceSchema,
  network: z.literal('mainnet'),
  assetId: z.string(),
  contract: z.string().nullable(),
  priceUsd: z.string().nullable(),
  /** Always USD once resolved; a USDT exchange quote is converted first (the asset id names the conversion). */
  quoteCurrency: z.enum(['USD', 'USDT']),
  confidence: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  ageMs: z.number().nullable(),
  status: z.enum([
    'valid',
    'stale',
    'future',
    'invalid',
    'low_confidence',
    'not_found',
    'mapping_mismatch',
    'not_entitled',
    'unavailable',
  ]),
  reason: z.string().nullable(),
});
export const marketAssetDtoSchema = z.object({
  testnetToken: z.string(),
  referenceSymbol: z.string(),
  mainnetContract: z.string(),
  status: z.enum(['corroborated', 'single_source', 'price_disputed', 'unpriced']),
  /** Exact decimal text, USD per whole token. */
  priceUsd: z.string().nullable(),
  source: z.string().nullable(),
  sourceAssetId: z.string().nullable(),
  publishedAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  spreadBps: z.number().nullable(),
  range24hBps: z.number().nullable(),
  reason: z.string().nullable(),
  label: z.string(),
  observations: z.array(marketObservationDtoSchema),
});
export const marketDataDtoSchema = z.object({
  /** False when this API does not use mainnet reference prices (simulation, or MARKET_DATA=none). */
  enabled: z.boolean(),
  flow: z.string(),
  marketNetwork: z.literal('mainnet'),
  /** `none`: shadow analysis, nothing is executed anywhere. */
  executionNetwork: z.enum(['mainnet', 'testnet', 'none']),
  fetchedAt: z.string().nullable(),
  sources: z.array(
    z.object({
      source: marketSourceSchema,
      health: z.enum(['ok', 'degraded', 'unavailable']),
      detail: z.string().nullable(),
    }),
  ),
  assets: z.array(marketAssetDtoSchema),
  error: z.string().nullable(),
});
export type MarketDataDto = z.infer<typeof marketDataDtoSchema>;

export const yieldEstimateDtoSchema = z.object({
  source: z.enum(['burrow', 'rhea_v1', 'rhea_dcl']),
  network: z.enum(['testnet', 'mainnet']),
  contract: z.string(),
  methods: z.array(z.string()),
  marketId: z.string(),
  assetIds: z.array(z.string()),
  yieldType: z.enum(['lending_supply', 'lending_reward', 'lending_borrow', 'lp_fee']),
  /** Exact decimal text, a fraction (0.05 = 5 %). */
  apr: z.string().nullable(),
  apy: z.string().nullable(),
  calculationMethod: z.enum(['source_reported', 'calculated']),
  formula: z.string().nullable(),
  observationPeriodSeconds: z.number().int().nullable(),
  utilization: z.string().nullable(),
  liquidityUsd: z.string().nullable(),
  volumeUsd: z.string().nullable(),
  priceStatus: z.enum(['fresh', 'missing', 'not_needed']),
  blockHeight: z.number().int(),
  blockTimestamp: z.string(),
  sourceTimestamp: z.string().nullable(),
  validationStatus: z.enum(['valid', 'rejected', 'informational']),
  reasons: z.array(z.object({ code: z.string(), detail: z.string() })),
});
export const yieldDataDtoSchema = z.object({
  /** False unless YIELD_DATA=testnet-onchain. */
  enabled: z.boolean(),
  label: z.string(),
  network: z.enum(['testnet', 'mainnet']).nullable(),
  observedAt: z.string().nullable(),
  blockHeight: z.number().int().nullable(),
  sources: z.array(
    z.object({
      source: z.enum(['burrow', 'rhea_v1', 'rhea_dcl']),
      contract: z.string(),
      health: z.enum(['ok', 'unavailable', 'disabled']),
      detail: z.string().nullable(),
      marketsRead: z.number().int(),
    }),
  ),
  counts: z.object({
    valid: z.number().int(),
    rejected: z.number().int(),
    informational: z.number().int(),
  }),
  estimates: z.array(yieldEstimateDtoSchema),
  error: z.string().nullable(),
});
export type YieldDataDto = z.infer<typeof yieldDataDtoSchema>;
export const proposalsResponseSchema = z.object({ proposals: z.array(proposalDtoSchema) });
export const triggerRunResponseSchema = z.object({
  run: runDtoSchema,
  proposals: z.array(proposalDtoSchema),
});
