import { describe, expect, it } from 'vitest';
import {
  paymentToken,
  toBaseUnits,
  type DepositDeps,
  type StoredDepositQuote,
} from '../src/analytics/deposit';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import {
  DepositQuoteRefused,
  type DepositQuote,
  type DepositQuoteRequest,
  type OneClickToken,
  type SwapStatus,
} from '../src/gateway/one-click-deposit';
import type { ShieldIncident } from '../src/gateway/shield';

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
const REFUND = '0x2527d02599ba641c19fea793cd0f167589a0f10d';
const DEPOSIT = '0x76b4c56085ed136a8744d52be956396624a730e8';

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
    shield?: DepositDeps['shield'];
    tokens?: OneClickToken[];
    solanaFees?: DepositDeps['solanaFees'];
    find?: DepositDeps['store']['find'];
    status?: DepositDeps['oneClick']['status'];
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
      save: async (q) => void saved.push(q),
      purge: async () => undefined,
      find: o.find ?? unused,
      saveStatus: unused,
      unfinished: unused,
    },
    destinationTokens: ['wrap.near', USDC_NEAR_ID, 'usdt.tether-token.near'],
    newId: () => 'dq_1',
    ...(o.icon ? { icon: o.icon } : {}),
    ...(o.shield ? { shield: o.shield } : {}),
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
      url: '/v1/deposit/quote',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: body,
    });
  return { app, post, saved, asked };
}

