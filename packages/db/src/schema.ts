import {
  bigserial,
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { sql } from 'drizzle-orm';

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
 * Every policy decision, with all its checks and the exact inputs it was made on (intent, plan, snapshot, history as
 * canonical JSON), so it can be re-evaluated later. `verdict` is ALLOW / WARN / BLOCK; `policy_version` identifies the
 * rules and the config in force; `snapshot_id` is the content hash of the snapshot. Append-only.
 */
export const policyVerdicts = pgTable(
  'policy_verdicts',
  {
    id: text('id').primaryKey(),
    evaluatedAt: ts('evaluated_at').notNull(),
    engine: text('engine', { enum: ['legacy', 'orchestrator'] }).notNull(),
    runId: text('run_id'),
    intentId: text('intent_id').notNull(),
    intentKind: text('intent_kind').notNull(),
    verdict: text('verdict', { enum: ['ALLOW', 'WARN', 'BLOCK'] }).notNull(),
    outcome: text('outcome', { enum: ['approve', 'require_approval', 'reject'] }).notNull(),
    policyVersion: text('policy_version').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    planHash: text('plan_hash').notNull(),
    /** Policy-engine valuation in micro-USD, as text. */
    valueUsdMicro: text('value_usd_micro'),
    checks: jsonb('checks')
      .$type<Array<{ rule: string; result: 'PASS' | 'WARN' | 'BLOCK'; messages: string[] }>>()
      .notNull(),
    violations: jsonb('violations')
      .$type<Array<{ rule: string; message: string; severity: 'reject' | 'approval' }>>()
      .notNull(),
    input: jsonb('input').$type<unknown>().notNull(),
    dataSource: text('data_source', { enum: ['chain', 'simulation'] }).notNull(),
    network: text('network', { enum: ['mainnet', 'testnet'] }).notNull(),
  },
  (t) => [
    index('policy_verdicts_evaluated_idx').on(t.evaluatedAt),
    index('policy_verdicts_intent_idx').on(t.intentId),
    index('policy_verdicts_verdict_idx').on(t.verdict, t.evaluatedAt),
  ],
);

/**
 * Shadow Gateway routing (append-only): venues quoted for an approved plan or a reference probe, and the venue chosen.
 * Quotes only; nothing in this table was signed or sent.
 */
export const executionRoutes = pgTable(
  'execution_routes',
  {
    id: text('id').primaryKey(),
    createdAt: ts('created_at').notNull(),
    origin: text('origin', { enum: ['gateway', 'probe'] }).notNull(),
    outcome: text('outcome', { enum: ['routed', 'no_route', 'not_a_swap', 'refused'] }).notNull(),
    decisionId: text('decision_id'),
    intentId: text('intent_id'),
    planHash: text('plan_hash'),
    tokenIn: text('token_in'),
    tokenOut: text('token_out'),
    /** Raw input amount as decimal text (u128). */
    amountIn: text('amount_in'),
    chosenVenue: text('chosen_venue'),
    advantageBps: integer('advantage_bps'),
    reason: text('reason').notNull(),
    quotes: jsonb('quotes').$type<unknown>().notNull(),
    dataSource: text('data_source', { enum: ['chain', 'simulation'] }).notNull(),
    network: text('network', { enum: ['mainnet', 'testnet'] }).notNull(),
  },
  (t) => [
    index('execution_routes_created_idx').on(t.createdAt),
    index('execution_routes_origin_idx').on(t.origin, t.createdAt),
    index('execution_routes_decision_idx').on(t.decisionId),
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
    /** `none`: read-only shadow analysis of a simulated portfolio; nothing executed anywhere. */
    executionNetwork: text('execution_network', { enum: ['testnet', 'none'] }).notNull(),
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
    /** Network the data was READ from. Nothing is executed from these rows. */
    network: text('network', { enum: ['testnet', 'mainnet'] }).notNull(),
    blockHeight: integer('block_height').notNull(),
    blockTimestamp: ts('block_timestamp').notNull(),
    source: text('source', { enum: ['burrow', 'rhea_v1', 'rhea_dcl'] }).notNull(),
    contract: text('contract').notNull(),
    methods: jsonb('methods').$type<string[]>().notNull(),
    marketId: text('market_id').notNull(),
    assetIds: jsonb('asset_ids').$type<string[]>().notNull(),
    yieldType: text('yield_type', {
      enum: ['lending_supply', 'lending_reward', 'lending_borrow', 'lp_fee'],
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
    /** scheduled (collector) | on_demand (an explicit cycle). Dashboard reads never create rows. */
    origin: text('origin', { enum: ['scheduled', 'on_demand'] })
      .notNull()
      .default('on_demand'),
  },
  (t) => [
    index('yield_observations_observed_idx').on(t.observedAt),
    index('yield_observations_market_idx').on(t.source, t.marketId, t.observedAt),
  ],
);

/* ------------------------------ autonomous shadow collector (mainnet, read-only) ------------------------------ */

/** One collector cycle. `trigger`: scheduled (the collector) or on_demand (an explicit request). */
export const collectorCycles = pgTable(
  'collector_cycles',
  {
    id: text('id').primaryKey(),
    trigger: text('trigger', { enum: ['scheduled', 'on_demand'] }).notNull(),
    status: text('status', { enum: ['running', 'success', 'partial', 'failed'] }).notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    durationMs: integer('duration_ms'),
    records: integer('records').notNull().default(0),
    /** Per-source health: [{source, health, detail, records, durationMs}]. */
    sources: jsonb('sources').$type<unknown>().notNull(),
    error: text('error'),
    snapshotId: text('snapshot_id'),
    registryScan: boolean('registry_scan').notNull().default(false),
  },
  (t) => [
    index('collector_cycles_started_idx').on(t.startedAt),
    uniqueIndex('collector_cycles_one_running')
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);

/** The market state one cycle saw: one pinned mainnet block, one price report. Portfolios are analysed against it. */
export const marketSnapshots = pgTable(
  'market_snapshots',
  {
    id: text('id').primaryKey(),
    cycleId: text('cycle_id').notNull(),
    network: text('network', { enum: ['mainnet'] }).notNull(),
    blockHeight: integer('block_height').notNull(),
    blockTimestamp: ts('block_timestamp').notNull(),
    takenAt: ts('taken_at').notNull(),
    marketReportId: text('market_report_id'),
    yieldReportId: text('yield_report_id'),
    summary: jsonb('summary').$type<unknown>().notNull(),
  },
  (t) => [
    index('market_snapshots_taken_idx').on(t.takenAt),
    index('market_snapshots_block_idx').on(t.blockHeight),
  ],
);

/** Every price from every source, kept separately per source (no merged price is stored here). */
export const priceObservations = pgTable(
  'price_observations',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id').notNull(),
    asset: text('asset').notNull(),
    source: text('source', {
      enum: ['pyth', 'defillama', 'coinbase', 'kraken', 'binance'],
    }).notNull(),
    sourceAssetId: text('source_asset_id').notNull(),
    priceUsd: text('price_usd'),
    quoteCurrency: text('quote_currency').notNull(),
    confidence: text('confidence'),
    publishedAt: ts('published_at'),
    observedAt: ts('observed_at').notNull(),
    ageMs: integer('age_ms'),
    /** valid | stale | future | invalid | low_confidence | not_found | unavailable | mapping_mismatch */
    status: text('status').notNull(),
    reason: text('reason'),
  },
  (t) => [
    index('price_observations_asset_idx').on(t.asset, t.observedAt),
    index('price_observations_snapshot_idx').on(t.snapshotId),
  ],
);

/** Rhea pool registry: every pool ever discovered, with its latest classification. */
export const rheaPools = pgTable(
  'rhea_pools',
  {
    /** `v1:<id>` or `dcl:<pool_id>`. */
    poolKey: text('pool_key').primaryKey(),
    contract: text('contract').notNull(),
    family: text('family', { enum: ['v1', 'dcl'] }).notNull(),
    poolType: text('pool_type').notNull(),
    tokens: jsonb('tokens').$type<string[]>().notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull(),
    lastBlockHeight: integer('last_block_height').notNull(),
    feeBps: integer('fee_bps'),
    tvlUsd: text('tvl_usd'),
    /** OK (all tokens priced >= 0.9 confidence) | LOW_CONFIDENCE | UNPRICED */
    priceQuality: text('price_quality').notNull(),
    /** DISCOVERED | LIQUID | ANALYTICS_ELIGIBLE | LP_SIMULATION_ELIGIBLE | LOW_LIQUIDITY | UNSUPPORTED | DATA_INVALID */
    category: text('category').notNull(),
    modelStatus: text('model_status').notNull(),
    reasons: jsonb('reasons').$type<unknown>().notNull(),
    active: boolean('active').notNull().default(true),
    latest: jsonb('latest').$type<unknown>().notNull(),
  },
  (t) => [
    index('rhea_pools_category_idx').on(t.category),
    index('rhea_pools_family_idx').on(t.family),
  ],
);

/** One reading of one (tracked) pool at one block. Cumulative volumes make fee yields computable over any window. */
export const rheaPoolObservations = pgTable(
  'rhea_pool_observations',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id').notNull(),
    poolKey: text('pool_key').notNull(),
    blockHeight: integer('block_height').notNull(),
    blockTimestamp: ts('block_timestamp').notNull(),
    reserves: jsonb('reserves').$type<string[]>().notNull(),
    volumesIn: jsonb('volumes_in').$type<string[] | null>(),
    feeBps: integer('fee_bps'),
    adminFeeBps: integer('admin_fee_bps'),
    tvlUsd: text('tvl_usd'),
    priceQuality: text('price_quality').notNull(),
    quality: text('quality').notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
  },
  (t) => [
    index('rhea_pool_observations_pool_idx').on(t.poolKey, t.blockTimestamp),
    index('rhea_pool_observations_snapshot_idx').on(t.snapshotId),
    uniqueIndex('rhea_pool_observations_unique').on(t.poolKey, t.blockHeight),
  ],
);

/** Burrow market registry and its per-snapshot readings. */
export const burrowMarkets = pgTable('burrow_markets', {
  token: text('token').primaryKey(),
  contract: text('contract').notNull(),
  firstSeenAt: ts('first_seen_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull(),
  status: text('status').notNull(),
  latest: jsonb('latest').$type<unknown>().notNull(),
});

export const burrowMarketObservations = pgTable(
  'burrow_market_observations',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id').notNull(),
    token: text('token').notNull(),
    blockHeight: integer('block_height').notNull(),
    blockTimestamp: ts('block_timestamp').notNull(),
    supplyApr: text('supply_apr'),
    borrowApr: text('borrow_apr'),
    utilization: text('utilization'),
    availableUsd: text('available_usd'),
    rewardApr: text('reward_apr'),
    quality: text('quality').notNull(),
    raw: jsonb('raw').$type<unknown>().notNull(),
  },
  (t) => [
    index('burrow_market_observations_token_idx').on(t.token, t.blockTimestamp),
    uniqueIndex('burrow_market_observations_unique').on(t.token, t.blockHeight),
  ],
);

/** Per snapshot and demo portfolio: agents, decision, LP entry simulations and the strategy comparison. */
export const portfolioAnalyses = pgTable(
  'portfolio_analyses',
  {
    id: text('id').primaryKey(),
    snapshotId: text('snapshot_id').notNull(),
    portfolioId: text('portfolio_id').notNull(),
    runId: text('run_id'),
    createdAt: ts('created_at').notNull(),
    outcome: text('outcome'),
    result: jsonb('result').$type<unknown>().notNull(),
  },
  (t) => [
    index('portfolio_analyses_snapshot_idx').on(t.snapshotId),
    uniqueIndex('portfolio_analyses_unique').on(t.snapshotId, t.portfolioId),
  ],
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type ProposalRow = typeof proposals.$inferSelect;
export type NewProposalRow = typeof proposals.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
