import { describe, expect, it } from 'vitest';
import {
  DepositQuoteRefused,
  ONE_CLICK_BASE_URL,
  OneClickDepositClient,
  type DepositQuoteRequest,
} from '../src/gateway/one-click-deposit';

const NOW = new Date('2026-11-13T10:00:00Z');
const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const REFUND = '0x2527d02599ba641c19fea793cd0f167589a0f10d';
const DEPOSIT = '0x76b4c56085ED136a8744D52bE956396624a730E8';

const request: DepositQuoteRequest = {
  originAsset: USDC_ETH,
  destinationAsset: USDC_NEAR,
  amountIn: 100_000_000n,
  refundTo: REFUND,
  recipient: 'alice.near',
  slippageBps: 100,
  now: NOW,
};

function answer(over: { quoteRequest?: object; quote?: object } = {}) {
  return {
    correlationId: 'c0ffee',
    timestamp: '2026-11-13T10:00:01Z',
    signature: 'ed25519:sig',
    quoteRequest: {
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: USDC_ETH,
      destinationAsset: USDC_NEAR,
      amount: '100000000',
      refundTo: REFUND,
      recipient: 'alice.near',
      depositType: 'ORIGIN_CHAIN',
      refundType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      slippageTolerance: 100,
      appFees: [{ recipient: 'fees.near', fee: 1 }],
      ...over.quoteRequest,
    },
    quote: {
      depositAddress: DEPOSIT,
      amountIn: '100000000',
      amountInFormatted: '100',
      amountInUsd: '100.01',
      minAmountIn: '100000000',
      amountOut: '99750000',
      amountOutFormatted: '99.75',
      amountOutUsd: '99.74',
      minAmountOut: '98752500',
      deadline: '2026-11-13T10:10:00Z',
      timeWhenInactive: '2026-11-13T10:10:00Z',
      timeEstimate: 120,
      ...over.quote,
    },
  };
}

function stub(reply: unknown = answer()) {
  const calls: { url: string; body?: unknown; headers: Record<string, string> }[] = [];
  const http = {
    async getJson(url: string, headers: Record<string, string> = {}) {
      calls.push({ url, headers });
      return reply;
    },
    async postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
      calls.push({ url, body, headers });
      return reply;
    },
  };
  return { http, calls };
}

