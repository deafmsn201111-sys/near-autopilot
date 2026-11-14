import { describe, expect, it } from 'vitest';
import {
  defaultDestination,
  describeStatus,
  formatUnits,
  STATUS_MAX_CHECKS,
  statusDelayMs,
  stopReason,
  type DepositQuote,
  type DepositStatus,
} from '../lib/deposit';

describe('formatUnits', () => {
  it('formats base units exactly', () => {
    expect(formatUnits('1500000', 6)).toBe('1.5');
    expect(formatUnits('100000000', 6)).toBe('100');
    expect(formatUnits('1', 6)).toBe('0.000001');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('1234567890123456789012345', 24)).toBe('1.234567890123456789012345');
    expect(formatUnits('5', 0)).toBe('5');
  });
});

describe('defaultDestination', () => {
  const wnear = { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 };
  const usdc = { assetId: 'nep141:usdc', symbol: 'USDC', decimals: 6 };
  const usdt = { assetId: 'nep141:usdt', symbol: 'USDT', decimals: 6 };
  const from = (symbol: string) => ({
    assetId: symbol,
    symbol,
    decimals: 6,
    chain: 'eth',
    chainName: 'Ethereum',
  });

  it('takes the same symbol, else USDC, else the first', () => {
    expect(defaultDestination(from('USDT'), [wnear, usdc, usdt])).toBe(usdt);
    expect(defaultDestination(from('ETH'), [wnear, usdc, usdt])).toBe(usdc);
    expect(defaultDestination(from('ETH'), [wnear])).toBe(wnear);
    expect(defaultDestination(undefined, [])).toBeUndefined();
  });
});

const quote: DepositQuote = {
  id: 'dq_1',
  chain: 'eth',
  chainName: 'Ethereum',
  origin: { assetId: 'nep141:eth-usdc', symbol: 'USDC', decimals: 6 },
  destination: { assetId: 'nep141:wrap.near', symbol: 'wNEAR', decimals: 24 },
  amountIn: '50000000',
  amountOut: '20000000000000000000000000',
  minAmountOut: '19800000000000000000000000',
  amountOutUsd: { value: '49.9', provenance: 'protocol_reported' },
  fee: { bps: 1, provenance: 'protocol_reported' },
  recipient: 'alice.near',
  refundTo: '0xrefund',
  depositAddress: '0xdeposit',
  deadline: '2026-11-14T10:00:00Z',
  expiresInSeconds: 86_400,
  timeEstimateSeconds: 120,
};
const NEAR_TX = '7Ytp5ZTdDuEe8VbWbkxhV5mBvRcP4tH8u6uJYHzdGMqd';
const st = (status: DepositStatus['status'], over: Partial<DepositStatus> = {}): DepositStatus => ({
  status,
  depositedAmount: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHash: null,
  deadlinePassed: false,
  ...over,
});

describe('describeStatus', () => {
  it('waits for the deposit, then says expired once the deadline passed', () => {
    expect(describeStatus(null, quote)).toMatchObject({
      tone: 'wait',
      title: 'Checking the deposit status…',
    });
    expect(describeStatus(st('PENDING_DEPOSIT'), quote)).toMatchObject({
      tone: 'wait',
      title: 'Waiting for your deposit',
    });
    expect(describeStatus(st('PENDING_DEPOSIT', { deadlinePassed: true }), quote)).toMatchObject({
      tone: 'warn',
      title: 'Expired: no deposit arrived before the deadline',
    });
  });

  it('shows how much of the quote arrived, like a payment terminal', () => {
    expect(
      describeStatus(st('KNOWN_DEPOSIT_TX', { depositedAmount: '50000000' }), quote),
    ).toMatchObject({
      tone: 'wait',
      title: 'Deposit seen on Ethereum, waiting for confirmations',
      detail: 'Received 50 of 50 USDC.',
    });
    expect(describeStatus(st('PROCESSING', { depositedAmount: '50000000' }), quote)).toMatchObject({
      tone: 'wait',
      title: 'Deposit received, swapping to wNEAR',
    });
  });

  it('an incomplete deposit shows what is missing and that it is refunded at the deadline', () => {
    expect(
      describeStatus(st('INCOMPLETE_DEPOSIT', { depositedAmount: '40000000' }), quote),
    ).toEqual({
      tone: 'warn',
      title: 'Received 40 of 50 USDC: 10 USDC missing',
      detail: 'Less than the quote arrived. 1Click refunds it to 0xrefund after the deadline.',
    });
  });

  it('success shows the amount received on NEAR and links the tx on our own explorer', () => {
    expect(
      describeStatus(
        st('SUCCESS', { amountOut: '20000000000000000000000000', nearTxHash: NEAR_TX }),
        quote,
      ),
    ).toEqual({
      tone: 'ok',
      title: 'Done: 20 wNEAR arrived in alice.near',
      txUrl: `https://nearblocks.io/txns/${NEAR_TX}`,
    });
    expect(describeStatus(st('SUCCESS'), quote)).toEqual({
      tone: 'ok',
      title: 'Done: the swap arrived in alice.near',
    });
  });

  it('a refund shows the amount, the reason and where it went', () => {
    expect(
      describeStatus(
        st('REFUNDED', { refundedAmount: '40000000', refundReason: 'PARTIAL_DEPOSIT' }),
        quote,
      ),
    ).toEqual({
      tone: 'warn',
      title: 'Refunded: 40 USDC sent back to 0xrefund',
      detail: 'Reason: the deposit was less than the quote.',
    });
    expect(describeStatus(st('REFUNDED', { refundReason: 'SOMETHING_ELSE' }), quote)).toMatchObject(
      {
        title: 'Refunded to 0xrefund',
        detail: 'Reason: SOMETHING_ELSE.',
      },
    );
  });

  it('failed and unknown statuses are not trusted as success', () => {
    expect(describeStatus(st('FAILED'), quote)).toMatchObject({
      tone: 'warn',
      title: 'The swap failed',
    });
    expect(describeStatus(st('UNKNOWN'), quote)).toMatchObject({
      tone: 'wait',
      title: 'Unknown status from 1Click',
    });
  });
});

describe('statusDelayMs', () => {
  it('starts at 5 s and backs off to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(statusDelayMs)).toEqual([
      5_000, 7_500, 11_250, 16_875, 25_313, 30_000, 30_000,
    ]);
  });
});

describe('stopReason', () => {
  it('stops at a final status', () => {
    for (const s of ['SUCCESS', 'REFUNDED', 'FAILED'] as const)
      expect(stopReason(st(s), 1)).toBe('final');
  });
  it('stops at the deadline only while no deposit is seen', () => {
    expect(stopReason(st('PENDING_DEPOSIT', { deadlinePassed: true }), 1)).toBe('expired');
    for (const s of ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'INCOMPLETE_DEPOSIT', 'UNKNOWN'] as const)
      expect(stopReason(st(s, { deadlinePassed: true }), 1)).toBeNull();
  });
  it('stops after the maximum number of checks', () => {
    expect(stopReason(st('PROCESSING'), STATUS_MAX_CHECKS - 1)).toBeNull();
    expect(stopReason(st('PROCESSING'), STATUS_MAX_CHECKS)).toBe('limit');
    expect(stopReason(null, STATUS_MAX_CHECKS)).toBe('limit');
  });
});
