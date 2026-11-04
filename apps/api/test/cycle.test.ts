import { describe, expect, it } from 'vitest';
import {
  accountId,
  type ActionIntent,
  type Agent,
  type ApprovedPlan,
  type AssetRisk,
  type ExecutionResult,
  type PlanExecutor,
  type PlannedTransaction,
  type PortfolioSnapshot,
  type ProtocolPlanner,
  type SwapQuoter,
  type TokenId,
} from '@near-autopilot/core';
import { FixedClock, SequentialIds, SilentLogger } from '@near-autopilot/core/testing';
import { HealthGuardianAgent, guardianConfigSchema } from '@near-autopilot/agents';
import { PolicyEngine, policyConfigSchema } from '@near-autopilot/policy-engine';
import { PlannerRegistry } from '@near-autopilot/tx-execution';
import { AutopilotCycle, CycleInProgressError } from '../src/services/cycle';
import { CachedSnapshotService } from '../src/services/snapshot';
import { InMemoryRepository } from './in-memory-repository';

const ALICE = accountId('alice.near');
const BURROW = accountId('contract.main.burrow.near');
const WNEAR = accountId('wrap.near');
const USDT = accountId('usdt.tether-token.near');
const NOW = new Date('2026-11-03T12:00:00Z');
const near = (n: number) => BigInt(n) * 10n ** 24n;
const usdt = (n: number) => BigInt(n) * 10n ** 6n;

const risk: ReadonlyMap<TokenId, AssetRisk> = new Map([
  [
    WNEAR,
    {
      token: WNEAR,
      collateralFactorBps: 7000,
      borrowFactorBps: 7000,
      canBeCollateral: true,
      canBorrow: true,
    },
  ],
  [
    USDT,
    {
      token: USDT,
      collateralFactorBps: 9000,
      borrowFactorBps: 9000,
      canBeCollateral: true,
      canBorrow: true,
    },
  ],
]);

// HF = (100 NEAR * $5 * 0.7) / ($200 / 0.9) = 1.575 -> below guardian trigger 1.8
const unhealthy: PortfolioSnapshot = {
  accountId: ALICE,
  takenAt: NOW,
  pricesAsOf: NOW,
  nativeBalance: near(1),
  walletBalances: [{ token: USDT, raw: usdt(500) }],
  lending: {
    protocol: 'burrow',
    accountId: ALICE,
    supplied: [],
    collateral: [{ token: WNEAR, raw: near(100) }],
    borrowed: [{ token: USDT, raw: usdt(200) }],
  },
  prices: new Map([
    [WNEAR, { multiplier: 50_000n, decimals: 28 }],
    [USDT, { multiplier: 10_000n, decimals: 10 }],
  ]),
  risk,
  tokens: new Map(),
};

const policyInput = {
  signerAccountId: ALICE,
  allowedContracts: [WNEAR, USDT, BURROW],
  allowedRecipients: [BURROW],
  allowedTokens: [WNEAR, USDT],
  maxActionUsd: 500,
  dailyLimitUsd: 2000,
  approvalThresholdUsd: 400,
  maxSlippageBps: 100,
  maxOracleDeviationBps: 200,
};

/** Planner for the intents the guardian emits; produces the same shape BurrowPlanner does. */
const burrowPlanner: ProtocolPlanner = {
  protocol: 'burrow',
  supports: (i) => i.kind === 'lending.repay' || i.kind === 'lending.supply',
  plan: async (intent: ActionIntent, signerId): Promise<PlannedTransaction> => {
    if (intent.kind === 'swap') throw new Error('unsupported');
    return {
      intentId: intent.id,
      signerId,
      receiverId: intent.token,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: { receiver_id: BURROW, amount: intent.amount.toString(), msg: '' },
          gas: 1n,
          deposit: 1n,
        },
      ],
    };
  },
};

const noQuotes: SwapQuoter = { quote: async () => null };

class RecordingExecutor implements PlanExecutor {
  readonly executed: ApprovedPlan[] = [];
  constructor(
    private readonly repo: InMemoryRepository,
    private readonly result: ExecutionResult,
  ) {}
  async execute(approved: ApprovedPlan): Promise<ExecutionResult> {
    // The 'approved' row must already be durable when execution starts.
    expect(this.repo.log).toContain('insert:approved');
    this.executed.push(approved);
    return this.result;
  }
}

function build(
  options: {
    result?: ExecutionResult;
    policyOverrides?: Record<string, unknown>;
    agents?: Agent[];
    mode?: 'dry-run' | 'live';
    snapshot?: PortfolioSnapshot;
  } = {},
) {
  const repo = new InMemoryRepository();
  const clock = new FixedClock(NOW);
  const ids = new SequentialIds('id');
  const executor = new RecordingExecutor(
    repo,
    options.result ?? { status: 'dry_run', mode: 'dry-run', txHash: null, error: null },
  );
  const guardian = new HealthGuardianAgent(
    guardianConfigSchema.parse({ triggerHealthFactor: 1.8, targetHealthFactor: 2.0 }),
  );
  const cycle = new AutopilotCycle({
    accountId: ALICE,
    executionMode: options.mode ?? 'dry-run',
    agents: options.agents ?? [guardian],
    quoter: noQuotes,
    snapshots: { take: async () => options.snapshot ?? unhealthy },
    planners: new PlannerRegistry().register(burrowPlanner),
    policy: new PolicyEngine(
      policyConfigSchema.parse({ ...policyInput, ...options.policyOverrides }),
      { clock, ids },
    ),
    executor,
    repo,
    clock,
    ids,
    logger: new SilentLogger(),
  });
  return { cycle, repo, executor };
}

