import { describe, expect, it } from 'vitest';
import {
  accountId,
  type AgentContext,
  type AssetRisk,
  type LendingPosition,
  type PortfolioSnapshot,
  type SwapQuote,
  type SwapQuoteRequest,
  type SwapQuoter,
  type TokenId,
} from '@near-autopilot/core';
import { FixedClock, SequentialIds } from '@near-autopilot/core/testing';
import { healthFactor, lendingTotals } from '@near-autopilot/financial-engine';
import {
  HealthGuardianAgent,
  RebalancerAgent,
  guardianConfigSchema,
  rebalancerConfigSchema,
} from '../src';

const ALICE = accountId('alice.near');
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
const prices = new Map([
  [WNEAR, { multiplier: 50_000n, decimals: 28 }],
  [USDT, { multiplier: 10_000n, decimals: 10 }],
]);

const lending = (collateralNear: number, borrowedUsdt: number): LendingPosition => ({
  protocol: 'burrow',
  accountId: ALICE,
  supplied: [],
  collateral: [{ token: WNEAR, raw: near(collateralNear) }],
  borrowed: [{ token: USDT, raw: usdt(borrowedUsdt) }],
});

const snapshot = (overrides: Partial<PortfolioSnapshot>): PortfolioSnapshot => ({
  accountId: ALICE,
  takenAt: NOW,
  pricesAsOf: NOW,
  nativeBalance: near(1),
  walletBalances: [],
  lending: null,
  prices,
  risk,
  tokens: new Map(),
  ...overrides,
});

/** Port implementation with a fixed answer (the quoting venue is out of scope for agent tests). */
class FixedQuoter implements SwapQuoter {
  readonly requests: SwapQuoteRequest[] = [];
  constructor(private readonly answer: (r: SwapQuoteRequest) => SwapQuote | null) {}
  async quote(request: SwapQuoteRequest): Promise<SwapQuote | null> {
    this.requests.push(request);
    return this.answer(request);
  }
}

const ctx = (
  snap: PortfolioSnapshot,
  quoter: SwapQuoter = new FixedQuoter(() => null),
): AgentContext => ({
  snapshot: snap,
  quoter,
  clock: new FixedClock(NOW),
  ids: new SequentialIds('i'),
});

const guardian = new HealthGuardianAgent(
  guardianConfigSchema.parse({ triggerHealthFactor: 1.8, targetHealthFactor: 2.0 }),
);

describe('HealthGuardianAgent', () => {
  it('does nothing without debt or when healthy', async () => {
    expect(await guardian.evaluate(ctx(snapshot({ lending: null })))).toEqual([]);
    expect(await guardian.evaluate(ctx(snapshot({ lending: lending(100, 50) })))).toEqual([]); // HF ~ 6.3
  });

  it('repays debt from the wallet to reach the target health factor', async () => {
    const snap = snapshot({
      lending: lending(100, 200),
      walletBalances: [{ token: USDT, raw: usdt(500) }],
    }); // HF 1.575
    const [intent] = await guardian.evaluate(ctx(snap));
    expect(intent?.kind).toBe('lending.repay');
    if (intent?.kind !== 'lending.repay') throw new Error('unreachable');
    const after = lending(100, 0);
    const repaid = { ...after, borrowed: [{ token: USDT, raw: usdt(200) - intent.amount }] };
    expect(healthFactor(lendingTotals(repaid, prices, risk)) ?? 0).toBeGreaterThanOrEqual(1.99);
  });

  it('caps the repayment at what the wallet holds', async () => {
    const snap = snapshot({
      lending: lending(100, 200),
      walletBalances: [{ token: USDT, raw: usdt(5) }],
    });
    const [intent] = await guardian.evaluate(ctx(snap));
    expect(intent).toMatchObject({ kind: 'lending.repay', amount: usdt(5) });
  });

  it('adds collateral when the wallet holds no debt token', async () => {
    const snap = snapshot({
      lending: lending(100, 200),
      walletBalances: [{ token: WNEAR, raw: near(500) }],
    });
    const [intent] = await guardian.evaluate(ctx(snap));
    expect(intent).toMatchObject({ kind: 'lending.supply', token: WNEAR, asCollateral: true });
  });

  it('proposes nothing when it has no means to help, or prices are missing', async () => {
    expect(await guardian.evaluate(ctx(snapshot({ lending: lending(100, 200) })))).toEqual([]);
    expect(
      await guardian.evaluate(ctx(snapshot({ lending: lending(100, 200), prices: new Map() }))),
    ).toEqual([]);
  });

  it('validates config', () => {
    expect(() =>
      guardianConfigSchema.parse({ triggerHealthFactor: 2, targetHealthFactor: 1.5 }),
    ).toThrow();
    expect(() =>
      guardianConfigSchema.parse({ triggerHealthFactor: 0.9, targetHealthFactor: 1.5 }),
    ).toThrow();
  });
});

