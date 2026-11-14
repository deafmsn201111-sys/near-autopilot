import { describe, expect, it } from 'vitest';
import { toBaseUnits, type DepositDeps, type StoredDepositQuote } from '../src/analytics/deposit';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import {
  DepositQuoteRefused,
  type DepositQuote,
  type DepositQuoteRequest,
  type OneClickToken,
} from '../src/gateway/one-click-deposit';

const NOW = new Date('2026-11-13T10:00:00Z');
const API_TOKEN = 'public-token-public-token-public-token-1';
const USDC_NEAR_ID = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const TOKENS: OneClickToken[] = [
  { assetId: 'nep141:eth.omft.near', decimals: 18, blockchain: 'eth', symbol: 'ETH' },
  { assetId: 'nep141:eth-0xa0b8.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC' },
  { assetId: 'nep141:zzz.omft.near', decimals: 6, blockchain: 'base', symbol: 'AAA' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC' },
  { assetId: 'nep141:xlm.omft.near', decimals: 7, blockchain: 'stellar', symbol: 'XLM' },
  {
    assetId: `nep141:${USDC_NEAR_ID}`,
    decimals: 6,
    blockchain: 'near',
    symbol: 'USDC',
    contractAddress: USDC_NEAR_ID,
  },
  {
    assetId: 'nep141:wrap.near',
    decimals: 24,
    blockchain: 'near',
    symbol: 'wNEAR',
    contractAddress: 'wrap.near',
  },
  {
    assetId: 'nep141:aurora',
    decimals: 18,
    blockchain: 'near',
    symbol: 'AURORA',
    contractAddress: 'aurora',
  },
];
const RECIPIENT = '0x2527d02599ba641c19fea793cd0f167589a0f10d';
const DEPOSIT = '90fda5d81a9f4cb725fc777bd339c089069e16afb180b4b350a5151544b0cbff';

const quoted = (over: Partial<DepositQuote> = {}): DepositQuote => ({
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
  ...over,
});

const unused = async (): Promise<never> => {
  throw new Error('not used');
};

function setup(
  o: {
    quote?: () => Promise<DepositQuote>;
    icon?: DepositDeps['icon'];
    tokens?: OneClickToken[];
    solanaFees?: DepositDeps['solanaFees'];
    find?: DepositDeps['store']['find'];
    save?: DepositDeps['store']['save'];
    status?: DepositDeps['oneClick']['status'];
    issueTransfer?: DepositDeps['store']['issueTransfer'];
  } = {},
) {
  const saved: StoredDepositQuote[] = [];
  const asked: DepositQuoteRequest[] = [];
  const deposit: DepositDeps = {
    oneClick: {
      tokens: async () => o.tokens ?? TOKENS,
      quote: async (r) => {
        asked.push(r);
        return (o.quote ?? (async () => quoted()))();
      },
      status: o.status ?? unused,
    },
    store: {
      save: o.save ?? (async (q) => void saved.push(q)),
      purge: async () => undefined,
      find: o.find ?? unused,
      saveStatus: unused,
      unfinished: unused,
      issueTransfer: o.issueTransfer ?? (async () => true),
    },
    destinationTokens: ['wrap.near', USDC_NEAR_ID, 'usdt.tether-token.near'],
    newId: () => 'dq_1',
    ...(o.icon ? { icon: o.icon } : {}),
    ...(o.solanaFees ? { solanaFees: o.solanaFees } : {}),
  };
  const app = buildAnalyticsServer({
    apiToken: API_TOKEN,
    store: {} as CollectorStore,
    intervalSeconds: 900,
    now: () => NOW,
    deposit,
  });
  const post = (body: object) =>
    app.inject({
      method: 'POST',
      url: '/v1/withdraw/quote',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: body,
    });
  return { app, post, saved, asked };
}

const body = {
  account: 'alice.near',
  originAsset: `nep141:${USDC_NEAR_ID}`,
  destinationAsset: 'nep141:eth-0xa0b8.omft.near',
  amount: '100',
  recipient: RECIPIENT,
};

describe('toBaseUnits', () => {
  it('converts a decimal amount with the token decimals, exactly', () => {
    expect(toBaseUnits('100', 6)).toBe(100_000_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('1.5', 18)).toBe(1_500_000_000_000_000_000n);
  });
  it('refuses zero, too many decimals, signs and junk', () => {
    for (const a of [
      '0',
      '0.0',
      '0.0000001',
      '-1',
      '1e6',
      '',
      '.5',
      '1.',
      ' 1',
      '1,5',
      '1'.repeat(40),
    ])
      expect(toBaseUnits(a, 6)).toBeNull();
  });
});

describe('GET /v1/deposit/assets', () => {
  it('lists origins on the allowed chains only, popular first, and destinations from our own list', async () => {
    const res = await setup().app.inject({
      url: '/v1/deposit/assets',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const json = res.json<{ origins: { assetId: string }[]; destinations: { symbol: string }[] }>();
    expect(json.origins.map((o) => o.assetId)).toEqual([
      'nep141:eth-0xa0b8.omft.near',
      'nep141:eth.omft.near',
      'nep141:btc.omft.near',
      'nep141:zzz.omft.near',
    ]);
    expect(json.destinations.map((d) => d.symbol)).toEqual(['wNEAR', 'USDC']);
  });

  describe('Solana tokens that take a fee on every transfer', () => {
    const NEARKAT = '6UtY9iTZMQQ5QZVrbzFnNaJntV7oySm9k97mvwnuZcxr';
    const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const sol = (symbol: string, contractAddress?: string): OneClickToken => ({
      assetId: `nep141:sol-${symbol.toLowerCase()}.omft.near`,
      decimals: 6,
      blockchain: 'sol',
      symbol,
      ...(contractAddress ? { contractAddress } : {}),
    });
    const tokens = [
      ...TOKENS,
      { ...sol('SOL'), assetId: 'nep141:sol.omft.near', decimals: 9 },
      sol('USDC', USDC_SOL),
      sol('NEARKAT', NEARKAT),
      sol('NOMINT'),
    ];
    const asked: string[][] = [];
    const solanaFees: DepositDeps['solanaFees'] = {
      unsafe: async (mints) => {
        asked.push([...mints]);
        return new Set(mints.filter((m) => m === NEARKAT));
      },
    };

    it('are not listed; native SOL and a plain mint are; a non-native token with no mint is not', async () => {
      const res = await setup({ tokens, solanaFees }).app.inject({
        url: '/v1/deposit/assets',
        headers: { authorization: `Bearer ${API_TOKEN}` },
      });
      const symbols = res
        .json<{ origins: { symbol: string; chain: string }[] }>()
        .origins.filter((o) => o.chain === 'sol')
        .map((o) => o.symbol);
      expect(symbols).toEqual(['USDC', 'SOL']);
      expect(asked.at(-1)).toEqual([USDC_SOL, NEARKAT]);
    });

    it('are refused for a withdrawal quote before 1Click is called', async () => {
      const { post, asked: quoted } = setup({ tokens, solanaFees });
      const res = await post({
        ...body,
        destinationAsset: sol('NEARKAT').assetId,
        recipient: '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Unknown token to receive.' });
      expect(quoted).toEqual([]);
    });
  });

  it('gives every listed token the logo of its NEAR token (nep141 id), or null', async () => {
    const asked: string[] = [];
    const res = await setup({
      icon: async (id) => {
        asked.push(id);
        return id === 'eth.omft.near' ? 'data:image/png;base64,AAAA' : null;
      },
    }).app.inject({ url: '/v1/deposit/assets', headers: { authorization: `Bearer ${API_TOKEN}` } });
    const json = res.json<{ origins: { assetId: string; icon: string | null }[] }>();
    expect(json.origins.find((o) => o.assetId === 'nep141:eth.omft.near')?.icon).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(json.origins.find((o) => o.assetId === 'nep141:btc.omft.near')?.icon).toBeNull();
    expect(asked).toContain('wrap.near');
  });
});

describe('POST /v1/withdraw/quote: the 1Click answer', () => {
  it('stores and returns no fee when 1Click echoes none', async () => {
    const { post, saved } = setup({ quote: async () => quoted({ appFeeBps: null }) });
    const res = await post(body);
    expect(res.json<{ fee: { bps: number | null } }>().fee.bps).toBeNull();
    expect(saved[0]?.feeBps).toBeNull();
  });

  it('hides the address on a refused quote: generic 502, nothing stored', async () => {
    const { post, saved } = setup({
      quote: async () => Promise.reject(new DepositQuoteRefused('1Click quote differs: recipient')),
    });
    const res = await post(body);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'The 1Click quote could not be verified, so no deposit address is shown. Try again.',
    });
    expect(saved).toHaveLength(0);
  });

  it('answers a store failure with a generic 500 and no deposit address', async () => {
    const { post } = setup({ save: async () => Promise.reject(new Error('db down')) });
    const res = await post(body);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(DEPOSIT);
  });

  it('answers a 1Click failure with a generic message, without upstream text', async () => {
    const { post } = setup({
      quote: async () => Promise.reject(new Error('Amount too low <script>')),
    });
    const res = await post(body);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: '1Click has no quote for this amount right now. Try a larger amount or another token.',
    });
  });
});