describe('OneClickDepositClient.quote', () => {
  it('posts a real (dry: false) quote to the hard-coded 1Click URL and returns the verified deposit', async () => {
    const { http, calls } = stub();
    const q = await new OneClickDepositClient({ http }).quote(request);
    expect(ONE_CLICK_BASE_URL).toBe('https://1click.chaindefuser.com');
    expect(calls[0]?.url).toBe('https://1click.chaindefuser.com/v0/quote');
    expect(calls[0]?.body).toMatchObject({
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: USDC_ETH,
      destinationAsset: USDC_NEAR,
      amount: '100000000',
      refundTo: REFUND,
      refundType: 'ORIGIN_CHAIN',
      recipient: 'alice.near',
      recipientType: 'DESTINATION_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      slippageTolerance: 100,
    });
    expect(q).toMatchObject({
      depositAddress: DEPOSIT,
      deadline: new Date('2026-11-13T10:10:00Z'),
      amountIn: 100_000_000n,
      amountOut: 99_750_000n,
      minAmountOut: 98_752_500n,
      amountOutUsd: '99.74',
      timeEstimateSeconds: 120,
      appFeeBps: 1,
      correlationId: 'c0ffee',
      signature: 'ed25519:sig',
    });
  });

  it('sends no auth header without a JWT and a Bearer header with one', async () => {
    const without = stub();
    await new OneClickDepositClient({ http: without.http }).quote(request);
    expect(without.calls[0]?.headers).toEqual({});

    const withJwt = stub();
    await new OneClickDepositClient({ http: withJwt.http, jwt: 'eyJ.secret' }).quote(request);
    expect(withJwt.calls[0]?.headers).toEqual({ authorization: 'Bearer eyJ.secret' });
  });

  it.each([
    ['dry quote', { quoteRequest: { dry: true } }],
    ['other origin asset', { quoteRequest: { originAsset: 'nep141:eth.omft.near' } }],
    ['other destination asset', { quoteRequest: { destinationAsset: 'nep141:wrap.near' } }],
    ['other request amount', { quoteRequest: { amount: '1' } }],
    ['other recipient', { quoteRequest: { recipient: 'mallory.near' } }],
    ['other refund address', { quoteRequest: { refundTo: '0x' + 'f'.repeat(40) } }],
    ['other swap type', { quoteRequest: { swapType: 'ANY_INPUT' } }],
    ['refund into intents', { quoteRequest: { refundType: 'INTENTS' } }],
    ['recipient inside intents', { quoteRequest: { recipientType: 'INTENTS' } }],
    ['other quoted amount', { quote: { amountIn: '99999999' } }],
    ['no deposit address', { quote: { depositAddress: undefined } }],
    ['empty deposit address', { quote: { depositAddress: '' } }],
    ['a deposit memo', { quote: { depositMemo: '1111111' } }],
    ['no deadline', { quote: { deadline: undefined } }],
    ['a past deadline', { quote: { deadline: '2026-11-13T09:59:59Z' } }],
    ['a deadline equal to now', { quote: { deadline: '2026-11-13T10:00:00Z' } }],
    ['a non-integer amount out', { quote: { amountOut: '1.5' } }],
    ['another slippage', { quoteRequest: { slippageTolerance: 5000 } }],
    ['a zero payout', { quote: { amountOut: '0', minAmountOut: '0' } }],
    ['fees summing over 1%', { quoteRequest: { appFees: [{ fee: 60 }, { fee: 41 }] } }],
    ['a deadline over 7 days away', { quote: { deadline: '2026-11-20T10:00:01Z' } }],
    ['a time estimate over a day', { quote: { timeEstimate: 1e308 } }],
    ['a custom recipient message', { quoteRequest: { customRecipientMsg: 'x' } }],
    [
      'a virtual chain recipient',
      { quoteRequest: { virtualChainRecipient: '0x' + '1'.repeat(40) } },
    ],
    [
      'a virtual chain recipient on the quote',
      { quote: { virtualChainRecipient: '0x' + '1'.repeat(40) } },
    ],
    ['a floor below the 1% slippage', { quote: { minAmountOut: '98752499' } }],
    ['a floor above the estimate', { quote: { minAmountOut: '99750001' } }],
  ])('refuses a quote with %s', async (_, over) => {
    const { http } = stub(answer(over));
    await expect(new OneClickDepositClient({ http }).quote(request)).rejects.toBeInstanceOf(
      DepositQuoteRefused,
    );
  });

  it('reads the fee 1Click echoes in appFees, null when it echoes none', async () => {
    const two = stub(answer({ quoteRequest: { appFees: [{ fee: 20 }, { fee: 5 }] } }));
    expect((await new OneClickDepositClient({ http: two.http }).quote(request)).appFeeBps).toBe(25);
    const none = stub(answer({ quoteRequest: { appFees: undefined } }));
    expect((await new OneClickDepositClient({ http: none.http }).quote(request)).appFeeBps).toBe(
      null,
    );
  });

  it('accepts a null or empty deposit memo', async () => {
    for (const depositMemo of [null, '']) {
      const { http } = stub(answer({ quote: { depositMemo } }));
      await expect(new OneClickDepositClient({ http }).quote(request)).resolves.toMatchObject({
        depositAddress: DEPOSIT,
      });
    }
  });

  it('never puts the JWT in a refusal message', async () => {
    const { http } = stub({ nonsense: true });
    const err = await new OneClickDepositClient({ http, jwt: 'eyJ.secret' }).quote(request).then(
      () => new Error('resolved'),
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(DepositQuoteRefused);
    expect(err.message).not.toContain('eyJ.secret');
  });
});

describe('OneClickDepositClient.tokens', () => {
  const list = [
    { assetId: USDC_ETH, decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 1 },
    { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL' },
    {
      assetId: USDC_NEAR,
      decimals: 6,
      blockchain: 'near',
      symbol: 'USDC',
      contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    },
    { assetId: 'nep141:xlm.omft.near', decimals: 7, blockchain: 'stellar', symbol: 'XLM' },
    { assetId: 'nep141:broken', decimals: -1, blockchain: 'eth', symbol: 'BAD' },
  ];

  it('parses /v0/tokens, drops malformed entries and caches the list for 10 minutes', async () => {
    const { http, calls } = stub(list);
    let now = NOW.getTime();
    const client = new OneClickDepositClient({ http, now: () => now });
    const first = await client.tokens();
    expect(calls[0]?.url).toBe('https://1click.chaindefuser.com/v0/tokens');
    expect(first.map((t) => t.assetId)).toEqual([
      USDC_ETH,
      'nep141:sol.omft.near',
      USDC_NEAR,
      'nep141:xlm.omft.near',
    ]);
    now += 9 * 60_000;
    await client.tokens();
    expect(calls).toHaveLength(1);
    now += 2 * 60_000;
    await client.tokens();
    expect(calls).toHaveLength(2);
  });

  it('refuses an answer that is not a list', async () => {
    const { http } = stub({ tokens: [] });
    await expect(new OneClickDepositClient({ http }).tokens()).rejects.toBeInstanceOf(
      DepositQuoteRefused,
    );
  });
});

describe('OneClickDepositClient.status', () => {
  const NEAR_TX = '7Ytp5ZTdDuEe8VbWbkxhV5mBvRcP4tH8u6uJYHzdGMqd';
  const reply = (over: object = {}, details: object = {}) => ({
    correlationId: 'c0ffee',
    quoteResponse: {},
    status: 'SUCCESS',
    updatedAt: '2026-11-13T10:05:00Z',
    swapDetails: {
      depositedAmount: '100000000',
      depositedAmountFormatted: '100',
      amountOut: '99750000',
      refundedAmount: '0',
      destinationChainTxHashes: [{ hash: NEAR_TX, explorerUrl: 'https://evil.example/tx' }],
      ...details,
    },
    ...over,
  });

  it('asks by deposit address with the JWT and returns the parsed status', async () => {
    const { http, calls } = stub(reply());
    const s = await new OneClickDepositClient({ http, jwt: 'eyJ.secret' }).status(DEPOSIT);
    expect(calls[0]).toEqual({
      url: `${ONE_CLICK_BASE_URL}/v0/status?depositAddress=${encodeURIComponent(DEPOSIT)}`,
      headers: { authorization: 'Bearer eyJ.secret' },
    });
    expect(s).toEqual({
      status: 'SUCCESS',
      depositedAmount: 100_000_000n,
      amountOut: 99_750_000n,
      refundedAmount: 0n,
      refundReason: null,
      nearTxHash: NEAR_TX,
    });
  });

  it('reports a status it does not know as UNKNOWN', async () => {
    const { http } = stub(reply({ status: 'DONE_TRUST_ME' }));
    expect((await new OneClickDepositClient({ http }).status(DEPOSIT)).status).toBe('UNKNOWN');
  });

  it('drops malformed details instead of trusting them', async () => {
    const { http } = stub(
      reply(
        { status: 'REFUNDED' },
        {
          depositedAmount: '-5',
          amountOut: '1e9',
          refundedAmount: '40000000',
          refundReason: '<script>alert(1)</script>',
          destinationChainTxHashes: [{ hash: 'javascript:alert(1)', explorerUrl: '' }],
        },
      ),
    );
    expect(await new OneClickDepositClient({ http }).status(DEPOSIT)).toEqual({
      status: 'REFUNDED',
      depositedAmount: null,
      amountOut: null,
      refundedAmount: 40_000_000n,
      refundReason: null,
      nearTxHash: null,
    });
  });

  it('keeps a plain refund reason and survives missing swap details', async () => {
    const { http } = stub({
      status: 'INCOMPLETE_DEPOSIT',
      swapDetails: { refundReason: 'PARTIAL_DEPOSIT' },
    });
    expect(await new OneClickDepositClient({ http }).status(DEPOSIT)).toMatchObject({
      status: 'INCOMPLETE_DEPOSIT',
      depositedAmount: null,
      refundReason: 'PARTIAL_DEPOSIT',
    });
  });

  it('refuses an answer without a status', async () => {
    const { http } = stub({ swapDetails: {} });
    await expect(new OneClickDepositClient({ http }).status(DEPOSIT)).rejects.toBeInstanceOf(
      DepositQuoteRefused,
    );
  });
});