const body = {
  account: 'alice.near',
  originAsset: 'nep141:eth-0xa0b8.omft.near',
  destinationAsset: `nep141:${USDC_NEAR_ID}`,
  amount: '100',
  refundTo: REFUND,
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

describe('paymentToken', () => {
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const t = (blockchain: string, assetId: string, contractAddress?: string): OneClickToken => ({
    assetId,
    blockchain,
    contractAddress,
    decimals: 6,
    symbol: 'USDC',
  });

  it('names the native coin only by its exact 1Click asset id', () => {
    expect(paymentToken('eth', t('eth', 'nep141:eth.omft.near'))).toEqual({ native: true });
    expect(paymentToken('btc', t('btc', 'nep141:btc.omft.near'))).toEqual({ native: true });
    expect(paymentToken('base', t('base', 'nep141:eth.omft.near'))).toBeNull();
    expect(paymentToken('btc', t('btc', '1cs_v1:btc:native:coin'))).toBeNull();
    expect(paymentToken('eth', t('eth', 'nep141:eth-0xa0b8.omft.near'))).toBeNull();
  });

  it('returns the token contract when it is an address of the chain the quoted asset names', () => {
    expect(
      paymentToken('base', t('base', `nep141:base-${BASE_USDC}.omft.near`, BASE_USDC)),
    ).toEqual({ contract: BASE_USDC });
    expect(paymentToken('base', t('base', `1cs_v1:base:erc20:${BASE_USDC}`, BASE_USDC))).toEqual({
      contract: BASE_USDC,
    });
    expect(paymentToken('sol', t('sol', 'nep141:sol-5ce3bf3a.omft.near', SOL_USDC))).toEqual({
      contract: SOL_USDC,
    });
  });

  it('refuses a contract the quoted asset does not name, one of another chain, or a burn address', () => {
    const other = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const zero = `0x${'0'.repeat(40)}`;
    expect(paymentToken('base', t('base', `nep141:base-${BASE_USDC}.omft.near`, other))).toBeNull();
    expect(paymentToken('eth', t('eth', `nep141:eth-${zero}.omft.near`, zero))).toBeNull();
    expect(paymentToken('eth', t('eth', 'nep141:eth-x.omft.near', SOL_USDC))).toBeNull();
    expect(paymentToken('sol', t('sol', 'nep141:sol-x.omft.near', BASE_USDC))).toBeNull();
    expect(paymentToken('btc', t('btc', 'nep141:btc.omft.near', 'bc1q'))).toBeNull();
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

    it('are refused for a quote before 1Click is called', async () => {
      const { post, asked: quoted } = setup({ tokens, solanaFees });
      const res = await post({
        ...body,
        originAsset: sol('NEARKAT').assetId,
        refundTo: '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'Unknown origin token.' });
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

describe('GET /v1/deposit/incidents', () => {
  const get = (app: ReturnType<typeof setup>['app'], origin: string) =>
    app.inject({
      url: `/v1/deposit/incidents?origin=${encodeURIComponent(origin)}&destination=nep141%3A${USDC_NEAR_ID}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
  const incident = (over: Partial<ShieldIncident>): ShieldIncident => ({
    scopeType: 'chain',
    scopeValue: 'eth',
    direction: 'deposit',
    text: null,
    ...over,
  });

  it('shows the incidents on the chosen route, with SHIELD text or our own copy', async () => {
    const { app } = setup({
      shield: {
        incidents: async () => [
          incident({ text: 'ETH deposits are delayed' }),
          incident({}),
          incident({ scopeType: 'token', scopeValue: 'nep141:btc.omft.near' }),
          incident({ scopeType: 'bridge', scopeValue: 'poa', direction: null }),
        ],
      },
    });
    const res = await get(app, 'nep141:eth.omft.near');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      incidents: [
        { message: 'ETH deposits are delayed' },
        {
          message: 'Ethereum is affected, so your deposit may take longer than usual.',
        },
        {
          message: 'The PoA bridge is affected, so your deposit may take longer than usual.',
        },
      ],
    });
  });

  it('sends at most five warnings, so a wide outage still shows some', async () => {
    const many = Array.from({ length: 30 }, (_, n) => incident({ text: `Incident ${n}` }));
    const res = await get(
      setup({ shield: { incidents: async () => many } }).app,
      'nep141:eth.omft.near',
    );
    expect(res.json<{ incidents: unknown[] }>().incidents).toHaveLength(5);
  });

  it('answers with no incident when SHIELD is off, the route is unknown, or the token list fails', async () => {
    expect((await get(setup().app, 'nep141:eth.omft.near')).json()).toEqual({ incidents: [] });
    const shield = { incidents: async () => [incident({})] };
    expect((await get(setup({ shield }).app, 'nep141:nope')).json()).toEqual({ incidents: [] });
    const app = buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => NOW,
      deposit: {
        oneClick: { tokens: unused, quote: unused, status: unused },
        store: {} as DepositDeps['store'],
        destinationTokens: [USDC_NEAR_ID],
        shield,
      },
    });
    const res = await get(app, 'nep141:eth.omft.near');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ incidents: [] });
  });
});

describe('POST /v1/deposit/quote', () => {
  it('quotes the connected account, stores the quote and returns our id with read-only fields', async () => {
    const { post, saved, asked } = setup();
    const res = await post(body);
    expect(res.statusCode).toBe(200);
    expect(asked[0]).toMatchObject({
      originAsset: 'nep141:eth-0xa0b8.omft.near',
      destinationAsset: `nep141:${USDC_NEAR_ID}`,
      amountIn: 100_000_000n,
      refundTo: REFUND,
      recipient: 'alice.near',
    });
    expect(res.json()).toEqual({
      id: 'dq_1',
      chain: 'eth',
      chainName: 'Ethereum',
      to: { chain: 'near', chainName: 'NEAR' },
      origin: {
        assetId: 'nep141:eth-0xa0b8.omft.near',
        symbol: 'USDC',
        decimals: 6,
        payment: null,
      },
      destination: { assetId: `nep141:${USDC_NEAR_ID}`, symbol: 'USDC', decimals: 6 },
      amountIn: '100000000',
      amountOut: '99750000',
      minAmountOut: '98752500',
      amountOutUsd: { value: '99.74', provenance: 'protocol_reported' },
      fee: { bps: 1, provenance: 'protocol_reported' },
      recipient: 'alice.near',
      refundTo: REFUND,
      depositAddress: DEPOSIT,
      deadline: '2026-11-13T10:10:00.000Z',
      expiresInSeconds: 600,
      timeEstimateSeconds: 120,
    });
    expect(saved).toEqual([
      {
        id: 'dq_1',
        createdAt: NOW,
        accountId: 'alice.near',
        originAsset: 'nep141:eth-0xa0b8.omft.near',
        destinationAsset: `nep141:${USDC_NEAR_ID}`,
        amountIn: '100000000',
        amountOut: '99750000',
        minAmountOut: '98752500',
        refundTo: REFUND,
        depositAddress: DEPOSIT,
        deadline: new Date('2026-11-13T10:10:00Z'),
        correlationId: 'c0ffee',
        signature: 'ed25519:sig',
        feeBps: 1,
      },
    ]);
  });

  it('stores and returns no fee when 1Click echoes none', async () => {
    const { post, saved } = setup({ quote: async () => quoted({ appFeeBps: null }) });
    const res = await post(body);
    expect(res.json<{ fee: { bps: number | null } }>().fee.bps).toBeNull();
    expect(saved[0]?.feeBps).toBeNull();
  });

  it('refuses a refund address of another chain before calling 1Click', async () => {
    const { post, asked } = setup();
    const res = await post({ ...body, refundTo: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'The refund address is not a valid Ethereum address.' });
    expect(asked).toHaveLength(0);
  });

  it.each([
    ['an unknown origin', { originAsset: 'nep141:evil.near' }],
    ['an origin on a memo chain', { originAsset: 'nep141:xlm.omft.near' }],
    ['a NEAR token as origin', { originAsset: 'nep141:wrap.near' }],
    ['a destination outside our list', { destinationAsset: 'nep141:aurora' }],
    ['a destination that is not on NEAR', { destinationAsset: 'nep141:eth.omft.near' }],
    ['a zero amount', { amount: '0' }],
    ['too many decimals', { amount: '1.0000001' }],
    ['an invalid account', { account: 'Not An Account' }],
    ['an extra field', { recipient: 'mallory.near' }],
  ])('refuses %s with 400 and never calls 1Click', async (_, over) => {
    const { post, asked, saved } = setup();
    const res = await post({ ...body, ...over });
    expect(res.statusCode).toBe(400);
    expect(asked).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it.each([
    [
      'a refused quote',
      async () => Promise.reject(new DepositQuoteRefused('1Click quote differs: recipient')),
    ],
    [
      'a deposit address not of the origin chain',
      async () => quoted({ depositAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' }),
    ],
  ])('hides the address on %s: generic 502, nothing stored', async (_, quote) => {
    const { post, saved } = setup({ quote });
    const res = await post(body);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      error: 'The 1Click quote could not be verified, so no deposit address is shown. Try again.',
    });
    expect(res.body).not.toContain('recipient');
    expect(saved).toHaveLength(0);
  });

  it('answers a store failure with a generic 500 and no deposit address', async () => {
    const { app } = setup();
    const res = await buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => NOW,
      deposit: {
        oneClick: { tokens: async () => TOKENS, quote: async () => quoted(), status: unused },
        store: {
          save: async () => Promise.reject(new Error('db down')),
          purge: async () => undefined,
          find: unused,
          saveStatus: unused,
          unfinished: unused,
        },
        destinationTokens: [USDC_NEAR_ID],
      },
    }).inject({
      method: 'POST',
      url: '/v1/deposit/quote',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: body,
    });
    await app.close();
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

describe('GET /v1/deposit/transfer/:id', () => {
  const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const SOL_DEPOSIT = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
  const tokens: OneClickToken[] = [
    ...TOKENS,
    { assetId: 'nep141:base.omft.near', decimals: 18, blockchain: 'base', symbol: 'ETH' },
    {
      assetId: `nep141:base-${BASE_USDC}.omft.near`,
      decimals: 6,
      blockchain: 'base',
      symbol: 'USDC',
      contractAddress: BASE_USDC,
    },
    { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL' },
    {
      assetId: 'nep141:sol-5ce3bf3a.omft.near',
      decimals: 6,
      blockchain: 'sol',
      symbol: 'USDC',
      contractAddress: SOL_USDC,
    },
  ];
  const stored = (over: Partial<StoredDepositQuote & { status: string | null }> = {}) => ({
    id: 'dq_1',
    createdAt: NOW,
    accountId: 'alice.near',
    originAsset: `nep141:base-${BASE_USDC}.omft.near`,
    destinationAsset: `nep141:${USDC_NEAR_ID}`,
    amountIn: '1000000',
    amountOut: '999000',
    minAmountOut: '989000',
    refundTo: REFUND,
    depositAddress: DEPOSIT,
    deadline: new Date('2026-11-13T10:10:00Z'),
    correlationId: 'c0ffee',
    signature: 'ed25519:sig',
    feeBps: 1,
    status: null as string | null,
    ...over,
  });
  const live = (status: SwapStatus) => async () => ({
    status,
    depositedAmount: null,
    amountOut: null,
    refundedAmount: null,
    refundReason: null,
    nearTxHash: null,
  });
  const get = (
    row: ReturnType<typeof stored> | null,
    id = 'dq_1',
    status: DepositDeps['oneClick']['status'] = live('PENDING_DEPOSIT'),
  ) => {
    const { app } = setup({ tokens, find: async () => row, status });
    return app.inject({
      method: 'GET',
      url: `/v1/deposit/transfer/${id}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
  };

  it('builds an ERC-20 transfer of exactly the stored amount to the stored deposit address', async () => {
    const res = await get(stored());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      quoteId: 'dq_1',
      chain: 'base',
      receiver: DEPOSIT,
      amount: '1000000',
      token: {
        assetId: `nep141:base-${BASE_USDC}.omft.near`,
        blockchain: 'base',
        symbol: 'USDC',
        decimals: 6,
        contractAddress: BASE_USDC,
      },
    });
  });

  it('builds a native EVM transfer with no contract', async () => {
    const res = await get(stored({ originAsset: 'nep141:base.omft.near', amountIn: '10' }));
    expect(res.json()).toMatchObject({
      chain: 'base',
      amount: '10',
      token: { symbol: 'ETH', decimals: 18, contractAddress: null },
    });
  });

  it('builds native SOL and SPL transfers to a Solana deposit address', async () => {
    const sol = await get(
      stored({ originAsset: 'nep141:sol.omft.near', depositAddress: SOL_DEPOSIT }),
    );
    expect(sol.json()).toMatchObject({
      chain: 'sol',
      receiver: SOL_DEPOSIT,
      token: { symbol: 'SOL', contractAddress: null },
    });
    const spl = await get(
      stored({ originAsset: 'nep141:sol-5ce3bf3a.omft.near', depositAddress: SOL_DEPOSIT }),
    );
    expect(spl.json()).toMatchObject({ chain: 'sol', token: { contractAddress: SOL_USDC } });
  });

  it('refuses an unknown quote, a past deadline, a quote already paid, Bitcoin and a bad deposit address', async () => {
    expect((await get(null)).statusCode).toBe(404);
    expect((await get(stored(), 'bad.id')).statusCode).toBe(400);
    for (const row of [
      stored({ deadline: new Date('2026-11-13T09:59:59Z') }),
      stored({ status: 'KNOWN_DEPOSIT_TX' }),
      stored({ status: 'SUCCESS' }),
      stored({
        originAsset: 'nep141:btc.omft.near',
        depositAddress: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      }),
      stored({ depositAddress: SOL_DEPOSIT }),
      stored({ originAsset: 'nep141:zzz.omft.near' }),
    ]) {
      const res = await get(row);
      expect(res.statusCode).toBe(409);
      expect(typeof res.json<{ error: unknown }>().error).toBe('string');
    }
  });

  it('refuses when 1Click already sees a deposit, though ours still says unpaid (a retry after a send)', async () => {
    for (const s of ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'INCOMPLETE_DEPOSIT', 'UNKNOWN'] as const)
      expect((await get(stored(), 'dq_1', live(s))).statusCode).toBe(409);
  });

  it('refuses when 1Click status cannot be read, or less than 2 minutes are left', async () => {
    const down = async (): Promise<never> => {
      throw new Error('1Click down');
    };
    expect((await get(stored(), 'dq_1', down)).statusCode).toBe(502);
    const late = stored({ deadline: new Date(NOW.getTime() + 119_000) });
    expect((await get(late)).statusCode).toBe(409);
    expect((await get(stored({ deadline: new Date(NOW.getTime() + 121_000) }))).statusCode).toBe(
      200,
    );
  });
});
