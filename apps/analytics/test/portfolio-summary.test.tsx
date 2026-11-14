import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PortfolioSummary, allocSegments } from '../components/PortfolioSummary';

const base = {
  netWorthUsd: 4990.5,
  assetsUsd: 5000.5,
  debtUsd: 10,
  source: { kind: 'on_chain', age: 'just now' },
  alloc: [{ key: 'wrap.near', symbol: 'NEAR', verified: true, pct: 1, icon: null }],
  monthly: { usd: 2.78, sentence: 'Lending earns more than the loan costs.' },
  health: {
    healthFactor: 1.3,
    urgentBelow: 1.15,
    safeFrom: 1.5,
    level: 'medium',
    label: 'Watch',
    sentence: 'Close to your limit.',
  },
  loanBy: 'your collateral',
} as const;

const html = (props: Partial<Parameters<typeof PortfolioSummary>[0]> = {}) =>
  renderToStaticMarkup(<PortfolioSummary {...base} {...props} />);

describe('PortfolioSummary', () => {
  it('shows the net worth with its cents apart, assets − borrowed and the data age', () => {
    const out = html();
    expect(out).toContain('$4,990<span class="sum-cents">.50</span>');
    expect(out).toContain('$5,001 in assets − $10.00 borrowed');
    expect(out).toContain('On-chain · just now');
  });

  it('leaves out "borrowed" when there is no debt or less than a cent', () => {
    expect(html({ debtUsd: 0 })).not.toContain('borrowed');
    expect(html({ debtUsd: 0.001 })).not.toContain('borrowed');
  });

  it('tags the loan as an estimate, never as read on-chain', () => {
    expect(html()).toMatch(/Loan safety <span class="ds-prov ds-prov-estimate"/);
  });

  it('colours the monthly result with its sign and a trend arrow', () => {
    const up = html();
    expect(up).toMatch(/sum-kpi[^"]*up/);
    expect(up).toContain('data-icon="trend-up"');
    expect(up).toContain('+$2.78');
    const down = html({ monthly: { usd: -1.5, sentence: '' } });
    expect(down).toMatch(/sum-kpi[^"]*down/);
    expect(down).toContain('data-icon="trend-down"');
    expect(down).toContain('−$1.50');
  });

  it('draws the loan as a large status chip, health factor and gauge', () => {
    const out = html();
    expect(out).toContain('ds-chip ds-chip-watch ds-chip-lg');
    expect(out).toContain('Health factor 1.30');
    expect(out).toContain('Liquidation if your collateral falls');
  });

  it('says "No loan" as the KPI when nothing is borrowed', () => {
    const out = html({
      health: {
        healthFactor: null,
        level: 'low',
        label: 'No loan',
        sentence: 'Nothing borrowed.',
      },
    });
    expect(out).toContain('No loan');
    expect(out).toContain('Nothing borrowed.');
    expect(out).not.toContain('ds-gauge');
  });

  it('hides the other-chains line without data and shows it with data', () => {
    expect(html()).not.toContain('on other chains');
    const out = html({ other: { usd: 253, tokens: [], action: <button>Bring to NEAR</button> } });
    expect(out).toContain('+ $253');
    expect(out).toContain('on other chains · not analysed');
    expect(out).toContain('Bring to NEAR');
  });
});

describe('allocSegments', () => {
  it('keeps the top four, groups the rest as Other and uses token colours', () => {
    const segs = allocSegments([
      { key: 'USDC', symbol: 'USDC', verified: true, pct: 0.5, icon: null },
      { key: 'NEAR', symbol: 'NEAR', verified: true, pct: 0.2, icon: null },
      { key: 'FOO', symbol: 'FOO', verified: true, pct: 0.1, icon: null },
      { key: 'BAR', symbol: 'BAR', verified: true, pct: 0.1, icon: null },
      { key: 'BAZ', symbol: 'BAZ', verified: true, pct: 0.06, icon: null },
      { key: 'QUX', symbol: 'QUX', verified: true, pct: 0.04, icon: null },
    ]);
    expect(segs.map((s) => s.symbol)).toEqual(['USDC', 'NEAR', 'FOO', 'BAR', 'Other']);
    expect(segs[0]!.color).toBe('#2775ca');
    expect(segs[1]!.color).toBe('#00e29a');
    expect(segs[2]!.color).toBe('var(--series-4)');
    expect(segs[4]!.pct).toBeCloseTo(0.1);
  });

  it('gives an unverified token that copies a real symbol a neutral colour', () => {
    const [seg] = allocSegments([
      { key: 'scam.near', symbol: 'USDC', verified: false, pct: 1, icon: null },
    ]);
    expect(seg!.color).toBe('var(--series-4)');
  });

  it('alternates neutral colours among unknown tokens only', () => {
    const segs = allocSegments(
      ['FOO', 'NEAR', 'BAR'].map((s) => ({
        key: s,
        symbol: s,
        verified: true,
        pct: 0.3,
        icon: null,
      })),
    );
    expect(segs.map((s) => s.color)).toEqual(['var(--series-4)', '#00e29a', 'var(--series-5)']);
  });
});
