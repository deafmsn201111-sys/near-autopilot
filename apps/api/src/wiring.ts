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
import type {
  Agent,
  Clock,
  IdGenerator,
  Logger,
  PlanExecutor,
  TokenId,
} from '@near-autopilot/core';
import {
  NearAccountReader,
  NearChainContextProvider,
  NearContractViewer,
  NearRpcClient,
  NearTokenReader,
  NearTransactionBroadcaster,
} from '@near-autopilot/near-adapter';
import { PolicyEngine } from '@near-autopilot/policy-engine';
import { RheaPlanner, RheaSwapQuoter, StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import { DryRunExecutor, PlannerRegistry, TransactionExecutor } from '@near-autopilot/tx-execution';
import type { AutopilotConfig } from './autopilot-config';
import type { AutopilotRepository } from './repository';
import { loadSigner } from './signer';
import { AutopilotCycle } from './services/cycle';
import { CachedSnapshotService, SnapshotService } from './services/snapshot';

export const systemClock: Clock = { now: () => new Date() };
export const uuidGenerator: IdGenerator = { next: () => randomUUID() };

/** Composition root: the only place concrete adapters are bound to ports. */
export function wire(
  env: ApiEnv,
  config: AutopilotConfig,
  repo: AutopilotRepository,
  logger: Logger,
) {
  // Defence in depth: loadApiEnv already rejects this; a hand-built ApiEnv must not bypass it.
  if (env.EXECUTION_MODE === 'live' && env.NEAR_NETWORK === 'mainnet') {
    throw new Error(
      'Refusing to wire live execution on mainnet: this system never signs with mainnet keys',
    );
  }
  const rpc = new NearRpcClient({ url: env.NEAR_RPC_URL });
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
        tokenA: p.tokenA as TokenId,
        tokenB: p.tokenB as TokenId,
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
    });
  } else {
    executor = new DryRunExecutor({ clock: systemClock, logger });
  }

  const agents: Agent[] = [new HealthGuardianAgent(config.guardian)];
  if (config.rebalancer?.enabled) agents.push(new RebalancerAgent(config.rebalancer));

  const trackedTokens = config.policy.allowedTokens as TokenId[];
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

  const cycle = new AutopilotCycle({
    accountId: env.AUTOPILOT_ACCOUNT_ID,
    executionMode: env.EXECUTION_MODE,
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

  return { cycle, snapshots: cachedSnapshots, policy };
}
