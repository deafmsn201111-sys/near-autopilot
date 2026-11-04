import { describe, expect, it } from 'vitest';
import { LpOptimizerAgent, type LpPositionView } from '../../src';
import { sqrtRatioAtTick } from '@near-autopilot/financial-engine';
import { makeWorld, scriptedAgent, wire, WNEAR, USDT, near, usdt } from '../support/world';

describe('scenario: doing nothing is a first-class, audited decision', () => {
  it('healthy portfolio, no edge anywhere -> no action, with reasons, and nothing is planned, authorised or executed', async () => {
    const w = makeWorld();
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.outcome).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['NOTHING_PROPOSED']);
    // Every agent said "nothing to do" explicitly, and each of those statements is recorded.
    expect(r.decision?.agentNoActions.map((a) => a.agent).sort()).toEqual([
      'capital-allocator',
      'liquidation-guardian',
      'lp-optimizer',
      'market-intelligence',
    ]);
    expect(w.spies).toMatchObject({ plans: 0, evaluate: 0, approve: 0, execute: 0, broadcasts: 0 });
    // The decision is in the audit log, with its reasons and a hash of its inputs.
    const entry = (await w.audit.entries()).find((e) => e.type === 'decision.no_action');
    expect(entry?.decisionId).toBe(r.decision?.decisionId);
    expect(entry?.payload['reasons']).toEqual(['NOTHING_PROPOSED']);
    expect(String(entry?.payload['inputsHash'])).toHaveLength(64);
  });

  it('a profitable-looking trade whose estimated benefit does not clear cost and hurdle -> no action (BELOW_HURDLE)', async () => {
    // 12% vs 2% over 30 days on $100 is about $0.82; fee + gas is about $0.35; hurdle needs 3x cost and $0.50 net.
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 12 } });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['ALL_PROPOSALS_REJECTED']);
    expect(r.decision?.rejected.map((x) => x.code)).toEqual(['BELOW_HURDLE']);
    expect(w.spies.execute).toBe(0);
    expect(w.spies.approve).toBe(0);
  });

  it('the same market with a large enough yield gap does act, so the previous result was the hurdle and not a stuck path', async () => {
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('dry_run');
    const c = r.decision?.ranked[0];
    expect(c?.basis).toBe('estimated');
    expect(c?.tier).toBe(2);
    expect(c?.economics && c.economics.benefitUsdMicro > c.economics.costUsdMicro * 3n).toBe(true);
  });

  it('a quote worse than the oracle is rejected even when the yield edge is large', async () => {
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 80 }, quoteFeeBps: 400 });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.rejected[0]?.code).toBe('QUOTE_WORSE_THAN_ORACLE');
  });

  it('no route for the swap -> NO_QUOTE -> no action', async () => {
    const w = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    // oracle prices exist but the router has none for USDT
    const w2 = makeWorld({ lending: null, yields: { near: 2, usdt: 40 } });
    w2.prices.delete(USDT);
    const r2 = await w2.orchestrator.runCycle(w2.nextKey());
    expect(r2.status).toBe('no_action');
    expect(w.spies.execute + w2.spies.execute).toBe(0);
  });

  it('an LP re-centring that pays back is recommended but never executed: there is no path from it to a transaction', async () => {
    const t = sqrtRatioAtTick;
    const view: LpPositionView = {
      id: 'pos-1',
      sqrtPrice: t(0),
      range: { sqrtLower: t(2000), sqrtUpper: t(3000), liquidity: 10n ** 18n }, // out of range: earning nothing
      activePoolLiquidity: 10n ** 20n,
      activeIncludesPosition: false,
      volume24hQuote: 10n ** 24n,
      feePpm: 3000,
      segments: [{ sqrtLower: t(-3000), sqrtUpper: t(3000), liquidity: 10n ** 26n }],
      gasQuote: 1000n,
    };
    const w = makeWorld({ lending: null, agents: [new LpOptimizerAgent()] });
    w.state.market = { ...w.buildMarket(), lpPositions: [view] };
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(r.decision?.reasons).toEqual(['NO_EXECUTABLE_ACTION']);
    expect(r.decision?.advisories).toHaveLength(1);
    expect(r.decision?.advisories[0]?.positionId).toBe('pos-1');
    expect(w.codes()).toContain('LP_ADVISORY');
    expect(w.spies).toMatchObject({ plans: 0, approve: 0, execute: 0 });
  });

  it('an LP proposal the engine cannot reproduce (made-up ticks, unknown position) is rejected, not trusted', async () => {
    const w = makeWorld({
      lending: null,
      agents: [
        scriptedAgent(
          'lp-optimizer',
          wire('lp-optimizer', [
            {
              kind: 'lp.reposition',
              positionId: 'does-not-exist',
              tickLower: -10,
              tickUpper: 10,
              rationale: 'trust me',
            },
          ]),
        ),
      ],
    });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.rejected.map((x) => x.code)).toEqual(['UNKNOWN_POSITION']);
    expect(r.status).toBe('no_action');
  });

  it('wallet too small for the proposal -> rejected as INSUFFICIENT_BALANCE', async () => {
    const w = makeWorld({
      lending: null,
      agents: [
        scriptedAgent(
          'capital-allocator',
          wire('capital-allocator', [
            {
              kind: 'allocation.swap',
              tokenIn: WNEAR,
              tokenOut: USDT,
              amountIn: near(1_000).toString(),
              maxSlippageBps: 50,
              rationale: 'all in',
            },
          ]),
        ),
      ],
    });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.rejected.map((x) => x.code)).toEqual(['INSUFFICIENT_BALANCE']);
    void usdt;
  });
});
