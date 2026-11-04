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
import { CachedSnapshotService, SnapshotService } from './services/snapshot';
import { DEMO_PORTFOLIOS } from './simulation/demo-portfolios';
import { SimulatedChain } from './simulation/simulated-chain';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

export interface WireOptions {
  /** Transport for the NEAR RPC client (tests inject a fake; production uses global fetch). */
  readonly fetchImpl?: typeof fetch;
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
    fetchImpl: simulation?.fetch ?? options.fetchImpl,
  });
  // Fail closed: an unreachable RPC or one serving another chain stops start-up.
  await assertChainId(rpc, env.NEAR_NETWORK);
  const viewer = new NearContractViewer(rpc);
  const tokens = new NearTokenReader(viewer);
  const burrow = { contractId: env.BURROW_CONTRACT_ID, oracleId: env.BURROW_ORACLE_ID };
  const lending = new BurrowLendingReader(viewer, burrow);
  const oracle = new BurrowPriceOracle(viewer, burrow);
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
  // In-memory: why this engine is dry-run only (packages/config). The cycle reads it back to report per-agent outcomes.
  const orchestratorAudit = new InMemoryAuditLog();
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
            // No market-data source is integrated yet: market intelligence, LP and allocation report
            // `insufficient_data`; the liquidation guardian works from the snapshot alone.
            market: null,
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

  return { cycle, snapshots: cachedSnapshots, policy, simulation };
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
