import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultDestination,
  defaultOrigin,
  describeStatus,
  explorerTxUrl,
  formatUnits,
  loadDepositTransfer,
  walletChainOf,
  walletSendError,
  loadDepositIncidents,
  loadDepositStatus,
  searchTokens,
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
  origin: { assetId: 'nep141:eth-usdc', symbol: 'USDC', decimals: 6, payment: null },
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
      title: 'Expired: no deposit seen by the deadline',
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

describe('loadDepositStatus', () => {
  afterEach(() => vi.unstubAllGlobals());
  const serve = (body: unknown) =>
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }));

  it('accepts a well-formed status', async () => {
    serve(st('PROCESSING', { depositedAmount: '50000000' }));
    expect(await loadDepositStatus('dq_1')).toEqual({
      ok: true,
      data: st('PROCESSING', { depositedAmount: '50000000' }),
    });
  });

  it('refuses a malformed one instead of rendering it', async () => {
    for (const bad of [
      st('PROCESSING', { depositedAmount: '1.5' }),
      { ...st('SUCCESS'), nearTxHash: 'javascript:alert(1)' },
      { ...st('SUCCESS'), status: 'DONE' },
    ]) {
      serve(bad);
      expect((await loadDepositStatus('dq_1')).ok).toBe(false);
    }
  });
});

describe('loadDepositIncidents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the route and returns the messages', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ incidents: [{ message: 'ETH deposits are delayed' }] }));
    });
    expect(await loadDepositIncidents('nep141:eth.omft.near', 'nep141:wrap.near')).toEqual([
      'ETH deposits are delayed',
    ]);
    expect(urls).toEqual([
      '/api/deposit/incidents?origin=nep141%3Aeth.omft.near&destination=nep141%3Awrap.near',
    ]);
  });

  it('shows nothing on a malformed answer or a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ incidents: [{ message: 1 }] })),
    );
    expect(await loadDepositIncidents('a', 'b')).toEqual([]);
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect(await loadDepositIncidents('a', 'b')).toEqual([]);
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

describe('defaultOrigin', () => {
  const t = (symbol: string, chain: string) => ({
    assetId: `${chain}:${symbol}`,
    symbol,
    decimals: 6,
    chain,
    chainName: chain,
  });
  const origins = [
    t('USDC', 'eth'),
    t('ETH', 'eth'),
    t('ETH', 'arb'),
    t('BTC', 'btc'),
    t('PEPE', 'sol'),
  ];

  it('takes USDC on the chain, else its native token, else the first there', () => {
    expect(defaultOrigin(origins, 'eth')?.assetId).toBe('eth:USDC');
    expect(defaultOrigin(origins, 'arb')?.assetId).toBe('arb:ETH');
    expect(defaultOrigin(origins, 'btc')?.assetId).toBe('btc:BTC');
    expect(defaultOrigin(origins, 'sol')?.assetId).toBe('sol:PEPE');
    expect(defaultOrigin(origins, 'base')).toBeUndefined();
  });
});

describe('searchTokens', () => {
  const list = ['USDT', 'USDC', 'ETH', 'steakUSDC', 'WETH'].map((symbol) => ({
    assetId: symbol,
    symbol,
    decimals: 6,
  }));

  it('matches the symbol case-insensitively, symbols starting with the query first', () => {
    expect(searchTokens(list, 'usd').map((x) => x.symbol)).toEqual(['USDT', 'USDC', 'steakUSDC']);
    expect(searchTokens(list, ' eth ').map((x) => x.symbol)).toEqual(['ETH', 'WETH']);
  });

  it('keeps the whole list for an empty query', () => {
    expect(searchTokens(list, '')).toEqual(list);
  });
});

