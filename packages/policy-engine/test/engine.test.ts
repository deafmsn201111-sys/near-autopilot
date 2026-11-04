import { describe, expect, it } from 'vitest';
import type { ActionIntent, LendingSupplyIntent, PlannedTransaction } from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';
import { policyConfigSchema } from '../src';
import {
  ALICE,
  BURROW,
  NOW,
  REF,
  USDT,
  WNEAR,
  baseConfigInput,
  input,
  makeConfig,
  makeEngine,
  makeSnapshot,
  planFor,
  repayIntent,
  swapIntent,
} from './fixtures';

const rulesHit = (decision: { violations: ReadonlyArray<{ rule: string }> }) =>
  decision.violations.map((v) => v.rule);

describe('PolicyEngine.evaluate', () => {
  it('approves a well-formed swap inside all limits', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluate(input());
    expect(decision.violations).toEqual([]);
    expect(decision.outcome).toBe('approve');
    expect(decision.valueUsdMicro).toBe(50_000_000n);
  });

  it('kill switch rejects everything', () => {
    const { engine } = makeEngine(makeConfig({ enabled: false }));
    expect(rulesHit(engine.evaluate(input()))).toContain('kill_switch');
  });

  it('rejects transfers to recipients that are not allowlisted', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const action = plan.actions[0];
    const evil: PlannedTransaction = {
      ...plan,
      actions: [{ ...action!, args: { ...action!.args, receiver_id: 'attacker.near' } }],
    };
    const decision = engine.evaluate(input(intent, { plan: evil }));
    expect(decision.outcome).toBe('reject');
    expect(rulesHit(decision)).toContain('recipient_allowlist');
  });

  it('rejects methods outside the allowlist and oversize deposits', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const bad: PlannedTransaction = {
      ...plan,
      actions: [{ ...plan.actions[0]!, methodName: 'ft_transfer', deposit: 10n ** 24n }],
    };
    const hit = rulesHit(engine.evaluate(input(intent, { plan: bad })));
    expect(hit).toContain('method_allowlist');
    expect(hit).toContain('deposit_cap');
  });

  it('rejects a plan whose amount differs from the intent', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const tampered: PlannedTransaction = {
      ...plan,
      actions: [
        {
          ...plan.actions[0]!,
          args: { ...plan.actions[0]!.args, amount: (intent.amountIn * 10n).toString() },
        },
      ],
    };
    const decision = engine.evaluate(input(intent, { plan: tampered }));
    expect(decision.outcome).toBe('reject');
    expect(rulesHit(decision)).toContain('intent_match');
  });

  it('rejects signers other than the configured account', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = { ...planFor(intent), signerId: BURROW };
    expect(rulesHit(engine.evaluate(input(intent, { plan })))).toContain('signer');
  });

  it('enforces the per-action cap and the approval threshold', () => {
    const { engine } = makeEngine();
    // 18 NEAR = $90: above the $75 approval threshold but within the $100 cap
    const mid = swapIntent({
      amountIn: 18n * 10n ** 24n,
      quotedAmountOut: 89_100_000n,
      minAmountOut: 88_654_500n,
    });
    expect(engine.evaluate(input(mid)).outcome).toBe('require_approval');
    // 30 NEAR = $150: above the cap
    const big = swapIntent({
      amountIn: 30n * 10n ** 24n,
      quotedAmountOut: 148_500_000n,
      minAmountOut: 147_757_500n,
    });
    const decision = engine.evaluate(input(big));
    expect(decision.outcome).toBe('reject');
    expect(rulesHit(decision)).toContain('max_action_value');
  });

  it('enforces the rolling 24h limit', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluate(
      input(swapIntent(), {
        history: { spentLast24hUsdMicro: 460_000_000n, lastExecutedAt: null },
      }),
    );
    expect(decision.outcome).toBe('reject');
    expect(rulesHit(decision)).toContain('daily_limit');
  });

  it('rejects excessive slippage and slippage floors that the agent mis-computed', () => {
    const { engine } = makeEngine();
    expect(rulesHit(engine.evaluate(input(swapIntent({ slippageBps: 300 }))))).toContain(
      'max_slippage',
    );
    // claims 50 bps but floor is 5% below quote
    expect(rulesHit(engine.evaluate(input(swapIntent({ minAmountOut: 47_025_000n }))))).toContain(
      'max_slippage',
    );
  });

  it('rejects quotes far worse than the oracle (manipulated pool)', () => {
    const { engine } = makeEngine();
    const poor = swapIntent({ quotedAmountOut: 45_000_000n, minAmountOut: 44_550_000n }); // 1000 bps worse
    const decision = engine.evaluate(input(poor));
    expect(decision.outcome).toBe('reject');
    expect(rulesHit(decision)).toContain('oracle_deviation');
  });

  it('rejects stale prices and stale snapshots', () => {
    const { engine } = makeEngine();
    const old = new Date(NOW.getTime() - 10 * 60_000);
    const hit = rulesHit(
      engine.evaluate(
        input(swapIntent(), { snapshot: makeSnapshot({ pricesAsOf: old, takenAt: old }) }),
      ),
    );
    expect(hit).toContain('price_freshness');
    expect(hit).toContain('snapshot_freshness');
  });

  it('fails closed when an oracle price is missing', () => {
    const { engine } = makeEngine();
    const snapshot = makeSnapshot({ prices: new Map() });
    const decision = engine.evaluate(input(swapIntent(), { snapshot }));
    expect(decision.outcome).toBe('reject');
    expect(decision.valueUsdMicro).toBeNull();
    expect(rulesHit(decision)).toContain('price_missing');
  });

  it('rejects when native balance cannot cover gas', () => {
    const { engine } = makeEngine();
    expect(
      rulesHit(
        engine.evaluate(input(swapIntent(), { snapshot: makeSnapshot({ nativeBalance: 1n }) })),
      ),
    ).toContain('native_reserve');
  });

  it('applies the cooldown to swaps but never to repayments', () => {
    const { engine } = makeEngine();
    const recent = { spentLast24hUsdMicro: 0n, lastExecutedAt: new Date(NOW.getTime() - 30_000) };
    expect(rulesHit(engine.evaluate(input(swapIntent(), { history: recent })))).toContain(
      'cooldown',
    );
    const repay = engine.evaluate(input(repayIntent(), { history: recent }));
    expect(repay.outcome).toBe('approve');
  });

  it('approves de-risking repayments', () => {
    const { engine } = makeEngine();
    const decision = engine.evaluate(input(repayIntent()));
    expect(decision.violations).toEqual([]);
    expect(decision.valueUsdMicro).toBe(20_000_000n);
  });

  it('rejects tokens that are not allowlisted', () => {
    const { engine } = makeEngine(makeConfig({ allowedTokens: [WNEAR] }));
    expect(rulesHit(engine.evaluate(input(swapIntent())))).toContain('token_allowlist');
  });
});

