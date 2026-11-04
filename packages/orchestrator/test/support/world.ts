import {
  accountId,
  type ActionIntent,
  type ApprovedPlan,
  type AssetRisk,
  type BroadcastResult,
  type ChainContextProvider,
  type PlannedTransaction,
  type PlanExecutor,
  type PortfolioSnapshot,
  type ProtocolPlanner,
  type TokenId,
  type TransactionBroadcaster,
  type TransactionSigner,
  type UnitPrice,
} from '@near-autopilot/core';
import { FixedClock, SequentialIds, SilentLogger } from '@near-autopilot/core/testing';
import { rawForValueUsd, valueUsd } from '@near-autopilot/financial-engine';
import {
  PolicyEngine,
  policyConfigSchema,
  type PolicyConfigInput,
} from '@near-autopilot/policy-engine';
import { DryRunExecutor, PlannerRegistry, TransactionExecutor } from '@near-autopilot/tx-execution';
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
  type EscalationEvent,
  type ExecutionHistory,
  type MarketContext,
  type Notifier,
  type OrchestratorConfigInput,
  type PolicyGate,
  type ProposalAgent,
  type QuoteProvider,
  type SnapshotProvider,
} from '../../src';

export const ALICE = accountId('alice.near');
export const REF = accountId('v2.ref-finance.near');
export const BURROW = accountId('contract.main.burrow.near');
export const WNEAR = accountId('wrap.near') as TokenId;
export const USDT = accountId('usdt.tether-token.near') as TokenId;
export const NOW = new Date('2026-11-04T12:00:00Z');

export const near = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
export const usdt = (n: number): bigint => BigInt(Math.round(n * 1e6));

export const NEAR_PRICE: UnitPrice = { multiplier: 50_000n, decimals: 28 }; // $5
export const USDT_PRICE: UnitPrice = { multiplier: 10_000n, decimals: 10 }; // $1

