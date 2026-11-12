import { describe, expect, it } from 'vitest';
import { makeWorld, scriptedAgent, wire, WNEAR, USDT, near, usdt } from '../support/world';
import { LiquidationGuardianAgent } from '../../src';

const at = (debtUsdt: number, collateralNear = 100) => ({ collateralNear, debtUsdt });

describe('scenario: risk escalation', () => {
  it('healthy -> no escalation at all', async () => {
    const w = makeWorld({ lending: at(100) });
    await w.orchestrator.runCycle(w.nextKey());
    expect(w.events).toHaveLength(0);
  });

  it('watch (HF ~1.37) -> repay sized to the target health factor, an info event, dry-run executed', async () => {
    const w = makeWorld({ lending: at(230) });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('watch');
    expect(r.status).toBe('dry_run');
    const c = r.decision?.ranked[0];
    expect(c?.action.kind).toBe('lending.repay');
    expect(c?.tier).toBe(1);
    expect(c?.riskEffect && c.riskEffect.hfAfterWad! > c.riskEffect.hfBeforeWad!).toBe(true);
    // Exactly enough to reach the target: not the whole debt.
    expect(c?.action.kind === 'lending.repay' && c.action.amount < usdt(230)).toBe(true);
    expect(w.events.map((e) => `${e.severity}:${e.code}`)).toEqual(['info:RISK_WATCH']);
  });

  it('danger -> mode tightens to risk_reduction_only for the cycle, discretionary swaps are rejected, repay still goes', async () => {
    const w = makeWorld({ lending: at(290), yields: { near: 2, usdt: 60 } });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('danger');
    expect(r.decision?.mode.effective).toBe('risk_reduction_only');
    expect(r.decision?.ranked.every((c) => c.tier === 0)).toBe(true);
    expect(r.decision?.rejected.some((x) => x.kind === 'allocation.swap')).toBe(true);
    expect(r.status).toBe('dry_run');
    expect(w.codes()).toContain('RISK_DANGER');
    // The persisted mode is untouched: risk tightens the effective mode, an operator decides about the stored one.
    expect((await w.orchestrator.controlState()).mode).toBe('normal');
  });

  it('critical -> page', async () => {
    const w = makeWorld({ lending: at(310) });
    await w.orchestrator.runCycle(w.nextKey());
    expect(w.events.find((e) => e.code === 'RISK_CRITICAL')?.severity).toBe('page');
  });

  it('liquidatable -> page, and the repay is still ranked first', async () => {
    const w = makeWorld({ lending: at(330) });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('liquidatable');
    expect(w.events.find((e) => e.code === 'POSITION_LIQUIDATABLE')?.severity).toBe('page');
    expect(r.decision?.ranked[0]?.action.kind).toBe('lending.repay');
  });

  it('a de-risk the POLICY engine blocks is escalated: warn at watch, page once the position is in danger', async () => {
    // Policy allows at most $20 per action, so the repay (about $33 at watch, more in danger) is refused.
    const watch = makeWorld({
      lending: at(230),
      policy: { maxActionUsd: 20, approvalThresholdUsd: 20 },
    });
    const r = await watch.orchestrator.runCycle(watch.nextKey());
    expect(r.status).toBe('no_action');
    expect(watch.spies.approve).toBe(0);
    expect(watch.spies.execute).toBe(0);
    expect(r.policy.length).toBeGreaterThanOrEqual(1);
    expect(r.policy.every((p) => p.outcome !== 'approve')).toBe(true);
    expect(watch.events.find((e) => e.code === 'DERISK_BLOCKED_BY_POLICY')?.severity).toBe('warn');

    const danger = makeWorld({
      lending: at(290),
      policy: { maxActionUsd: 20, approvalThresholdUsd: 20 },
    });
    await danger.orchestrator.runCycle(danger.nextKey());
    expect(danger.spies.execute).toBe(0);
    expect(danger.events.find((e) => e.code === 'DERISK_BLOCKED_BY_POLICY')?.severity).toBe('page');
  });

  it('policy requires human approval -> recorded as pending, nothing executed, a page-level event', async () => {
    const w = makeWorld({ lending: at(230), policy: { approvalThresholdUsd: 10 } });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('pending_approval');
    expect(w.spies.approve).toBe(0);
    expect(w.spies.execute).toBe(0);
    expect(w.codes()).toContain('APPROVAL_REQUIRED');
  });

  it('a pending approval is not re-submitted by the next cycle (duplicate suppression covers pending_approval)', async () => {
    const w = makeWorld({ lending: at(230), policy: { approvalThresholdUsd: 10 } });
    await w.orchestrator.runCycle(w.nextKey());
    const second = await w.orchestrator.runCycle(w.nextKey());
    expect(second.decision?.rejected.some((x) => x.code === 'DUPLICATE_ACTION')).toBe(true);
    expect(w.spies.execute).toBe(0);
  });

  it('danger with an empty wallet -> nothing can be done automatically, so a human is paged', async () => {
    const w = makeWorld({ lending: at(290), wallet: { near: 0, usdt: 0 } });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('no_action');
    expect(w.spies.execute).toBe(0);
    const ev = w.events.find((e) => e.code === 'DERISK_UNAVAILABLE');
    expect(ev?.severity).toBe('page');
  });

  it('the guardian proposing nothing at watch level is not trusted either: the engine still reports the risk', async () => {
    const w = makeWorld({
      lending: at(230),
      agents: [
        scriptedAgent(
          'liquidation-guardian',
          wire('liquidation-guardian', [
            { kind: 'no_action', reasonCode: 'healthy', rationale: 'all good' },
          ]),
        ),
      ],
    });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.decision?.risk.level).toBe('watch'); // computed by the engine, not by the agent
    expect(w.codes()).toContain('RISK_WATCH');
    expect(r.status).toBe('no_action');
  });

  it('after a live de-risk, the next cycle on the same stale snapshot takes NO further risk-reducing action (neither the same nor an alternative)', async () => {
    const w = makeWorld({ lending: at(230), executor: 'live' });
    const a = await w.orchestrator.runCycle(w.nextKey());
    expect(a.status).toBe('executed');
    // The fake position has not changed, so the guardian proposes the same repay and the alternative top-up again.
    const b = await w.orchestrator.runCycle(w.nextKey());
    expect(b.status).toBe('no_action');
    const codes = b.decision?.rejected.map((x) => x.code) ?? [];
    // Both the repeated repay and the alternative top-up wait: the snapshot predates the first action.
    expect(codes).toEqual(['AWAITING_FRESH_STATE', 'AWAITING_FRESH_STATE']);
    expect(w.spies.broadcasts).toBe(1);
  });

  it('once a snapshot taken AFTER the executed action is available, the guard lifts', async () => {
    const w = makeWorld({ lending: at(230), executor: 'live' });
    await w.orchestrator.runCycle(w.nextKey());
    w.clock.advanceSeconds(30);
    const b = await w.orchestrator.runCycle(w.nextKey());
    const codes = b.decision?.rejected.map((x) => x.code) ?? [];
    expect(codes).not.toContain('AWAITING_FRESH_STATE');
    expect(codes).toContain('DUPLICATE_ACTION'); // the same repay is still recognised as already done
  });

  it('a failed live repay is escalated; repeated failures put the system into read-only', async () => {
    const w = makeWorld({ lending: at(230), executor: 'live', broadcast: 'failure' });
    const r = await w.orchestrator.runCycle(w.nextKey());
    expect(r.status).toBe('execution_failed');
    expect(w.events.find((e) => e.code === 'EXECUTION_FAILED')?.message).toBe('execution failed');
    // 'failed' actions are not deduplicated, so the guardian may try again, up to the failure limit.
    await w.orchestrator.runCycle(w.nextKey());
    await w.orchestrator.runCycle(w.nextKey());
    const state = await w.orchestrator.controlState();
    expect(state.mode).toBe('read_only');
    expect(w.codes()).toContain('EMERGENCY_READ_ONLY');
    const after = await w.orchestrator.runCycle(w.nextKey());
    expect(after.status).toBe('read_only');
    expect(w.spies.broadcasts).toBe(3);
    void LiquidationGuardianAgent;
    void WNEAR;
    void USDT;
    void near;
  });
});