describe('Burrow message must match the intent exactly', () => {
  const withMsg = (plan: PlannedTransaction, msg: string): PlannedTransaction => ({
    ...plan,
    actions: plan.actions.map((a) => ({ ...a, args: { ...a.args, msg } })),
  });
  const execute = (...actions: unknown[]) => JSON.stringify({ Execute: { actions } });
  const supply = (asCollateral: boolean): LendingSupplyIntent => ({
    id: 'intent-3',
    agentId: 'guardian',
    reason: 'test',
    kind: 'lending.supply',
    protocol: 'burrow',
    token: USDT,
    amount: 20_000_000n,
    asCollateral,
  });
  const intentMatch = (plan: PlannedTransaction, intent: ActionIntent = repayIntent()) => {
    const { engine } = makeEngine();
    return engine
      .evaluate(input(intent, { plan }))
      .violations.filter((v) => v.rule === 'intent_match')
      .map((v) => v.message);
  };

  it('accepts the shapes the Burrow builders emit', () => {
    expect(intentMatch(planFor(repayIntent()))).toEqual([]);
    expect(intentMatch(planFor(supply(true)), supply(true))).toEqual([]);
    expect(intentMatch(planFor(supply(false)), supply(false))).toEqual([]);
  });

  it('rejects a repay that smuggles a second action (e.g. Withdraw)', () => {
    const repay = { Repay: { token_id: USDT, max_amount: '1' } };
    const withdraw = { Withdraw: { token_id: WNEAR, max_amount: '1' } };
    const plan = withMsg(planFor(repayIntent()), execute(repay, withdraw));
    expect(intentMatch(plan)).toEqual(['Lending message must contain exactly one Repay action']);
    const { engine } = makeEngine();
    expect(engine.evaluate(input(repayIntent(), { plan })).outcome).toBe('reject');
  });

  it('rejects the wrong action, token, amount form or extra fields', () => {
    const plan = planFor(repayIntent());
    const cases: Array<[string, string]> = [
      [execute({ Withdraw: { token_id: USDT, max_amount: '1' } }), 'is not Repay'],
      [execute({ Repay: { token_id: WNEAR, max_amount: '1' } }), 'differs from intent'],
      [execute({ Repay: { token_id: USDT, max_amount: '0' } }), 'positive integer'],
      [execute({ Repay: { token_id: USDT, max_amount: '1', to: 'x' } }), 'unexpected fields'],
      [JSON.stringify({ Execute: { actions: [] }, Extra: 1 }), 'exactly one Repay'],
      ['', 'not valid JSON'],
    ];
    for (const [msg, expected] of cases) {
      expect(intentMatch(withMsg(plan, msg)).join(' ')).toContain(expected);
    }
  });

  it('a plain supply must not carry any Execute message', () => {
    const plan = withMsg(
      planFor(supply(false)),
      execute({ IncreaseCollateral: { token_id: USDT, max_amount: '1' } }),
    );
    expect(intentMatch(plan, supply(false))).toEqual(['Plain supply must use an empty message']);
  });
});