export const RISK: ReadonlyMap<TokenId, AssetRisk> = new Map([
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

export interface WorldOptions {
  /** Burrow position. HF = (collateralNear * $5 * 0.7) / (debtUsdt * $1 / 0.9). null = no lending. */
  lending?: { collateralNear: number; debtUsdt: number } | null;
  wallet?: { near: number; usdt: number };
  /** Estimated annual yields, percent. */
  yields?: { near: number; usdt: number };
  policy?: Partial<PolicyConfigInput>;
  config?: OrchestratorConfigInput;
  agents?: ProposalAgent[];
  executor?: 'dry-run' | 'live';
  /** What the fake broadcaster answers in live mode. */
  broadcast?: 'success' | 'failure' | 'throw';
  /** The executor itself throws (as opposed to the broadcaster failing inside it). */
  executorThrows?: boolean;
  market?: MarketContext | null;
  prices?: Map<TokenId, UnitPrice>;
  quoteFeeBps?: number;
  /** Age of the snapshot and prices when taken, seconds. */
  snapshotAgeSeconds?: number;
  pricesAgeSeconds?: number;
}

export interface Spies {
  approve: number;
  evaluate: number;
  execute: number;
  broadcasts: number;
  plans: number;
  quotes: number;
}

export function makeWorld(opts: WorldOptions = {}) {
  const clock = new FixedClock(NOW);
  const logger = new SilentLogger();
  const spies: Spies = { approve: 0, evaluate: 0, execute: 0, broadcasts: 0, plans: 0, quotes: 0 };
  const prices =
    opts.prices ??
    new Map<TokenId, UnitPrice>([
      [WNEAR, NEAR_PRICE],
      [USDT, USDT_PRICE],
    ]);
  const state = {
    lending: opts.lending === undefined ? { collateralNear: 100, debtUsdt: 100 } : opts.lending,
    wallet: opts.wallet ?? { near: 100, usdt: 500 },
    snapshotAgeSeconds: opts.snapshotAgeSeconds ?? 0,
    pricesAgeSeconds: opts.pricesAgeSeconds ?? 0,
    snapshotFails: false,
    market: opts.market === undefined ? ('default' as const) : opts.market,
    yields: opts.yields ?? { near: 2, usdt: 2 },
    accountOverride: null as string | null,
  };

  const buildSnapshot = (): PortfolioSnapshot => ({
    accountId: (state.accountOverride ?? ALICE) as typeof ALICE,
    takenAt: new Date(clock.now().getTime() - state.snapshotAgeSeconds * 1000),
    pricesAsOf: new Date(clock.now().getTime() - state.pricesAgeSeconds * 1000),
    nativeBalance: 10n ** 24n,
    walletBalances: [
      { token: WNEAR, raw: near(state.wallet.near) },
      { token: USDT, raw: usdt(state.wallet.usdt) },
    ],
    lending: state.lending
      ? {
          protocol: 'burrow',
          accountId: ALICE,
          supplied: [],
          collateral: [{ token: WNEAR, raw: near(state.lending.collateralNear) }],
          borrowed: [{ token: USDT, raw: usdt(state.lending.debtUsdt) }],
        }
      : null,
    prices,
    risk: RISK,
    tokens: new Map(),
  });

  const buildMarket = (): MarketContext => ({
    asOf: clock.now(),
    estimatedYieldWad: new Map([
      [WNEAR, BigInt(state.yields.near) * 10n ** 16n],
      [USDT, BigInt(state.yields.usdt) * 10n ** 16n],
    ]),
    referencePrices: new Map(prices),
    volatility24hBps: new Map(),
    lpPositions: [],
  });

  const snapshots: SnapshotProvider = {
    async take() {
      if (state.snapshotFails) throw new Error('rpc down');
      return buildSnapshot();
    },
  };
  const marketProvider = {
    async get() {
      if (state.market === 'default') return buildMarket();
      return state.market;
    },
  };

  const quoter: QuoteProvider = {
    async quote({ tokenIn, tokenOut, amountIn }) {
      spies.quotes += 1;
      const pin = prices.get(tokenIn as TokenId);
      const pout = prices.get(tokenOut as TokenId);
      if (!pin || !pout) return null;
      const value = (valueUsd(amountIn, pin) * BigInt(10_000 - (opts.quoteFeeBps ?? 30))) / 10_000n;
      return { poolId: 7, amountIn, amountOut: (rawForValueUsd(value, pout) * 999n) / 1000n };
    },
  };

  // Planners mirror what the real adapters emit (same shapes the policy engine's intent-matching rule checks).
  const swapPlan = (i: Extract<ActionIntent, { kind: 'swap' }>): PlannedTransaction => ({
    intentId: i.id,
    signerId: ALICE,
    receiverId: i.tokenIn,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: {
          receiver_id: REF,
          amount: i.amountIn.toString(),
          msg: JSON.stringify({
            force: 0,
            actions: [
              {
                pool_id: i.poolId,
                token_in: i.tokenIn,
                token_out: i.tokenOut,
                amount_in: i.amountIn.toString(),
                min_amount_out: i.minAmountOut.toString(),
              },
            ],
          }),
        },
        gas: 180_000_000_000_000n,
        deposit: 1n,
      },
    ],
  });
  const lendPlan = (
    i: Extract<ActionIntent, { kind: 'lending.repay' | 'lending.supply' }>,
  ): PlannedTransaction => ({
    intentId: i.id,
    signerId: ALICE,
    receiverId: i.token,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: BURROW, amount: i.amount.toString(), msg: '' },
        gas: 300_000_000_000_000n,
        deposit: 1n,
      },
    ],
  });
  const tamper: { fn: ((p: PlannedTransaction) => PlannedTransaction) | null } = { fn: null };
  const planners = new PlannerRegistry()
    .register({
      protocol: 'rhea',
      supports: (i) => i.kind === 'swap',
      plan: async (i) => {
        spies.plans += 1;
        const p = swapPlan(i as Extract<ActionIntent, { kind: 'swap' }>);
        return tamper.fn ? tamper.fn(p) : p;
      },
    } satisfies ProtocolPlanner)
    .register({
      protocol: 'burrow',
      supports: (i) => i.kind === 'lending.repay' || i.kind === 'lending.supply',
      plan: async (i) => {
        spies.plans += 1;
        const p = lendPlan(
          i as Extract<ActionIntent, { kind: 'lending.repay' | 'lending.supply' }>,
        );
        return tamper.fn ? tamper.fn(p) : p;
      },
    } satisfies ProtocolPlanner);

  const policyConfig = policyConfigSchema.parse({
    signerAccountId: ALICE,
    allowedContracts: [WNEAR, USDT, REF, BURROW],
    allowedRecipients: [REF, BURROW],
    allowedTokens: [WNEAR, USDT],
    maxActionUsd: 200,
    dailyLimitUsd: 1000,
    approvalThresholdUsd: 150,
    maxSlippageBps: 100,
    maxOracleDeviationBps: 200,
    cooldownSeconds: 0,
    ...opts.policy,
  });
  const engine = new PolicyEngine(policyConfig, { clock, ids: new SequentialIds('policy') });
  const policy: PolicyGate = {
    evaluate: (input) => {
      spies.evaluate += 1;
      return engine.evaluate(input);
    },
    approve: (plan, decision): ApprovedPlan => {
      spies.approve += 1;
      return engine.approve(plan, decision);
    },
  };

  const broadcasts: { hash: string }[] = [];
  const signer: TransactionSigner = {
    accountId: ALICE,
    publicKey: 'ed25519:test-public-key',
    async sign(tx) {
      return { hash: `tx-${tx.intentId}`, payloadBase64: 'AA==' };
    },
  };
  const contextProvider: ChainContextProvider = {
    async getContext() {
      return { nonce: 1n, blockHash: 'bh' };
    },
  };
  const broadcaster: TransactionBroadcaster = {
    async broadcast(signed): Promise<BroadcastResult> {
      spies.broadcasts += 1;
      broadcasts.push({ hash: signed.hash });
      if (opts.broadcast === 'throw') throw new Error('connection reset after send');
      if (opts.broadcast === 'failure')
        return { txHash: signed.hash, status: 'failure', failureReason: 'receipt failed' };
      return { txHash: signed.hash, status: 'success', failureReason: null };
    },
  };
  const realExecutor: PlanExecutor =
    opts.executor === 'live'
      ? new TransactionExecutor({ signer, contextProvider, broadcaster, clock, logger })
      : new DryRunExecutor({ clock, logger });
  const executor: PlanExecutor = {
    async execute(approved) {
      spies.execute += 1;
      if (opts.executorThrows) throw new Error('executor crashed after being called');
      return realExecutor.execute(approved);
    },
  };

  const history = { value: { spentLast24hUsdMicro: 0n, lastExecutedAt: null as Date | null } };
  const executionHistory: ExecutionHistory = {
    async stats() {
      return history.value;
    },
  };

  const events: EscalationEvent[] = [];
  const notifier: Notifier & { fail: boolean } = {
    fail: false,
    async notify(e) {
      if (notifier.fail) throw new Error('pager down');
      events.push(e);
    },
  };

  const audit = new InMemoryAuditLog();
  const idempotency = new InMemoryIdempotencyStore();
  const control = new InMemoryControlStore(NOW);
  const config = orchestratorConfigSchema.parse({
    allocation: {
      assets: [{ token: WNEAR }, { token: USDT }],
      driftThresholdBps: 500,
      maxTurnoverBps: 2500,
    },
    ...opts.config,
  });
  const agents = opts.agents ?? [
    new MarketIntelligenceAgent(),
    new LpOptimizerAgent(),
    new LiquidationGuardianAgent(),
    new CapitalAllocatorAgent(),
  ];

  const orchestrator = new Orchestrator({
    accountId: ALICE,
    config,
    agents,
    snapshots,
    market: marketProvider,
    quoter,
    planner: planners,
    policy,
    executor,
    history: executionHistory,
    audit,
    idempotency,
    control,
    notifier,
    clock,
    logger,
  });

  let n = 0;
  return {
    orchestrator,
    clock,
    audit,
    idempotency,
    control,
    notifier,
    events,
    spies,
    state,
    history,
    tamper,
    broadcasts,
    config,
    policyConfig,
    engine,
    buildSnapshot,
    buildMarket,
    prices,
    nextKey: () => `cycle-${(n += 1)}`,
    async types(): Promise<string[]> {
      return (await audit.entries()).map((e) => e.type);
    },
    codes(): string[] {
      return events.map((e) => e.code);
    },
  };
}

export type World = ReturnType<typeof makeWorld>;

/** Agent that returns whatever it is told to, exactly as an LLM might. */
export function scriptedAgent(
  id: ProposalAgent['id'],
  output: unknown | (() => unknown | Promise<unknown>),
): ProposalAgent {
  return {
    id,
    async propose() {
      return typeof output === 'function' ? (output as () => unknown)() : output;
    },
  };
}

export const wire = (
  agent: ProposalAgent['id'],
  proposals: unknown[],
  asOf = NOW.toISOString(),
) => ({ schemaVersion: 1, agent, asOf, proposals });