describe('HealthGuardianAgent: exact threshold arithmetic', () => {
  // 100 NEAR @ $5 x 0.70 = $350 adjusted collateral; 225 USDt / 0.90 = $250 adjusted debt; HF = 1.4 exactly.
  const atOnePointFour = snapshot({
    lending: lending(100, 225),
    walletBalances: [{ token: USDT, raw: usdt(500) }],
  });
  const guardian = (trigger: number) =>
    new HealthGuardianAgent(
      guardianConfigSchema.parse({ triggerHealthFactor: trigger, targetHealthFactor: 1.6 }),
    );

  it('does not act when the health factor equals the trigger', async () => {
    expect(await guardian(1.4).evaluate(ctx(atOnePointFour))).toEqual([]);
  });

  it('acts one basis point above it', async () => {
    const intents = await guardian(1.4001).evaluate(ctx(atOnePointFour));
    expect(intents).toHaveLength(1);
    expect(intents[0]?.reason).toContain('health factor 1.4000 < trigger 1.4001');
  });

  it('rejects thresholds finer than a basis point instead of rounding them', () => {
    expect(() =>
      guardianConfigSchema.parse({ triggerHealthFactor: 1.00005, targetHealthFactor: 1.6 }),
    ).toThrow('4 decimal places');
  });
});

describe('RebalancerAgent', () => {
  const config = rebalancerConfigSchema.parse({
    enabled: true,
    targets: [
      { token: WNEAR, weightBps: 5000 },
      { token: USDT, weightBps: 5000 },
    ],
    driftThresholdBps: 500,
    maxTradeUsd: 50,
    slippageBps: 50,
  });
  const agent = new RebalancerAgent(config);
  const unbalanced = snapshot({
    walletBalances: [
      { token: WNEAR, raw: near(100) },
      { token: USDT, raw: usdt(100) },
    ],
  });

  it('proposes a capped swap with a slippage floor derived from the quote', async () => {
    const quoter = new FixedQuoter((r) => ({
      protocol: 'rhea',
      poolId: 3,
      amountIn: r.amountIn,
      amountOut: 49_000_000n,
    }));
    const [intent] = await agent.evaluate(ctx(unbalanced, quoter));
    expect(intent).toMatchObject({
      kind: 'swap',
      tokenIn: WNEAR,
      tokenOut: USDT,
      poolId: 3,
      amountIn: near(10), // $50 cap at $5/NEAR
      quotedAmountOut: 49_000_000n,
      minAmountOut: 48_755_000n,
      slippageBps: 50,
    });
  });

  it('proposes nothing without a quote, below threshold, or when disabled', async () => {
    expect(await agent.evaluate(ctx(unbalanced))).toEqual([]);
    const balanced = snapshot({
      walletBalances: [
        { token: WNEAR, raw: near(20) },
        { token: USDT, raw: usdt(100) },
      ],
    });
    const quoter = new FixedQuoter((r) => ({
      protocol: 'rhea',
      poolId: 1,
      amountIn: r.amountIn,
      amountOut: 1n,
    }));
    expect(await agent.evaluate(ctx(balanced, quoter))).toEqual([]);
    expect(
      await new RebalancerAgent({ ...config, enabled: false }).evaluate(ctx(unbalanced, quoter)),
    ).toEqual([]);
  });

  it('requires weights summing to 10000 bps', () => {
    expect(() =>
      rebalancerConfigSchema.parse({
        ...config,
        targets: [
          { token: WNEAR, weightBps: 6000 },
          { token: USDT, weightBps: 6000 },
        ],
      }),
    ).toThrow();
  });
});
