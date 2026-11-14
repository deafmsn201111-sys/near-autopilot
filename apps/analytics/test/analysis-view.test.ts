import { describe, expect, it } from 'vitest';
import type { TraceStep } from '../lib/analysis-client';
import { findingsOf, verdictOf } from '../lib/analysis-view';
import type { AccountRecommendation } from '../lib/product';

const rec = (
  kind: string,
  severity: 'info' | 'warning' = 'info',
  title = `${kind} card`,
): AccountRecommendation => ({
  id: `${kind}-${severity}`,
  kind,
  agent: 'x',
  severity,
  title,
  why: '',
  intent: null,
});

const step = (tool: string, agent: string, over: Partial<TraceStep> = {}): TraceStep => ({
  tool,
  agent,
  ok: true,
  text: `${agent} line`,
  provenance: null,
  pick: null,
  rank: null,
  ...over,
});

describe('verdictOf', () => {
  it('turns orange when a card is urgent, naming the loan', () => {
    expect(
      verdictOf({
        recommendations: [rec('improve_loan_safety', 'warning'), rec('put_idle_to_work')],
        skipped: [],
      }),
    ).toEqual({
      tone: 'act',
      count: 2,
      title: 'Your loan needs attention now.',
      sub: 'One urgent action and 1 more worth doing, explained below.',
    });
  });

  it('names a concentration when that is the urgent card', () => {
    expect(
      verdictOf({ recommendations: [rec('reduce_concentration', 'warning')], skipped: [] }).title,
    ).toBe('Too much of your money is in one token.');
  });

  it('counts open moves in violet and mentions what was skipped', () => {
    expect(
      verdictOf({
        recommendations: [rec('put_idle_to_work'), rec('reduce_concentration')],
        skipped: ['a', 'b'],
      }),
    ).toEqual({
      tone: 'ai',
      count: 2,
      title: '2 moves worth doing.',
      sub: '2 more checked and skipped: they don’t beat the costs.',
    });
  });

  it('says one move in the singular', () => {
    expect(verdictOf({ recommendations: [rec('put_idle_to_work')], skipped: [] }).title).toBe(
      '1 move worth doing.',
    );
  });

  it('does not reassure when a check could not finish', () => {
    expect(
      verdictOf({ recommendations: [], skipped: [], incomplete: ['Liquidation Guardian'] }),
    ).toEqual({
      tone: 'watch',
      count: 0,
      title: 'No move found, but a check is missing.',
      sub: 'Liquidation Guardian could not finish. Run the analysis again before relying on it.',
    });
  });

  it('a move does not hide a missing check', () => {
    expect(
      verdictOf({
        recommendations: [rec('put_idle_to_work')],
        skipped: [],
        incomplete: ['Liquidation Guardian'],
      }).sub,
    ).toBe('Ranked by what they change for you. Liquidation Guardian could not finish.');
  });

  it('nothing to do still says what was skipped', () => {
    expect(verdictOf({ recommendations: [], skipped: ['a'] })).toMatchObject({
      tone: 'safe',
      sub: '1 small move checked and skipped: it doesn’t beat the costs.',
    });
  });

  it('is mint when there is nothing to do', () => {
    expect(verdictOf({ recommendations: [], skipped: [] })).toMatchObject({
      tone: 'safe',
      count: 0,
      title: 'Nothing to do right now.',
    });
  });
});

describe('findingsOf', () => {
  const base = {
    recommendations: [],
    rules: [],
    trace: [],
    hasLoan: true,
    loanValued: true,
    hasLp: true,
  };

  it('always lists the four agents in a fixed order', () => {
    expect(findingsOf(base).map((f) => f.agent)).toEqual([
      'Liquidation Guardian',
      'Portfolio Intelligence',
      'Capital Allocator',
      'Liquidity Optimizer',
    ]);
  });

  it('rules only: an urgent loan is act, idle money is watch, the rest passed', () => {
    const [guardian, intel, alloc, lp] = findingsOf({
      ...base,
      recommendations: [
        rec('improve_loan_safety', 'warning', 'Repay 10 USDC'),
        rec('put_idle_to_work'),
      ],
    });
    expect(guardian).toMatchObject({
      level: 'act',
      result: 'Loan: act now',
      detail: 'Repay 10 USDC',
    });
    expect(intel).toMatchObject({ level: 'ok', result: 'Spread is fine' });
    expect(alloc).toMatchObject({ level: 'watch', result: 'Money sitting idle' });
    expect(lp).toMatchObject({ level: 'ok' });
  });

  it('with no loan or no liquidity position those checks are not applicable', () => {
    const [guardian, , , lp] = findingsOf({ ...base, hasLoan: false, hasLp: false });
    expect(guardian).toMatchObject({ level: 'na', result: 'No loan' });
    expect(lp).toMatchObject({ level: 'na', result: 'Nothing to check' });
  });

  it('a loan that could not be valued is not called safe', () => {
    expect(findingsOf({ ...base, loanValued: false })[0]).toMatchObject({
      level: 'watch',
      result: 'Loan: not valued',
      incomplete: true,
    });
  });

  it('one failed tool of an agent fails its whole check', () => {
    const [guardian] = findingsOf({
      ...base,
      trace: [
        step('burrow_withdrawals', 'Liquidation Guardian', { pick: 'ranked', rank: 1 }),
        step('liquidation_guardian', 'Liquidation Guardian', { ok: false, text: 'Failed' }),
      ],
    });
    expect(guardian).toMatchObject({ level: 'failed', incomplete: true });
  });

  it('a withdrawal card is the guardian finding but does not make the loan look risky', () => {
    expect(
      findingsOf({
        ...base,
        recommendations: [rec('withdraw_from_burrow', 'info', 'Withdraw 3 USDT')],
      })[0],
    ).toMatchObject({ level: 'ok', result: 'Loan: safe', detail: 'Withdraw 3 USDT' });
  });

  it('after an AI run: the agent line, the AI pick, and a left-out finding keeps its level', () => {
    const [guardian, intel, alloc, lp] = findingsOf({
      ...base,
      recommendations: [rec('improve_loan_safety', 'warning')],
      rules: [rec('improve_loan_safety', 'warning'), rec('put_idle_to_work')],
      trace: [
        step('burrow_withdrawals', 'Liquidation Guardian'),
        step('liquidation_guardian', 'Liquidation Guardian', { pick: 'ranked', rank: 1 }),
        step('portfolio_concentration', 'Portfolio Intelligence', { pick: 'kept', rank: 2 }),
        step('capital_allocator', 'Capital Allocator', { pick: 'left_out' }),
        step('lp_optimizer', 'Liquidity Optimizer', { ok: false, text: 'Failed' }),
      ],
    });
    expect(guardian).toMatchObject({
      detail: 'Liquidation Guardian line',
      pick: { label: '#1 · ranked by AI', tone: 'ai' },
    });
    expect(intel!.pick).toEqual({ label: '#2 · moved up by code', tone: 'watch' });
    expect(alloc).toMatchObject({
      level: 'watch',
      pick: { label: 'Left out by the AI', tone: null },
    });
    expect(lp).toMatchObject({ level: 'failed', result: 'Didn’t answer' });
  });

  it('while the AI runs, an agent whose answer has not arrived is busy', () => {
    const f = findingsOf({
      ...base,
      live: true,
      trace: [step('liquidation_guardian', 'Liquidation Guardian')],
    });
    expect(f.map((x) => x.busy)).toEqual([false, true, true, true]);
  });
});