describe('PolicyEngine.approve', () => {
  it('mints an approval bound to the plan hash with a TTL', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const approved = engine.approve(plan, engine.evaluate(input(intent)));
    expect(approved.planHash).toBe(planHash(plan));
    expect(approved.expiresAt.getTime() - approved.approvedAt.getTime()).toBe(120_000);
  });

  it('refuses to approve rejected or mismatched decisions', () => {
    const { engine } = makeEngine(makeConfig({ enabled: false }));
    const intent = swapIntent();
    const plan = planFor(intent);
    expect(() => engine.approve(plan, engine.evaluate(input(intent)))).toThrow('outcome');

    const { engine: ok } = makeEngine();
    const decision = ok.evaluate(input(intent));
    expect(() => ok.approve({ ...plan, intentId: 'other' }, decision)).toThrow('different intent');
  });

  it('refuses decisions it did not produce, even if they claim approve', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const real = engine.evaluate(input(intent));
    expect(() => engine.approve(plan, { ...real })).toThrow('not produced by this policy engine');
    const { engine: other } = makeEngine();
    expect(() => other.approve(plan, real)).toThrow('not produced by this policy engine');
  });

  it('refuses to approve a different plan than the one evaluated', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const decision = engine.evaluate(input(intent));
    const swapped: PlannedTransaction = { ...plan, receiverId: BURROW };
    expect(() => engine.approve(swapped, decision)).toThrow('differs from the plan');
  });

  it('uses each decision at most once and recognises only its own approvals', () => {
    const { engine } = makeEngine();
    const intent = swapIntent();
    const plan = planFor(intent);
    const decision = engine.evaluate(input(intent));
    const approved = engine.approve(plan, decision);
    expect(engine.isAuthentic(approved)).toBe(true);
    expect(engine.isAuthentic({ ...approved })).toBe(false);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(() => engine.approve(plan, decision)).toThrow('already used');
    expect(makeEngine().engine.isAuthentic(approved)).toBe(false);
  });
});

describe('policyConfigSchema', () => {
  it('rejects inconsistent limits and unknown keys', () => {
    expect(() =>
      policyConfigSchema.parse({ ...baseConfigInput, approvalThresholdUsd: 200 }),
    ).toThrow();
    expect(() => policyConfigSchema.parse({ ...baseConfigInput, maxActionUsd: 1000 })).toThrow();
    expect(() => policyConfigSchema.parse({ ...baseConfigInput, surprise: true })).toThrow();
    expect(() =>
      policyConfigSchema.parse({ ...baseConfigInput, signerAccountId: 'Not Valid' }),
    ).toThrow();
  });

  it('applies safe defaults', () => {
    const c = makeConfig();
    expect(c.allowedMethods).toEqual(['ft_transfer_call']);
    expect(c.maxDepositYocto).toBe(1n);
    expect(c.enabled).toBe(true);
    expect(ALICE).toBe(c.signerAccountId);
    expect(REF).toBeTruthy();
    expect(USDT).toBeTruthy();
  });
});
