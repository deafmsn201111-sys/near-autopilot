import type { ChainId, Recipient, Token } from '@hot-labs/kit';
import { describe, expect, it } from 'vitest';
import { bridgeSetup, isBridgeSource } from '../lib/hot-kit';

const ONE_CLICK: Record<number, string> = {
  1: 'eth',
  10: 'op',
  56: 'bsc',
  8453: 'base',
  42161: 'arb',
};
const oneClick = (id: ChainId) => (typeof id === 'number' ? ONE_CLICK[id] : undefined);
const token = (chain: ChainId) => ({ chain }) as Token;

describe('isBridgeSource', () => {
  it('allows only 1Click EVM chains, Solana, Tron and Bitcoin', () => {
    const allowed: ChainId[] = [1, 8453, 42161, 10, 56, 'sol', 'tron', 'btc'];
    expect(allowed.filter((c) => !isBridgeSource(c, oneClick))).toEqual([]);
  });

  it('never NEAR, a HOT balance, another chain or a non-1Click EVM number', () => {
    const never: ChainId[] = [
      'near',
      'hot',
      'hot_v1',
      'hotcraft',
      'hypercore',
      'ton',
      1313161554,
      0,
      -1,
    ];
    expect(never.filter((c) => isBridgeSource(c, oneClick))).toEqual([]);
  });
});

describe('bridgeSetup', () => {
  const recipient = { address: 'alice.near' } as Recipient;
  const setup = bridgeSetup(recipient, oneClick);

  it('locks the recipient to the NEAR account', () => {
    expect(setup.recipient).toBe(recipient);
    expect(setup.lockRecipient).toBe(true);
  });

  it('filters the source like isBridgeSource and the arrival to NEAR only', () => {
    const from = setup.tokenFilter?.from;
    const to = setup.tokenFilter?.to;
    expect(['near', 'hot', 8453, 'sol'].map((c) => from?.(token(c as ChainId)))).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(['near', 'hot', 8453].map((c) => to?.(token(c as ChainId)))).toEqual([
      true,
      false,
      false,
    ]);
  });
});
