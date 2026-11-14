import { describe, expect, it } from 'vitest';
import { headline, shortHash, stepLines, type TimelineItem } from '../lib/activity';

const cascade = (signed: { lines: string[] }[]): Extract<TimelineItem, { type: 'cascade' }> => ({
  type: 'cascade',
  at: '2026-11-14T10:00:00Z',
  cascadeId: 'c1',
  action: 'repay',
  preview: ['Repay 120 USDC', 'Withdraw 0.5 NEAR'],
  status: 'confirmed',
  steps: 2,
  signed: signed.map((s, i) => ({ at: '2026-11-14T10:01:00Z', hash: `h${i}`, ...s })),
});

describe('activity timeline wording', () => {
  it('names each kind of item in plain words', () => {
    expect(headline(cascade([]))).toBe('Repay a Burrow loan');
    expect(headline({ type: 'analyse', at: '', source: 'ai' })).toBe('Ran an AI analysis');
    expect(headline({ type: 'analyse', at: '', source: 'heuristic' })).toBe(
      'Ran a rule-based analysis',
    );
    expect(headline({ type: 'connect', at: '' })).toBe('Connected the wallet');
    expect(headline({ type: 'verified', at: '' })).toBe('Proved ownership');
    expect(
      headline({ type: 'oneclick_quote', at: '', detail: { from: 'USDC', to: 'wNEAR' } }),
    ).toBe('Got a 1Click deposit quote (USDC → wNEAR)');
  });

  it('shows the lines the server stored for each signed step', () => {
    const item = cascade([{ lines: ['Repaid 120 USDC on Burrow'] }, { lines: [] }]);
    expect(stepLines(item, 0)).toEqual(['Repaid 120 USDC on Burrow']);
    expect(stepLines(item, 1)).toEqual([]);
  });

  it('shortens a hash for the explorer link', () => {
    expect(shortHash('4qHuNteRioJ72yUvhdr9nC64qmCsqgjGzTWBWY5MdgGR')).toBe('4qHuNt…dgGR');
  });
});
