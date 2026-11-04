import {
  bigserial,
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** One execution of the agent pipeline for one account. */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    error: text('error'),
    /** Human-readable summary of what the cycle saw and decided (migration 0002). */
    outcome: text('outcome'),
    /** JSON-safe portfolio snapshot the agents saw. */
    snapshot: jsonb('snapshot').$type<unknown>(),
    /** 'simulation' rows come from a mock RPC and never touched a network. */
    dataSource: text('data_source', { enum: ['chain', 'simulation'] })
      .notNull()
      .default('chain'),
    /** Configured network at the time of the run (null for rows written before migration 0001). */
    network: text('network', { enum: ['mainnet', 'testnet'] }),
  },
  (t) => [index('runs_started_at_idx').on(t.startedAt)],
);

/** One agent proposal and everything that happened to it. */
export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    reason: text('reason').notNull(),
    intent: jsonb('intent').$type<unknown>().notNull(),
    /** Policy-engine valuation in micro-USD. */
    valueUsdMicro: bigint('value_usd_micro', { mode: 'bigint' }),
    status: text('status', {
      enum: [
        'rejected',
        'approved',
        'requires_approval',
        'planning_failed',
        'dry_run',
        'executed',
        'failed',
      ],
    }).notNull(),
    violations: jsonb('violations')
      .$type<Array<{ rule: string; message: string; severity: 'reject' | 'approval' }>>()
      .notNull()
      .default([]),
    planHash: text('plan_hash'),
    executionMode: text('execution_mode', { enum: ['dry-run', 'live'] }),
    txHash: text('tx_hash'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    dataSource: text('data_source', { enum: ['chain', 'simulation'] })
      .notNull()
      .default('chain'),
    network: text('network', { enum: ['mainnet', 'testnet'] }),
  },
  (t) => [
    index('proposals_run_idx').on(t.runId),
    index('proposals_account_status_created_idx').on(t.accountId, t.status, t.createdAt),
  ],
);

/** Append-only audit trail; rows are never updated or deleted by application code. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull(),
    type: text('type').notNull(),
    runId: text('run_id'),
    proposalId: text('proposal_id'),
    payload: jsonb('payload').$type<unknown>().notNull(),
  },
  (t) => [
    index('audit_events_at_idx').on(t.at),
    index('audit_events_proposal_idx').on(t.proposalId),
  ],
);

/**
 * Manually confirmed TESTNET transactions (apps/api testnet-tx). prepared -> approved -> submitted -> confirmed, or
 * rejected / failed / expired / unknown. Amounts in yoctoNEAR as decimal strings (u128 exceeds bigint columns).
 */
export const testnetTransactions = pgTable(
  'testnet_transactions',
  {
    id: text('id').primaryKey(),
    previewHash: text('preview_hash').notNull().unique(),
    network: text('network', { enum: ['testnet'] }).notNull(),
    signerId: text('signer_id').notNull(),
    operation: text('operation').notNull(),
    receiverId: text('receiver_id').notNull(),
    methodName: text('method_name').notNull(),
    preview: jsonb('preview').$type<unknown>().notNull(),
    status: text('status', {
      enum: [
        'prepared',
        'approved',
        'submitted',
        'confirmed',
        'rejected',
        'failed',
        'expired',
        'unknown',
      ],
    }).notNull(),
    depositYocto: text('deposit_yocto').notNull(),
    maxCostYocto: text('max_cost_yocto').notNull(),
    actualCostYocto: text('actual_cost_yocto'),
    txHash: text('tx_hash'),
    error: text('error'),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [index('testnet_transactions_status_idx').on(t.status)],
);

/**
 * One row per testnet asset per market-data fetch: the resolved reference price and every source observation behind
 * it (jsonb), so any price an agent saw can be traced to its source, timestamp and validity. Mainnet data only, applied
 * to testnet tokens: both networks are columns, fixed by CHECK constraints.
 */
export const marketPrices = pgTable(
  'market_prices',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id').notNull(),
    fetchedAt: ts('fetched_at').notNull(),
    marketNetwork: text('market_network', { enum: ['mainnet'] }).notNull(),
    executionNetwork: text('execution_network', { enum: ['testnet'] }).notNull(),
    testnetToken: text('testnet_token').notNull(),
    referenceSymbol: text('reference_symbol').notNull(),
    mainnetContract: text('mainnet_contract').notNull(),
    status: text('status', {
      enum: ['corroborated', 'single_source', 'price_disputed', 'unpriced'],
    }).notNull(),
    /** Exact decimal text, USD per whole token. Null when not usable. */
    priceUsd: text('price_usd'),
    source: text('source'),
    sourceAssetId: text('source_asset_id'),
    publishedAt: ts('published_at'),
    ageMs: integer('age_ms'),
    spreadBps: integer('spread_bps'),
    reason: text('reason'),
    observations: jsonb('observations').$type<unknown>().notNull(),
    sources: jsonb('sources').$type<unknown>().notNull(),
  },
  (t) => [
    index('market_prices_fetched_idx').on(t.fetchedAt),
    index('market_prices_token_idx').on(t.testnetToken, t.fetchedAt),
  ],
);

/** TESTNET yield estimates (Burrow, Rhea v1, Rhea DCL): one row per estimate per report, valid or rejected. */
export const yieldObservations = pgTable(
  'yield_observations',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id').notNull(),
    observedAt: ts('observed_at').notNull(),
    network: text('network', { enum: ['testnet'] }).notNull(),
    blockHeight: integer('block_height').notNull(),
    blockTimestamp: ts('block_timestamp').notNull(),
    source: text('source', { enum: ['burrow', 'rhea_v1', 'rhea_dcl'] }).notNull(),
    contract: text('contract').notNull(),
    methods: jsonb('methods').$type<string[]>().notNull(),
    marketId: text('market_id').notNull(),
    assetIds: jsonb('asset_ids').$type<string[]>().notNull(),
    yieldType: text('yield_type', {
      enum: ['lending_supply', 'lending_borrow', 'lp_fee'],
    }).notNull(),
    /** Exact decimal text, a fraction (0.05 = 5 %). */
    apr: text('apr'),
    apy: text('apy'),
    calculationMethod: text('calculation_method', {
      enum: ['source_reported', 'calculated'],
    }).notNull(),
    formula: text('formula'),
    observationPeriodSeconds: integer('observation_period_seconds'),
    utilization: text('utilization'),
    liquidityUsd: text('liquidity_usd'),
    volumeUsd: text('volume_usd'),
    priceStatus: text('price_status', { enum: ['fresh', 'missing', 'not_needed'] }).notNull(),
    sourceTimestamp: ts('source_timestamp'),
    validationStatus: text('validation_status', {
      enum: ['valid', 'rejected', 'informational'],
    }).notNull(),
    reasons: jsonb('reasons').$type<unknown>().notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
    sources: jsonb('sources').$type<unknown>().notNull(),
  },
  (t) => [
    index('yield_observations_observed_idx').on(t.observedAt),
    index('yield_observations_market_idx').on(t.source, t.marketId, t.observedAt),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
