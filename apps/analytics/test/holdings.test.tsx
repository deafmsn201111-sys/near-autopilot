import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoldingsPanel, holdingGroups, type HoldingInput } from '../components/Holdings';

const h = (
  where: HoldingInput['where'],
  token: string,
  symbol: string,
  amount: number,
  usd: number | null,
  extra: Partial<HoldingInput> = {},
): HoldingInput => ({ where, token, symbol, amount, usd, ...extra });

const holdings: HoldingInput[] = [
  h('collateral', 'wrap.near', 'NEAR', 1150, 3825, { aprPct: 0 }),
  h('deposited', 'usdt', 'USDt', 50, 50, { aprPct: 8.5 }),
  h('borrowed', 'usdt', 'USDt', 2000, 1998, { aprPct: 13.6 }),
  h('wallet', 'near', 'NEAR', 0.86, 3),
  h('wallet', 'usdt', 'USDt', 600, 599),
  h('wallet', 'spam.near', 'SPAM', 10, 20, { verified: false }),
  h('wallet', 'dust', 'DUST', 0.1, 0.1, { small: true }),
];
const positions = [
  {
    key: 'dcl-1',
    kind: 'dcl' as const,
    label: 'USDC/wNEAR',
    sub: 'Rhea concentrated liquidity',
    amount: null,
    usd: 15,
    inRange: true,
  },
  {
    key: 'dcl-2',
    kind: 'dcl' as const,
    label: 'USDC/USDt',
    sub: 'Rhea concentrated liquidity',
    amount: null,
    usd: 9,
    inRange: false,
  },
  {
    key: 'staking-linear',
    kind: 'staking' as const,
    label: 'LiNEAR',
    sub: 'Liquid staking',
    amount: 2,
    usd: 5,
  },
];

const html = (props: Partial<Parameters<typeof HoldingsPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <HoldingsPanel
      holdings={holdings}
      positions={positions}
      provenance={{ kind: 'on_chain', age: 'just now' }}
      source="Non-custodial · balances read directly from the chain"
      {...props}
    />,
  );

