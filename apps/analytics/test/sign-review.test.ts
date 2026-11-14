import { describe, expect, it } from 'vitest';
import {
  balanceChanges,
  impactTier,
  plainError,
  signBlocked,
  signLock,
  swapImpactTier,
  swapLossUsd,
} from '../lib/sign-review';
import type { PreparedCascade } from '../lib/prepare-types';

const cascade = (over: Partial<PreparedCascade>): PreparedCascade => ({
  account: 'alice.near',
  intent: {},
  transactions: [],
  preview: [],
  signed: false,
  note: '',
  ...over,
});

const swap = cascade({
  amount: { raw: '1', human: 34543.06, symbol: 'wNEAR', usd: 115307 },
  cost: {
    networkFeeMaxNear: 0.019,
    swap: {
      slippageBps: 50,
      priceImpactPct: 11.3,
      estReceived: { raw: '1', human: 102276, symbol: 'USDC', usd: 102276 },
      minReceived: { raw: '1', human: 101764.47, symbol: 'USDC', usd: 101764.47 },
    },
  },
});

describe('impactTier', () => {
  it.each([
    [null, 'none'],
    [0.4, 'none'],
    [1, 'watch'],
    [5, 'watch'],
    [5.01, 'act'],
    [15, 'act'],
    [15.01, 'block'],
  ] as const)('%s%% → %s', (pct, tier) => expect(impactTier(pct)).toBe(tier));
});

describe('signLock', () => {
  it('is open for an owner on a calm move', () => {
    expect(signLock({ blocked: null, tier: 'none', ack: false })).toEqual({ ready: true });
  });

  it('says why a read-only view cannot sign, before anything else', () => {
    expect(signLock({ blocked: 'Only the owner can sign.', tier: 'act', ack: false })).toEqual({
      ready: false,
      reason: 'Only the owner can sign.',
    });
  });

  it('waits for the acknowledgement above 5% and opens once it is ticked', () => {
    expect(signLock({ blocked: null, tier: 'act', ack: false })).toEqual({
      ready: false,
      gate: true,
      reason: 'Tick “I understand” above to unlock signing.',
    });
    expect(signLock({ blocked: null, tier: 'act', ack: true })).toEqual({ ready: true });
  });

  it('never opens above 15%', () => {
    expect(signLock({ blocked: null, tier: 'block', ack: true })).toMatchObject({ ready: false });
  });
});

describe('balanceChanges', () => {
  it('shows what leaves and the expected and minimum swap output', () => {
    expect(balanceChanges(swap)).toEqual([
      { dir: 'out', human: 34543.06, symbol: 'wNEAR', usd: 115307, where: 'from your wallet' },
      {
        dir: 'in',
        human: 102276,
        symbol: 'USDC',
        usd: 102276,
        min: 101764.47,
        where: 'to your wallet',
      },
    ]);
  });

  it('lists every sized side and what a move frees', () => {
    const c = cascade({
      amounts: [
        { raw: '1', human: 2, symbol: 'USDC' },
        { raw: '1', human: 3, symbol: 'USDt' },
      ],
      freed: [{ raw: '1', human: 1.5, symbol: 'NEAR' }],
    });
    expect(balanceChanges(c)).toEqual([
      { dir: 'out', human: 2, symbol: 'USDC', where: 'from your wallet' },
      { dir: 'out', human: 3, symbol: 'USDt', where: 'from your wallet' },
      { dir: 'in', human: 1.5, symbol: 'NEAR', where: 'to your wallet' },
    ]);
  });

  it('shows a supply landing in the Burrow deposit, so it never reads as money lost', () => {
    const c = cascade({
      intent: { action: 'supply' },
      amount: { raw: '1', human: 7.55, symbol: 'USDC', usd: 7.55 },
    });
    expect(balanceChanges(c)).toEqual([
      { dir: 'out', human: 7.55, symbol: 'USDC', usd: 7.55, where: 'from your wallet' },
      {
        dir: 'in',
        human: 7.55,
        symbol: 'USDC',
        usd: 7.55,
        where: 'to your Burrow deposit, still yours',
      },
    ]);
  });

  it('shows a Burrow withdrawal landing in the wallet', () => {
    const c = cascade({
      intent: { action: 'withdraw' },
      amount: { raw: '1', human: 5, symbol: 'USDC' },
    });
    expect(balanceChanges(c)).toEqual([
      { dir: 'out', human: 5, symbol: 'USDC', where: 'from your Burrow deposit' },
      { dir: 'in', human: 5, symbol: 'USDC', where: 'to your wallet' },
    ]);
  });

  it('shows a repayment as the loan going down', () => {
    const c = cascade({
      intent: { action: 'repay_from_collateral' },
      amount: { raw: '1', human: 600, symbol: 'USDt' },
    });
    expect(balanceChanges(c)).toEqual([
      { dir: 'out', human: 600, symbol: 'USDt', where: 'from your Burrow collateral' },
      { dir: 'debt', human: 600, symbol: 'USDt', where: 'off your Burrow loan' },
    ]);
  });
});

