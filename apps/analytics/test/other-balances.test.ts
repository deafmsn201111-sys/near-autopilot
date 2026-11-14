import type { ChainId } from '@hot-labs/kit';
import { describe, expect, it } from 'vitest';
import { otherBalances, type KitBalance } from '../lib/hot-kit';

const oneClick = (id: ChainId) => (id === 8453 ? 'base' : undefined);
const EVM = { type: 1, address: '0xabc' };
const NEAR = { type: 1010, address: 'alice.near' };

const entry = (
  wallet: { type: number; address: string },
  t: { id: string; symbol: string; chain: ChainId; usd: number; isOmni?: boolean },
  amount: number,
): KitBalance => ({
  wallet,
  balance: BigInt(amount * 1e6),
  token: {
    ...t,
    isOmni: t.isOmni ?? false,
    chainName: t.isOmni ? 'HOT' : 'Base',
    icon: `${t.symbol}.png`,
    float: (b: bigint) => Number(b) / 1e6,
  },
});

describe('otherBalances', () => {
  it('groups origin-chain tokens by wallet with USD, marks bridgeable ones, drops dust', () => {
    const out = otherBalances(
      [
        entry(EVM, { id: '8453:usdc', symbol: 'USDC', chain: 8453, usd: 1 }, 20),
        entry(EVM, { id: '1313161554:eth', symbol: 'ETH', chain: 1313161554, usd: 3000 }, 0.001),
        entry(EVM, { id: '8453:dust', symbol: 'DUST', chain: 8453, usd: 0.0001 }, 1),
      ],
      oneClick,
    );
    expect(out).toEqual([
      {
        key: 'evm:0xabc',
        chain: 'evm',
        address: '0xabc',
        usd: 23,
        items: [
          {
            key: '0xabc:8453:usdc',
            tokenId: '8453:usdc',
            symbol: 'USDC',
            chainName: 'Base',
            icon: 'USDC.png',
            amount: 20,
            usd: 20,
            bringable: true,
          },
          expect.objectContaining({ symbol: 'ETH', usd: 3, bringable: false }),
        ],
      },
    ]);
  });

  it("skips the NEAR wallet's own tokens and puts every HOT balance in one group, never bridgeable", () => {
    const out = otherBalances(
      [
        entry(NEAR, { id: 'near:usdc', symbol: 'USDC', chain: 'near', usd: 1 }, 50),
        entry(NEAR, { id: 'hot:usdc', symbol: 'USDC', chain: 'hot', usd: 1, isOmni: true }, 5),
        entry(EVM, { id: 'hot:usdc', symbol: 'USDC', chain: 'hot', usd: 1, isOmni: true }, 2),
      ],
      oneClick,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'hot', chain: 'hot', usd: 7 });
    expect(out[0]!.items.map((i) => [i.key, i.bringable])).toEqual([
      ['alice.near:hot:usdc', false],
      ['0xabc:hot:usdc', false],
    ]);
  });

  it('is empty without balances', () => {
    expect(otherBalances([], oneClick)).toEqual([]);
  });
});
