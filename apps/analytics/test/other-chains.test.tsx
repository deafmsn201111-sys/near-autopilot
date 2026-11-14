import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { otherGroups, otherSummary } from '../components/OtherChains';
import type { OtherBalance } from '../lib/hot-kit';

const item = (symbol: string, usd: number, bringable: boolean) => ({
  key: `k:${symbol}`,
  tokenId: `id:${symbol}`,
  symbol,
  chainName: 'Base',
  icon: null,
  amount: usd,
  usd,
  bringable,
});
const EVM: OtherBalance = {
  key: 'evm:0xabc0000000000000000000000000000000000001',
  chain: 'evm',
  address: '0xabc0000000000000000000000000000000000001',
  usd: 25,
  items: [item('USDC', 20, true), item('AURORA', 5, false)],
};
const HOT: OtherBalance = {
  key: 'hot',
  chain: 'hot',
  address: 'alice.near',
  usd: 3,
  items: [item('USDT', 3, false)],
};
const html = (n: React.ReactNode) => renderToStaticMarkup(<>{n}</>);

describe('other-chain slots', () => {
  it('stay empty when this is not the connected account or nothing is held', () => {
    expect(otherSummary(null, [EVM])).toBeNull();
    expect(otherSummary('alice.near', [])).toBeNull();
    expect(otherGroups(null, [EVM])).toEqual([]);
  });

  it('sum every wallet and the HOT balance in the hero line', () => {
    const s = otherSummary('alice.near', [EVM, HOT]);
    expect(s?.usd).toBe(28);
    expect(html(s?.action)).toContain('Bring to NEAR');
  });

  it('offer Bring to NEAR per bridgeable row and only point to HOT Wallet for the HOT balance', () => {
    const [evm, hot] = otherGroups('alice.near', [EVM, HOT]);
    expect(evm?.label).toBe('EVM wallet · 0xabc0…0001');
    expect(evm?.items.map((i) => html(i.action))).toEqual([
      expect.stringContaining('Bring to NEAR'),
      expect.stringContaining('Not bridgeable here'),
    ]);
    expect(hot?.label).toBe('HOT balance');
    expect(html(hot?.items[0]?.action)).toContain('Withdraw it in HOT Wallet');
    expect(html(hot?.items[0]?.action)).not.toContain('Bring to NEAR');
  });

  it('show each token once in the hero line, at most five icons', () => {
    const many: OtherBalance = {
      ...EVM,
      items: ['A', 'B', 'C', 'D', 'E', 'F', 'USDC'].map((x) => item(x, 1, true)),
    };
    const tokens = otherSummary('alice.near', [EVM, many])?.tokens.map((t) => t.symbol);
    expect(tokens).toEqual(['USDC', 'AURORA', 'A', 'B', 'C']);
  });

  it('give no hero action when only the HOT balance is held', () => {
    expect(html(otherSummary('alice.near', [HOT])?.action)).toBe('');
  });
});
