import { describe, expect, it } from 'vitest';
import type { DepositStatus } from '../lib/deposit';
import { addressError, parseAmount, shareOf, timelineOf, withdrawSources } from '../lib/withdraw';

describe('shareOf', () => {
  it('gives a share of the balance, rounded down', () => {
    expect(shareOf(5.123457, 100, 6)).toBe('5.123457');
    expect(shareOf(5.123457, 50, 6)).toBe('2.561728');
    expect(shareOf(10, 25, 6)).toBe('2.5');
    expect(shareOf(0.000003, 25, 6)).toBe('0');
  });

  it('never asks more than a float balance holds, and keeps the token decimals', () => {
    expect(shareOf(0.3, 100, 24)).toBe('0.3');
    expect(shareOf(1.000001, 100, 2)).toBe('1');
    expect(shareOf(7, 50, 0)).toBe('3');
  });
});

const USDC = { assetId: 'nep141:usdc.near', symbol: 'USDC', decimals: 6 };
const WNEAR = { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 };

describe('withdrawSources', () => {
  it('offers held tokens only, with their balance', () => {
    expect(withdrawSources([USDC, WNEAR], [{ token: 'usdc.near', amount: 3 }])).toEqual([
      { ...USDC, balance: 3 },
    ]);
  });

  it('joins native NEAR to wNEAR as NEAR, keeping 1 NEAR for fees', () => {
    const balances = [
      { token: 'near', amount: 5.3 },
      { token: 'wrap.near', amount: 0.1 },
    ];
    expect(withdrawSources([WNEAR], balances)).toEqual([
      { ...WNEAR, symbol: 'NEAR', balance: 4.4 },
    ]);
  });

  it('does not offer NEAR when only the fee reserve is held', () => {
    expect(withdrawSources([WNEAR], [{ token: 'near', amount: 0.9 }])).toEqual([]);
  });
});

describe('parseAmount', () => {
  it('is quiet while empty', () => {
    expect(parseAmount('  ', 6, 10)).toBeNull();
  });

  it('turns the typed amount into integer base units', () => {
    expect(parseAmount('1.5', 6, 10)).toEqual({ amount: '1.5', units: 1_500_000n });
    expect(parseAmount('2,25', 6, 10)).toEqual({ amount: '2.25', units: 2_250_000n });
    expect(parseAmount('0.1', 24, 1)).toEqual({ amount: '0.1', units: 10n ** 23n });
  });

  it('rejects letters, zero, too many decimals and more than the balance', () => {
    expect(parseAmount('abc', 6, 10)).toEqual({ error: 'Type a number, like 12.5.' });
    expect(parseAmount('1e3', 6, 10)).toEqual({ error: 'Type a number, like 12.5.' });
    expect(parseAmount('0.000', 6, 10)).toEqual({ error: 'Type an amount above 0.' });
    expect(parseAmount('1.1234567', 6, 10)).toEqual({
      error: 'This token has at most 6 decimals.',
    });
    expect(parseAmount('10.000001', 6, 10)).toEqual({
      error: 'More than your balance of 10.',
    });
  });

  it('accepts a missing whole or fraction part, sent in the API form', () => {
    expect(parseAmount('.5', 6, 10)).toEqual({ amount: '0.5', units: 500_000n });
    expect(parseAmount('1.', 6, 10)).toEqual({ amount: '1', units: 1_000_000n });
    expect(parseAmount('.', 6, 10)).toEqual({ error: 'Type a number, like 12.5.' });
  });

  it('accepts exactly the balance', () => {
    expect(parseAmount('5.123457', 6, 5.123457)).toEqual({ amount: '5.123457', units: 5_123_457n });
  });
});

describe('addressError', () => {
  it('checks the shape of an EVM address', () => {
    expect(addressError('base', '0x9c4e1b2a3f4d5e6a7b8c9d0e1f2a3b4c5d6ea341')).toBeNull();
    expect(addressError('eth', '0x9c4e')).toBe('An Ethereum address is 0x and 40 hex characters.');
    expect(addressError('arb', '')).toBeNull();
  });

  it('checks the shape of a Solana address', () => {
    expect(addressError('sol', '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBeNull();
    expect(addressError('sol', '0x9c4e1b2a3f4d5e6a7b8c9d0e1f2a3b4c5d6ea341')).toBe(
      'A Solana address is 32 to 44 letters and digits, without 0, O, I or l.',
    );
  });
});

const status = (s: DepositStatus['status'], deadlinePassed = false): DepositStatus => ({
  status: s,
  depositedAmount: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHash: null,
  deadlinePassed,
});

describe('timelineOf', () => {
  it('moves signed → seen by 1Click → swapping → arrived', () => {
    expect(timelineOf(null)).toEqual({ done: 1 });
    expect(timelineOf(status('PENDING_DEPOSIT'))).toEqual({ done: 1 });
    expect(timelineOf(status('KNOWN_DEPOSIT_TX'))).toEqual({ done: 2 });
    expect(timelineOf(status('PROCESSING'))).toEqual({ done: 2 });
    expect(timelineOf(status('SUCCESS'))).toEqual({ done: 4, end: 'ok' });
  });

  it('ends on refunded, failed, incomplete or an unpaid deadline', () => {
    expect(timelineOf(status('REFUNDED'))).toEqual({ done: 2, end: 'watch' });
    expect(timelineOf(status('FAILED'))).toEqual({ done: 2, end: 'liq' });
    expect(timelineOf(status('INCOMPLETE_DEPOSIT'))).toEqual({ done: 2, end: 'watch' });
    expect(timelineOf(status('PENDING_DEPOSIT', true))).toEqual({ done: 1, end: 'watch' });
  });
});
