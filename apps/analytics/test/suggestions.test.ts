import { describe, expect, it } from 'vitest';
import type { PortfolioAction } from '../lib/product';
import {
  accountFacts,
  demoFacts,
  leadAndDetail,
  splitDemo,
  stageAfterSign,
  topIndex,
  isHeld,
  withKept,
} from '../lib/suggestions';

const action = (over: Partial<PortfolioAction>): PortfolioAction => ({
  id: 'a',
  kind: 'lend',
  title: 'Lend your idle USDt on Burrow',
  summary: 'Deposit it.',
  capitalUsd: 600,
  horizonDays: 30,
  grossUsd: 4,
  netUsd: 3.77,
  netAprOnCapital: 0.076,
  costs: [{ label: 'Network fees', usd: 0.01 }],
  risk: 'low',
  steps: [],
  risks: [],
  basis: '',
  autopilot: { verdict: 'worth_it', sentence: 'Worth it after costs.' },
  ...over,
});

describe('splitDemo', () => {
  it('turns moves worth doing into cards and every other verdict into a skipped row with its net and reason', () => {
    const { cards, skipped } = splitDemo([
      action({ id: 'repay' }),
      action({
        id: 'swap',
        title: 'Swap idle NEAR to USDC and lend it',
        netUsd: 2.57,
        autopilot: { verdict: 'not_worth_it', sentence: 'The gain is less than 3× the costs.' },
      }),
      action({
        id: 'near',
        netUsd: -0.075,
        autopilot: { verdict: 'not_allowed', sentence: 'Would lose money after gas.' },
      }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['repay']);
    expect(skipped).toEqual([
      {
        title: 'Swap idle NEAR to USDC and lend it',
        number: '+$2.57 / 30 d',
        reason: 'The gain is less than 3× the costs.',
      },
      {
        title: 'Lend your idle USDt on Burrow',
        number: '−$0.08 / 30 d',
        reason: 'Would lose money after gas.',
      },
    ]);
  });

  it('keeps a skipped move without a number when the net is unknown', () => {
    const { skipped } = splitDemo([
      action({ netUsd: null, autopilot: { verdict: 'no_data', sentence: 'No data.' } }),
    ]);
    expect(skipped[0]?.number).toBeUndefined();
  });
});

describe('demoFacts', () => {
  it('shows the gain in mint, the yearly rate and the costs', () => {
    expect(demoFacts(action({}))).toEqual([
      { label: 'Earns', value: '+$3.77', sub: '/ 30 days', good: true },
      { label: 'Rate', value: '7.6%', sub: 'a year after costs' },
      { label: 'Cost', value: '≈ $0.01', sub: 'Network fees' },
    ]);
  });

  it('does not colour a loss as a gain and drops facts it has no number for', () => {
    expect(
      demoFacts(action({ netUsd: -1, netAprOnCapital: null, costs: [] })).map((f) => [
        f.label,
        f.good,
      ]),
    ).toEqual([['Earns', false]]);
  });

  it('calls a repayment a saving', () => {
    expect(demoFacts(action({ kind: 'keep' }))[0]?.label).toBe('Saves');
  });
});

describe('leadAndDetail', () => {
  it('leads with the first sentence and keeps the rest as detail', () => {
    expect(leadAndDetail('The loan costs 13.6% a year. Repaying saves it. Safe.')).toEqual({
      lead: 'The loan costs 13.6% a year.',
      detail: 'Repaying saves it. Safe.',
    });
  });

  it('does not split inside a number', () => {
    expect(leadAndDetail('Lend 3.5 USDC on Burrow')).toEqual({
      lead: 'Lend 3.5 USDC on Burrow',
      detail: '',
    });
  });
});

describe('topIndex', () => {
  it('is the first card that is not done', () => {
    expect(topIndex(['done', 'open', 'open'])).toBe(1);
    expect(topIndex(['done'])).toBe(-1);
  });
});

const signing = { kind: 'signing', step: 1, of: 1 } as const;
const done = { kind: 'done', confirmed: true } as const;
const failed = { kind: 'failed', reason: 'x' } as const;
const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe('withKept', () => {
  it('holds a card whose sheet is open at its place with its snapshot, even when the list moved it', () => {
    const kept = new Map([
      ['a', { item: { id: 'a', v: 1 }, index: 0, stage: signing, sheet: true }],
    ]);
    expect(
      withKept(
        [
          { id: 'x', v: 1 },
          { id: 'a', v: 2 },
        ],
        kept,
      ),
    ).toEqual([
      { id: 'a', v: 1 },
      { id: 'x', v: 1 },
    ]);
  });

  it('holds a failed card while its sheet is open, so a partial cascade keeps its sheet', () => {
    const kept = new Map([
      ['a', { item: { id: 'a', v: 1 }, index: 0, stage: failed, sheet: true }],
    ]);
    expect(ids(withKept([], kept))).toEqual(['a']);
  });

  it('keeps a receipt in place after the list dropped the card', () => {
    const kept = new Map([['b', { item: { id: 'b', v: 1 }, index: 1, stage: done, sheet: false }]]);
    expect(
      ids(
        withKept(
          [
            { id: 'a', v: 1 },
            { id: 'c', v: 1 },
          ],
          kept,
        ),
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('lets a fresh card with the same id replace a receipt once the agents change it', () => {
    const kept = new Map([['a', { item: { id: 'a', v: 1 }, index: 0, stage: done, sheet: false }]]);
    expect(withKept([{ id: 'a', v: 2 }], kept)).toEqual([{ id: 'a', v: 2 }]);
    expect(withKept([{ id: 'a', v: 1 }], kept)).toEqual([{ id: 'a', v: 1 }]);
    expect(
      isHeld({ item: { id: 'a', v: 1 }, stage: done, sheet: false }, [{ id: 'a', v: 2 }]),
    ).toBe(false);
  });

  it('lets a failed card follow the list once its sheet is closed', () => {
    const kept = new Map([
      ['a', { item: { id: 'a', v: 1 }, index: 0, stage: failed, sheet: false }],
      ['b', { item: { id: 'b', v: 1 }, index: 1, stage: failed, sheet: false }],
    ]);
    expect(withKept([{ id: 'a', v: 2 }], kept)).toEqual([{ id: 'a', v: 2 }]);
  });
});

describe('accountFacts', () => {
  it('shows the amount the card will move', () => {
    expect(
      accountFacts({ action: 'supply', token: 'usdt.tether-token.near', approxUsd: 599.4 }),
    ).toEqual([{ label: 'Amount', value: '≈ $599' }]);
  });

  it('leaves a sized repay to its picker, whose amount and health factor the user changes', () => {
    expect(
      accountFacts({
        action: 'repay',
        token: 'usdt.tether-token.near',
        approxUsd: 599.4,
        sizing: { hfNow: 1.37, targetHf: 1.5 } as never,
      }),
    ).toEqual([]);
  });

  it('has no facts for an advisory card or an intent without an amount', () => {
    expect(accountFacts(null)).toEqual([]);
    expect(accountFacts({ action: 'reposition_dcl', lptId: '1', poolId: 'p' })).toEqual([]);
  });
});

describe('stageAfterSign', () => {
  it('is a receipt with the last hash when every step went through', () => {
    expect(
      stageAfterSign({ ok: true, hashes: ['a', 'b'] }, { confirmed: true, through: 2 }),
    ).toEqual({
      kind: 'done',
      hash: 'b',
      confirmed: true,
    });
  });

  it('says a sent step was not confirmed when the server could not check it', () => {
    expect(
      stageAfterSign({ ok: true, hashes: ['a'] }, { confirmed: false, through: 1 }),
    ).toMatchObject({ confirmed: false });
  });

  it('says how many steps went through when the cascade stopped half-way', () => {
    expect(
      stageAfterSign(
        { ok: false, hashes: ['a'], reason: 'declined' },
        { confirmed: true, through: 1, steps: 3 },
      ),
    ).toEqual({
      kind: 'failed',
      reason: '1 of 3 steps went through. declined. Check NearBlocks before trying again.',
    });
  });

  it('does not count a sent step that failed on NEAR as gone through', () => {
    const stage = stageAfterSign(
      { ok: false, hashes: ['a'], reason: 'This step did not complete.' },
      { confirmed: false, through: 0, steps: 1 },
    );
    expect(stage.kind === 'failed' && stage.reason).toMatch(/^0 of 1 steps went through\./);
  });

  it('is failed with the wallet reason otherwise', () => {
    expect(
      stageAfterSign(
        { ok: false, hashes: [], reason: 'declined' },
        { confirmed: true, through: 0 },
      ),
    ).toEqual({
      kind: 'failed',
      reason: 'declined',
    });
    expect(stageAfterSign({ ok: false, hashes: [] }, { confirmed: true, through: 0 })).toEqual({
      kind: 'failed',
      reason: 'The transaction did not go through.',
    });
  });
});