describe('AutopilotCycle', () => {
  it('turns an unhealthy position into an approved, executed (dry-run) repayment', async () => {
    const { cycle, repo, executor } = build();
    const { run, proposals } = await cycle.run();
    expect(run.status).toBe('completed');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: 'lending.repay',
      status: 'dry_run',
      executionMode: 'dry-run',
      txHash: null,
    });
    expect(proposals[0]?.planHash).toBeTruthy();
    expect(executor.executed).toHaveLength(1);
    expect(repo.log).toEqual(['insert:approved', 'update:dry_run']);
    expect(repo.audit.map((a) => a.type)).toEqual(['proposal_approved', 'execution_dry_run']);
    expect(repo.snapshots.get(run.id)).toBeTruthy();
  });

  it('records live success with the transaction hash', async () => {
    const { cycle } = build({
      mode: 'live',
      result: { status: 'success', mode: 'live', txHash: 'TX1', error: null },
    });
    const { proposals } = await cycle.run();
    expect(proposals[0]).toMatchObject({
      status: 'executed',
      txHash: 'TX1',
      executionMode: 'live',
    });
  });

  it('records execution failures without failing the run', async () => {
    const { cycle } = build({
      mode: 'live',
      result: { status: 'failed', mode: 'live', txHash: 'TX2', error: 'receipt failed' },
    });
    const { run, proposals } = await cycle.run();
    expect(run.status).toBe('completed');
    expect(proposals[0]).toMatchObject({ status: 'failed', error: 'receipt failed' });
  });

  it('never executes when policy rejects, and keeps the reasons', async () => {
    const { cycle, executor } = build({ policyOverrides: { enabled: false } });
    const { proposals } = await cycle.run();
    expect(proposals[0]?.status).toBe('rejected');
    expect(proposals[0]?.violations.map((v) => v.rule)).toContain('kill_switch');
    expect(executor.executed).toHaveLength(0);
  });

  it('holds actions above the approval threshold for a human', async () => {
    const { cycle, executor } = build({ policyOverrides: { approvalThresholdUsd: 10 } });
    const { proposals } = await cycle.run();
    expect(proposals[0]?.status).toBe('requires_approval');
    expect(executor.executed).toHaveLength(0);
  });

  it('marks proposals whose planning fails, without executing', async () => {
    const { cycle, executor } = build({
      agents: [
        {
          id: 'bad',
          evaluate: async () => [
            {
              id: 'x',
              agentId: 'bad',
              reason: 'r',
              kind: 'swap',
              protocol: 'rhea',
              tokenIn: WNEAR,
              tokenOut: USDT,
              amountIn: 1n,
              poolId: 1,
              quotedAmountOut: 1n,
              minAmountOut: 1n,
              slippageBps: 0,
            },
          ],
        },
      ],
    });
    const { proposals } = await cycle.run();
    expect(proposals[0]).toMatchObject({ status: 'planning_failed' });
    expect(proposals[0]?.error).toContain('No planner supports');
    expect(executor.executed).toHaveLength(0);
  });

  it('survives an agent that throws and still completes the run', async () => {
    const { cycle, repo } = build({
      agents: [
        {
          id: 'boom',
          evaluate: async () => {
            throw new Error('agent bug');
          },
        },
      ],
    });
    const { run, proposals } = await cycle.run();
    expect(run.status).toBe('completed');
    expect(proposals).toEqual([]);
    expect(repo.audit.map((a) => a.type)).toContain('agent_error');
  });

  it('records a failed run when the snapshot cannot be taken', async () => {
    const { cycle } = build();
    const failing = new AutopilotCycle({
      ...(cycle as unknown as { deps: ConstructorParameters<typeof AutopilotCycle>[0] }).deps,
      snapshots: {
        take: async () => {
          throw new Error('rpc down');
        },
      },
    });
    const { run } = await failing.run();
    expect(run).toMatchObject({ status: 'failed', error: 'rpc down' });
  });

  it('refuses overlapping cycles', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { cycle } = build({
      agents: [
        {
          id: 'slow',
          evaluate: async () => {
            await gate;
            return [];
          },
        },
      ],
    });
    const first = cycle.run();
    await expect(cycle.run()).rejects.toThrow(CycleInProgressError);
    release();
    await first;
    expect((await cycle.run()).run.status).toBe('completed');
  });
});

describe('CachedSnapshotService', () => {
  it('serves cached snapshots within the TTL and refreshes after', async () => {
    let calls = 0;
    let now = 0;
    const svc = new CachedSnapshotService(
      {
        take: async () => {
          calls += 1;
          return unhealthy;
        },
      },
      1000,
      () => now,
    );
    await svc.take();
    now = 500;
    await svc.take();
    expect(calls).toBe(1);
    now = 1500;
    await svc.take();
    expect(calls).toBe(2);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const svc = new CachedSnapshotService(
      {
        take: async () => {
          calls += 1;
          throw new Error('boom');
        },
      },
      1000,
      () => 0,
    );
    await expect(svc.take()).rejects.toThrow('boom');
    await new Promise((r) => setTimeout(r, 0));
    await expect(svc.take()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