describe('swapLossUsd', () => {
  it('is what leaves minus what is expected back, in USD', () => {
    expect(swapLossUsd(swap)).toBeCloseTo(13031, 6);
  });

  it('is unknown when a side has no price', () => {
    expect(swapLossUsd(cascade({ ...swap, amount: { raw: '1', human: 1, symbol: 'X' } }))).toBe(
      null,
    );
  });
});

describe('plainError', () => {
  it('names a missing price without the token id', () => {
    expect(plainError('no confirmed price for 17208628f84f5d6ad33f0da3bbbeb27f', 409)).toBe(
      'There is no confirmed price for this token right now, so the amount cannot be sized safely. Try again after the next market update.',
    );
  });

  it('explains a network failure and a server failure', () => {
    expect(plainError('Failed to fetch', 0)).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(plainError('could not prepare the transaction right now', 502)).toBe(
      'Could not build this right now. Try again in a minute.',
    );
  });

  it('keeps a readable server sentence, capitalised and ended', () => {
    expect(plainError('your wallet holds no USDC', 409)).toBe('Your wallet holds no USDC.');
    expect(plainError('This quote was already built once. Get a new quote.', 409)).toBe(
      'This quote was already built once. Get a new quote.',
    );
  });
});

describe('signBlocked', () => {
  it('is null for the connected owner with signing on', () => {
    expect(
      signBlocked({ account: 'alice.near', connected: 'alice.near', signingEnabled: true }),
    ).toBeNull();
  });

  it('names the owner on someone else’s account', () => {
    expect(signBlocked({ account: 'near', connected: 'alice.near', signingEnabled: true })).toBe(
      'Only the owner of near can sign. This preview is exactly what they would see.',
    );
    expect(signBlocked({ account: 'near', connected: '', signingEnabled: true })).toBe(
      'Only the owner of near can sign. This preview is exactly what they would see.',
    );
  });

  it('says signing is off on this server', () => {
    expect(
      signBlocked({ account: 'alice.near', connected: 'alice.near', signingEnabled: false }),
    ).toBe('Signing is off on this server. This preview is exactly what your wallet would show.');
  });
});

describe('swapImpactTier', () => {
  it('is none for a move that is not a swap', () => {
    expect(swapImpactTier(cascade({}))).toBe('none');
  });

  it('asks for the acknowledgement when the impact could not be measured', () => {
    const unmeasured = cascade({
      cost: { networkFeeMaxNear: 0, swap: { ...swap.cost!.swap!, priceImpactPct: null } },
    });
    expect(swapImpactTier(unmeasured)).toBe('unknown');
    expect(signLock({ blocked: null, tier: 'unknown', ack: false })).toMatchObject({
      ready: false,
      gate: true,
    });
  });
});

describe('plainError on a bare HTTP failure', () => {
  it('never shows the status code', () => {
    expect(plainError('prepare failed (HTTP 404)', 404)).toBe(
      'Could not build this right now. Try again in a minute.',
    );
    expect(plainError('prepare failed (HTTP 429)', 429)).toBe(
      'Too many requests. Wait a few minutes and try again.',
    );
  });
});
