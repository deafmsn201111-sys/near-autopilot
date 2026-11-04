import { randomUUID } from 'node:crypto';
import { HealthGuardianAgent, RebalancerAgent } from '@near-autopilot/agents';
import {
  BurrowClient,
  BurrowLendingReader,
  BurrowPlanner,
  BurrowPriceOracle,
  BurrowVerifier,
} from '@near-autopilot/burrow-adapter';
import type { ApiEnv } from '@near-autopilot/config';
import {
  accountIdSchema,
  assertChainId,
  type Agent,
  type Clock,
  type IdGenerator,
  type Logger,
  type PlanExecutor,
} from '@near-autopilot/core';
import {
  NearAccountReader,
  NearChainContextProvider,
  NearContractViewer,
  NearRpcClient,
  NearTokenReader,
  NearTransactionBroadcaster,
} from '@near-autopilot/near-adapter';
import {
  CapitalAllocatorAgent,
  InMemoryAuditLog,
  InMemoryControlStore,
  InMemoryIdempotencyStore,
  LiquidationGuardianAgent,
  LpOptimizerAgent,
  MarketIntelligenceAgent,
  Orchestrator,
  orchestratorConfigSchema,
} from '@near-autopilot/orchestrator';
import { PolicyEngine } from '@near-autopilot/policy-engine';
import { RheaPlanner, RheaSwapQuoter, StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import { DryRunExecutor, PlannerRegistry, TransactionExecutor } from '@near-autopilot/tx-execution';
import type { AutopilotConfig } from './autopilot-config';
import type { AutopilotRepository } from './repository';
import { loadSigner } from './signer';
import { AutopilotCycle } from './services/cycle';
import { OrchestratedCycle, RepositoryNotifier } from './services/orchestrated-cycle';
import { PersistentAuditLog } from './services/persistent-audit';
import { CachedSnapshotService, SnapshotService } from './services/snapshot';
import { DEMO_PORTFOLIOS } from './simulation/demo-portfolios';
import { ReferenceMarketProvider, ReferencePriceOracle } from './market-data/adapters';
import { REFERENCE_ASSETS } from './market-data/assets';
import { HttpJsonClient } from './market-data/http';
import type { MarketDataProvider, MarketReportSink } from './market-data/model';
import { ReferenceMarketData } from './market-data/service';
import { DefiLlamaSource, PythSource } from './market-data/sources';
import { SimulatedChain } from './simulation/simulated-chain';
import { usable } from './market-data/model';
import type { PoolHistory, YieldReportSink } from './yield/model';
import { YieldService } from './yield/service';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

export interface WireOptions {
  /** Transport for the NEAR RPC client (tests inject a fake; production uses global fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Transport for the MAINNET market-data sources (tests inject a fake). Never used for NEAR RPC. */
  readonly marketFetchImpl?: typeof fetch;
  /** Where market reports are persisted (Postgres in production). */
  readonly marketSink?: MarketReportSink;
  /** Where yield reports are persisted, and where earlier pool observations are read back (Postgres). */
  readonly yieldSink?: YieldReportSink & PoolHistory;
}

/**
 * Composition root: the only place concrete adapters are bound to ports. Async because it first proves the RPC
 * endpoint serves the configured network: `NEAR_NETWORK` alone is a claim, and every mainnet-live guard
 * (here and in loadApiEnv) relies on it being true.
 */
export async function wire(
  env: ApiEnv,
  config: AutopilotConfig,
  repo: AutopilotRepository,
  logger: Logger,
  options: WireOptions = {},
) {
  // Defence in depth: loadApiEnv already rejects this; a hand-built ApiEnv must not bypass it.
  if (env.EXECUTION_MODE === 'live' && env.NEAR_NETWORK === 'mainnet') {
    throw new Error(
      'Refusing to wire live execution on mainnet: this system never signs with mainnet keys',
    );
  }
  const simulation = env.DATA_SOURCE === 'simulation' ? simulatedChain(env, config) : null;
  // In simulation the RPC transport is the in-process mock: NEAR_RPC_URL is never contacted.
  const rpc = new NearRpcClient({
    url: env.NEAR_RPC_URL,
    // A hosted provider's key (FastNEAR etc.); headers are never logged. Not sent to the in-process simulation mock.
    headers:
      env.NEAR_RPC_API_KEY && !simulation
        ? { authorization: `Bearer ${env.NEAR_RPC_API_KEY}` }
        : undefined,
    fetchImpl: simulation?.fetch ?? options.fetchImpl,
    // Reads only: the client never retries a broadcast. The URL is not logged (hosted endpoints embed keys).
    onRetry: (e) =>
      logger.warn('rpc retry', {
        method: e.method,
        attempt: e.attempt,
        kind: e.kind,
        delayMs: e.delayMs,
      }),
  });
  // Fail closed: an unreachable RPC or one serving another chain stops start-up.
  await assertChainId(rpc, env.NEAR_NETWORK);
  const viewer = new NearContractViewer(rpc);
  const tokens = new NearTokenReader(viewer);
  const burrow = { contractId: env.BURROW_CONTRACT_ID, oracleId: env.BURROW_ORACLE_ID };
  const lending = new BurrowLendingReader(viewer, burrow);
  // MAINNET MARKET DATA -> TESTNET EXECUTION (MARKET_DATA=mainnet-reference; config enforces testnet + chain + dry-run).
  const market =
    env.MARKET_DATA === 'mainnet-reference' ? referenceMarket(env, tokens, logger, options) : null;
  const oracle = market ? new ReferencePriceOracle(market) : new BurrowPriceOracle(viewer, burrow);
  // TESTNET yield data (YIELD_DATA=testnet-onchain; config enforces mainnet-reference prices, hence testnet + dry-run).
  const yields =
    env.YIELD_DATA === 'testnet-onchain' && market
      ? testnetYields(env, config, rpc, market, logger, options)
      : null;
  const quoter = new RheaSwapQuoter(viewer, {
    contractId: env.RHEA_CONTRACT_ID,
    pools: new StaticPoolRegistry(
      config.rhea.pools.map((p) => ({
        poolId: p.poolId,
        tokenA: p.tokenA,
        tokenB: p.tokenB,
      })),
    ),
  });

  // Burrow transactions are only built from proofs minted by the verifier: chain id, deployed code at every
  // receiver, the oracle Burrow itself trusts, and the token's listing are checked on-chain first.
  const burrowClient = new BurrowClient(viewer, env.BURROW_CONTRACT_ID);
  const burrowVerifier = new BurrowVerifier(
    { rpc, client: burrowClient, clock: systemClock },
    {
      network: env.NEAR_NETWORK,
      contractId: env.BURROW_CONTRACT_ID,
      expectedOracleId: env.BURROW_ORACLE_ID,
    },
  );

  const planners = new PlannerRegistry()
    .register(new RheaPlanner(tokens, { contractId: env.RHEA_CONTRACT_ID }))
    .register(
      new BurrowPlanner({ verifier: burrowVerifier, client: burrowClient, clock: systemClock }),
    );

  const policy = new PolicyEngine(config.policy, { clock: systemClock, ids: uuidGenerator });

  let executor: PlanExecutor;
  if (env.EXECUTION_MODE === 'live') {
    const signer = loadSigner(env);
    if (!signer) {
      throw new Error(
        'EXECUTION_MODE=live requires a TransactionSigner: implement loadSigner() in src/signer.ts (see docs/security.md)',
      );
    }
    if (signer.accountId !== env.AUTOPILOT_ACCOUNT_ID)
      throw new Error('Signer account does not match AUTOPILOT_ACCOUNT_ID');
    executor = new TransactionExecutor({
      signer,
      contextProvider: new NearChainContextProvider(rpc),
      broadcaster: new NearTransactionBroadcaster(rpc),
      clock: systemClock,
      logger,
      approvals: policy,
    });
  } else {
    executor = new DryRunExecutor({ clock: systemClock, logger, approvals: policy });
  }

  const agents: Agent[] = [new HealthGuardianAgent(config.guardian)];
  if (config.rebalancer?.enabled) agents.push(new RebalancerAgent(config.rebalancer));

  const trackedTokens = config.policy.allowedTokens;
  const snapshots = new SnapshotService({
    accountId: env.AUTOPILOT_ACCOUNT_ID,
    trackedTokens,
    native: new NearAccountReader(rpc),
    tokens,
    lending,
    oracle,
    clock: systemClock,
  });
  const cachedSnapshots = new CachedSnapshotService(snapshots);

  const common = { accountId: env.AUTOPILOT_ACCOUNT_ID, executionMode: env.EXECUTION_MODE };
  // Idempotency and control stores stay in memory: why this engine is dry-run only (packages/config). The cycle reads
  // the audit back to report per-agent outcomes.
  // The chain is in memory; every entry is also written to Postgres audit_events (write-through, fails closed).
  const orchestratorAudit = new PersistentAuditLog(new InMemoryAuditLog(), repo, {
    dataSource: env.DATA_SOURCE,
    network: env.NEAR_NETWORK,
  });
  const cycle =
    env.AUTOPILOT_ENGINE === 'orchestrator'
      ? new OrchestratedCycle({
          ...common,
          audit: orchestratorAudit,
          // Same snapshot source, planners, policy engine and executor as the legacy path: one execution pipeline.
          orchestrator: new Orchestrator({
            accountId: env.AUTOPILOT_ACCOUNT_ID,
            config: orchestratorConfigSchema.parse(config.orchestrator ?? {}),
            agents: [
              new MarketIntelligenceAgent(),
              new LpOptimizerAgent(),
              new LiquidationGuardianAgent(),
              new CapitalAllocatorAgent(),
            ],
            snapshots,
            // Mainnet reference data when enabled (cross-check prices, 24h range); no yield source and no LP
            // positions exist, so allocation and LP report `insufficient_data`. Without it, market is null.
            market: market
              ? new ReferenceMarketProvider(
                  market,
                  yields,
                  config.orchestrator?.allocation?.assets.map((a) => a.token) ?? [],
                )
              : null,
            quoter,
            planner: planners,
            policy,
            executor,
            history: { stats: (account, since) => repo.getExecutionStats(account, since) },
            audit: orchestratorAudit,
            idempotency: new InMemoryIdempotencyStore(),
            control: new InMemoryControlStore(systemClock.now()),
            notifier: new RepositoryNotifier(repo, logger),
            clock: systemClock,
            logger,
          }),
          repo,
          clock: systemClock,
          ids: uuidGenerator,
          logger,
        })
      : new AutopilotCycle({
          ...common,
          agents,
          quoter,
          snapshots, // cycles always read fresh data
          planners,
          policy,
          executor,
          repo,
          clock: systemClock,
          ids: uuidGenerator,
          logger,
        });

  return { cycle, snapshots: cachedSnapshots, policy, simulation, market, yields };
}

function testnetYields(
  env: ApiEnv,
  config: AutopilotConfig,
  rpc: NearRpcClient,
  market: MarketDataProvider,
  logger: Logger,
  options: WireOptions,
): YieldService {
  if (
    env.NEAR_NETWORK !== 'testnet' ||
    env.DATA_SOURCE !== 'chain' ||
    env.EXECUTION_MODE !== 'dry-run'
  ) {
    // Defence in depth: loadApiEnv already rejects this; a hand-built ApiEnv must not bypass it.
    throw new Error(
      'YIELD_DATA=testnet-onchain requires NEAR_NETWORK=testnet, DATA_SOURCE=chain, EXECUTION_MODE=dry-run',
    );
  }
  const y = config.yield ?? {
    rheaV1Pools: [],
    dclPools: [],
    maxAprBps: 10_000,
    maxUtilizationBps: 9_500,
    minLiquidityUsd: 1_000,
    minObservationSeconds: 3_600,
    maxObservationSeconds: 604_800,
  };
  const freshness = config.orchestrator?.freshness?.maxMarketAgeSeconds ?? 300;
  return new YieldService({
    rpc,
    burrowContract: env.BURROW_CONTRACT_ID,
    rheaContract: env.RHEA_CONTRACT_ID,
    dclContract: env.RHEA_DCL_CONTRACT_ID ?? null,
    rheaV1Pools: y.rheaV1Pools,
    dclPools: y.dclPools,
    allowlist: new Set(config.rhea.pools.map((p) => p.poolId)),
    allowedTokens: new Set(config.policy.allowedTokens),
    prices: async () => {
      const report = await market.report();
      return (token) => {
        const a = report.assets.find((x) => x.testnetToken === token);
        return a && usable(a) ? a.priceUsd : null;
      };
    },
    history: options.yieldSink ?? null,
    limits: {
      maxAprBps: y.maxAprBps,
      maxUtilizationBps: y.maxUtilizationBps,
      minLiquidityUsd: y.minLiquidityUsd,
      maxAgeSeconds: freshness,
    },
    maxPriceDeviationBps: config.policy.maxOracleDeviationBps,
    minPeriodSeconds: y.minObservationSeconds,
    maxPeriodSeconds: y.maxObservationSeconds,
    ...(options.yieldSink ? { sink: options.yieldSink } : {}),
    now: () => systemClock.now(),
    ids: () => uuidGenerator.next(),
    onError: (message) => logger.warn(message),
  });
}

function referenceMarket(
  env: ApiEnv,
  tokens: NearTokenReader,
  logger: Logger,
  options: WireOptions,
): MarketDataProvider {
  if (
    env.NEAR_NETWORK !== 'testnet' ||
    env.DATA_SOURCE !== 'chain' ||
    env.EXECUTION_MODE !== 'dry-run'
  ) {
    // Defence in depth: loadApiEnv already rejects this; a hand-built ApiEnv must not bypass it.
    throw new Error(
      'MARKET_DATA=mainnet-reference requires NEAR_NETWORK=testnet, DATA_SOURCE=chain, EXECUTION_MODE=dry-run',
    );
  }
  const http = new HttpJsonClient({
    fetchImpl: options.marketFetchImpl,
    maxConcurrent: 2,
    // The source URL is logged, never headers (the Pyth key travels in Authorization).
    onRetry: (e) =>
      logger.warn('market data retry', { attempt: e.attempt, kind: e.kind, delayMs: e.delayMs }),
  });
  const llama = new DefiLlamaSource({
    baseUrl: env.DEFILLAMA_URL,
    http,
    freshness: { maxAgeMs: 180_000, maxFutureSkewMs: 5_000 },
  });
  return new ReferenceMarketData({
    assets: REFERENCE_ASSETS,
    // Priority: Pyth first, DefiLlama second.
    sources: [
      new PythSource({ baseUrl: env.PYTH_HERMES_URL, apiKey: env.PYTH_API_KEY, http }),
      llama,
    ],
    history: llama,
    testnetDecimals: async (token) =>
      (await tokens.getMetadata(accountIdSchema.parse(token))).decimals,
    now: () => systemClock.now(),
    ids: () => uuidGenerator.next(),
    ...(options.marketSink ? { sink: options.marketSink } : {}),
    onError: (message) => logger.warn(message),
  });
}

/**
 * Builds the mock chain for DATA_SOURCE=simulation, after re-checking the rules loadApiEnv enforces (a hand-built
 * env must not bypass them) and that the policy allowlists admit the demo assets (otherwise every simulated proposal
 * would just be rejected, which demonstrates nothing).
 */
function simulatedChain(env: ApiEnv, config: AutopilotConfig): SimulatedChain {
  if (env.EXECUTION_MODE !== 'dry-run') {
    throw new Error('DATA_SOURCE=simulation requires EXECUTION_MODE=dry-run');
  }
  const chain = new SimulatedChain({
    network: env.NEAR_NETWORK,
    accountId: env.AUTOPILOT_ACCOUNT_ID,
    burrowContractId: env.BURROW_CONTRACT_ID,
    burrowOracleId: env.BURROW_ORACLE_ID,
    rheaContractId: env.RHEA_CONTRACT_ID,
    portfolio: DEMO_PORTFOLIOS[env.SIMULATION_PORTFOLIO],
    clock: systemClock,
    otherTokens: config.policy.allowedTokens,
  });
  const missing = [
    ...chain.tokens.filter((t) => !config.policy.allowedTokens.includes(t)),
    ...[...chain.tokens, env.BURROW_CONTRACT_ID].filter(
      (c) => !config.policy.allowedContracts.includes(c),
    ),
  ];
  if (missing.length > 0) {
    throw new Error(
      `DATA_SOURCE=simulation on ${env.NEAR_NETWORK}: the policy allowlists must include ${[...new Set(missing)].join(', ')} ` +
        `(use config/autopilot.${env.NEAR_NETWORK === 'testnet' ? 'testnet.' : ''}example.json)`,
    );
  }
  return chain;
}