describe('loadDepositTransfer', () => {
  afterEach(() => vi.unstubAllGlobals());
  const transfer = {
    quoteId: 'dq_1',
    chain: 'eth',
    receiver: '0xdeposit',
    amount: '50000000',
    token: {
      assetId: 'nep141:eth-usdc',
      blockchain: 'eth',
      symbol: 'USDC',
      decimals: 6,
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    },
  };
  const serve = (body: unknown, status = 200) =>
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));

  it('returns the server transfer when it is exactly the quote on screen', async () => {
    serve(transfer);
    expect(await loadDepositTransfer(quote)).toEqual({ ok: true, data: transfer });
  });

  it('refuses one that differs from the quote in chain, asset, amount or address', async () => {
    for (const bad of [
      { ...transfer, quoteId: 'dq_2' },
      { ...transfer, chain: 'base', token: { ...transfer.token, blockchain: 'base' } },
      { ...transfer, receiver: '0xattacker' },
      { ...transfer, amount: '50000001' },
      { ...transfer, token: { ...transfer.token, assetId: 'nep141:eth.omft.near' } },
      { ...transfer, token: { ...transfer.token, decimals: 18 } },
      { ...transfer, token: { ...transfer.token, blockchain: 'base' } },
      { ...transfer, amount: '5e7' },
    ]) {
      serve(bad);
      expect((await loadDepositTransfer(quote)).ok).toBe(false);
    }
  });

  it('asks for a retry only when told to', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(transfer));
    });
    await loadDepositTransfer(quote);
    await loadDepositTransfer(quote, true);
    expect(urls).toEqual(['/api/deposit/transfer/dq_1', '/api/deposit/transfer/dq_1?retry=1']);
  });

  it('passes the server refusal through', async () => {
    serve({ error: 'This quote has expired. Get a new one.' }, 409);
    expect(await loadDepositTransfer(quote)).toEqual({
      ok: false,
      error: 'This quote has expired. Get a new one.',
    });
  });
});

describe('walletChainOf', () => {
  it('maps EVM chains and Solana to the wallet that sends there; Bitcoin has none', () => {
    expect(['eth', 'base', 'arb', 'sol', 'btc', 'x'].map(walletChainOf)).toEqual([
      'evm',
      'evm',
      'evm',
      'solana',
      null,
      null,
    ]);
  });
});

describe('walletSendError', () => {
  const usdc: DepositQuote = {
    ...quote,
    chain: 'base',
    chainName: 'Base',
    origin: { ...quote.origin, payment: { contract: '0x8335' } },
  };
  const eth: DepositQuote = {
    ...usdc,
    origin: {
      assetId: 'nep141:base.omft.near',
      symbol: 'ETH',
      decimals: 18,
      payment: { native: true },
    },
    amountIn: '1000000000000000',
  };

  it('names the fee coin when only the fee is missing, not the token already there', () => {
    expect(walletSendError('no-gas', usdc, 'gas required exceeds allowance (0)')).toBe(
      'Nothing was sent: your wallet does not have enough ETH on Base to pay the network fee. Add a little ETH on Base (cents are enough) and press the button again.',
    );
  });

  it('names the token when the wallet holds less than the quote', () => {
    expect(walletSendError('no-token', usdc, 'exceeds balance')).toBe(
      'Nothing was sent: your wallet on Base has less than 50 USDC. Top it up and press the button again.',
    );
  });

  it('for the native coin, the amount and the fee are one shortfall', () => {
    for (const kind of ['no-gas', 'no-token'] as const)
      expect(walletSendError(kind, eth, '')).toBe(
        'Nothing was sent: your wallet needs 0.001 ETH on Base plus a little more for the network fee. Top it up and press the button again.',
      );
  });

  it('says what the network answered for another refusal, and the declined case', () => {
    expect(walletSendError('not-sent', usdc, 'execution reverted: blacklisted')).toBe(
      'Nothing was sent: the network refused the transfer (execution reverted: blacklisted).',
    );
    expect(walletSendError('declined', usdc, '')).toBe(
      'You declined in your wallet. Nothing was sent.',
    );
  });
});

describe('explorerTxUrl', () => {
  it('links the origin chain explorer, only for a hash of that chain', () => {
    const evm = `0x${'ab'.repeat(32)}`;
    const sol = '5'.repeat(88);
    expect(explorerTxUrl('base', evm)).toBe(`https://basescan.org/tx/${evm}`);
    expect(explorerTxUrl('eth', evm)).toBe(`https://etherscan.io/tx/${evm}`);
    expect(explorerTxUrl('arb', evm)).toBe(`https://arbiscan.io/tx/${evm}`);
    expect(explorerTxUrl('sol', sol)).toBe(`https://solscan.io/tx/${sol}`);
    expect(explorerTxUrl('sol', evm)).toBeNull();
    expect(explorerTxUrl('base', 'javascript:alert(1)')).toBeNull();
  });
});