describe('holdingGroups', () => {
  it('groups by where the money sits, in a fixed order, with assets minus loans as the total', () => {
    const { groups } = holdingGroups(holdings, positions);
    expect(groups.map((g) => [g.label, g.totalUsd])).toEqual([
      ['Burrow · lending', 3825 + 50 - 1998],
      ['Liquidity', 24],
      ['Staking', 5],
      ['Wallet', 602],
    ]);
  });

  it('keeps unverified tokens and balances under $1 out of the groups', () => {
    const { groups, unverified, small } = holdingGroups(holdings, positions);
    const symbols = groups.flatMap((g) => g.rows.map((r) => r.symbol));
    expect(symbols).not.toContain('SPAM');
    expect(symbols).not.toContain('DUST');
    expect(unverified.map((r) => [r.symbol, r.status])).toEqual([
      ['SPAM', { label: 'Shown only' }],
    ]);
    expect(small.map((r) => r.status)).toEqual([{ label: 'Too small' }]);
    expect(small.map((r) => r.symbol)).toEqual(['DUST']);
  });

  it('tints only Idle, Costs and out-of-range; earning, collateral and fees stay neutral', () => {
    const rows = holdingGroups(holdings, positions).groups.flatMap((g) => g.rows);
    const status = (sym: string, sub?: string) =>
      rows.find((r) => r.symbol === sym && (!sub || r.sub.startsWith(sub)))?.status;
    expect(status('NEAR', 'Collateral')).toEqual({ label: 'Collateral' });
    expect(status('USDt', 'Deposit')).toEqual({ label: 'Earning 8.5%', icon: 'up' });
    expect(status('USDt', 'Loan')).toEqual({ label: 'Costs 13.6%', tone: 'act', icon: 'down' });
    expect(status('NEAR', 'Native')).toEqual({ label: 'Kept for fees' });
    expect(status('USDt', 'Stablecoin')).toEqual({ label: 'Idle', tone: 'watch', icon: 'minus' });
    expect(status('USDC/wNEAR')).toEqual({ label: 'In range', icon: 'up' });
    expect(status('USDC/USDt')).toEqual({ label: 'Out of range', tone: 'watch', icon: 'alert' });
  });

  it('keeps a demo NEAR under the fee reserve as fees, without a token id', () => {
    const rows = holdingGroups([h('wallet', '', 'NEAR', 0.5, 2, { token: undefined })], [])
      .groups[0]!.rows;
    expect(rows[0]!.status).toEqual({ label: 'Kept for fees' });
  });

  it('shows "—" for a limit order and "LP share" only for liquidity', () => {
    const out = renderToStaticMarkup(
      <HoldingsPanel
        holdings={[]}
        positions={[
          {
            key: 'order-1',
            kind: 'order',
            label: 'USDC → NEAR',
            sub: 'Rhea limit order',
            amount: null,
            usd: 5,
          },
          ...positions,
        ]}
        provenance={{ kind: 'on_chain', age: 'just now' }}
        source="s"
      />,
    );
    expect(out).toMatch(/USDC → NEAR.*?hold-amt">—</);
    expect(out).toMatch(/USDC\/wNEAR.*?hold-amt">LP share</);
  });

  it('puts liquid staking held in the wallet under Staking, not Idle', () => {
    const { groups } = holdingGroups([h('wallet', 'meta-pool.near', 'STNEAR', 1, 5)], []);
    expect(groups.map((g) => g.label)).toEqual(['Staking']);
    expect(groups[0]!.rows[0]!.status).toEqual({ label: 'Staking', icon: 'up' });
  });

  it('shows no group total when a row in it has no price', () => {
    const { groups } = holdingGroups(
      [h('deposited', 'usdt', 'USDt', 50, 50), h('borrowed', 'x', 'X', 5, null)],
      [],
    );
    expect(groups[0]!.totalUsd).toBeNull();
  });

  it('calls NEAR above the 1 NEAR fee reserve idle', () => {
    const rows = holdingGroups([h('wallet', 'near', 'NEAR', 300, 998)], []).groups[0]!.rows;
    expect(rows[0]!.status).toEqual({ label: 'Idle', tone: 'watch', icon: 'minus' });
  });
});

describe('HoldingsPanel', () => {
  it('is a real table: column heads, group heads and row heads carry a scope', () => {
    const out = html();
    expect(out).toContain('<th scope="col">Asset</th>');
    expect(out).toContain('<th scope="rowgroup"');
    expect(out).toContain('<th scope="row"');
  });

  it('shows a loan with a real minus sign', () => {
    expect(html()).toContain('−$1,998');
  });

  it('counts unverified tokens and balances under $1 in the footer', () => {
    const out = html();
    expect(out).toContain('1 unverified token');
    expect(out).toContain('1 balance under $1');
  });

  it('has no other-chain group without data, and a dashed one with Bring to NEAR when given', () => {
    expect(html()).not.toContain('not analysed');
    const out = html({
      other: [
        {
          key: 'base',
          label: 'MetaMask · 0x12…ab',
          items: [{ key: 'usdc', symbol: 'USDC', sub: 'on Base', amount: 20, usd: 20, logos: [] }],
          action: <button type="button">Bring to NEAR</button>,
        },
      ],
    });
    expect(out).toContain('MetaMask · 0x12…ab · shown only, not analysed');
    expect(out).toContain('Bring to NEAR');
  });

  it('shows an empty wallet state instead of an empty table', () => {
    const out = html({ holdings: [], positions: [] });
    expect(out).not.toContain('<table');
    expect(out).toContain('This wallet holds nothing yet');
  });

  it('offers Add funds in the empty wallet state', () => {
    const out = html({ holdings: [], positions: [], emptyAction: <button>Add funds</button> });
    expect(out).toMatch(/holds nothing yet.*Add funds/s);
  });
});
