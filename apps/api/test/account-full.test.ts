import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { AccountDiscovery } from '../src/analytics/discovery';
import type { CollectorStore } from '../src/collector/store';

/** Mainnet reads for npro-validator.near, recorded 13 Nov (block ~224290651). */
const ACCOUNT = 'npro-validator.near';
const NPRO = 'npro.nearmobile.near';
const WNEAR = 'wrap.near';
const STAKING_POOL = 'npro.poolv1.near';
const NEAR_USD = 3.41;
const NPRO_USD = 0.2340556959;

const TOKEN = 'account-full-token-account-full-token-acc1';
const headers = { authorization: `Bearer ${TOKEN}` };

const pool6724 = {
  pool_kind: 'SIMPLE_POOL',
  token_account_ids: [NPRO, WNEAR],
  amounts: ['741725189376942668472790846034', '51058782780270506267592023687'],
  total_fee: 30,
  shares_total_supply: '7288694929996948835964691',
  amp: 0,
};

const node = (lpShares: string) => {
  const views: Record<string, unknown> = {
    'contract.main.burrow.near#get_assets_paged_detailed': [],
    'contract.main.burrow.near#get_account': null,
    [`${STAKING_POOL}#get_account_staked_balance`]: '1021690589012292594002053483',
    [`${STAKING_POOL}#get_account_unstaked_balance`]: '915539688072695697139549259',
    'v2.ref-finance.near#get_pool_shares': lpShares,
    'v2.ref-finance.near#get_pool': pool6724,
    [`${NPRO}#ft_metadata`]: { spec: 'ft-1.0.0', name: 'NPRO', symbol: 'NPRO', decimals: 24 },
    'spam.near#ft_metadata': {
      spec: 'ft-1.0.0',
      name: 'x',
      symbol: '<b>CLAIM</b> at scam.io',
      decimals: 18,
    },
  };
  const calls: string[] = [];
  const rpc = {
    calls,
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'status') return { chain_id: 'mainnet' };
      if (params['request_type'] === 'view_account')
        return { amount: '501966012054771138009892', locked: '0', storage_usage: 412 };
      const key = `${String(params['account_id'])}#${String(params['method_name'])}`;
      calls.push(key);
      if (!(key in views)) throw new Error(`no view ${key}`);
      return { result: [...Buffer.from(JSON.stringify(views[key]))] };
    },
  };
  return rpc;
};

const discovery: AccountDiscovery = {
  account: async () => ({
    tokens: [
      { token: WNEAR, raw: 413417671877902700000000000n },
      { token: NPRO, raw: 124901319333664073555410745800n },
      { token: 'spam.near', raw: 10n ** 24n },
    ],
    stakingPools: [STAKING_POOL],
  }),
  v1PoolIds: async () => [6724],
  // the indexer's wNEAR price must never override the confirmed one
  prices: async () =>
    new Map([
      [NPRO, NPRO_USD],
      [WNEAR, 99],
    ]),
  dclVolumes24hUsd: async () => null,
};

const store = {
  latestSnapshot: async () => ({
    id: 'snap-1',
    takenAt: new Date(),
    summary: { prices: [{ token: WNEAR, usd: String(NEAR_USD), quality: 'OK' }] },
  }),
  pricesForSnapshot: async () => [],
  tokenMetadata: async () => [{ token: WNEAR, symbol: 'wNEAR', decimals: 24 }],
  markets: async () => [],
} as unknown as CollectorStore;

const read = async (lpShares: string, withDiscovery: AccountDiscovery | null = discovery) => {
  const rpc = node(lpShares);
  const app = buildAnalyticsServer({
    apiToken: TOKEN,
    store,
    intervalSeconds: 900,
    mainnet: {
      rpc: rpc as unknown as NearRpcClient,
      burrowId: 'contract.main.burrow.near',
      rheaId: 'v2.ref-finance.near',
      pools: [],
      discovery: withDiscovery,
    } as never,
  });
  const res = await app.inject({ method: 'GET', url: `/v1/analytics/account/${ACCOUNT}`, headers });
  expect(res.statusCode).toBe(200);
  return { body: res.json<Body>(), calls: rpc.calls };
};

interface Row {
  key?: string;
  where?: string;
  token?: string;
  usd: number | null;
  verified: boolean;
  estimate: boolean;
  small: boolean;
  symbol?: string;
  label?: string;
}
interface Body {
  totals: { assetsUsd: number };
  holdings: (Row & { token: string })[];
  positions: Row[];
  metrics: { concentration: { token: string } | null };
  recommendations: unknown[];
  actions: unknown[];
  discovery: { complete: boolean };
}

describe('GET /v1/analytics/account/:id reads the whole account', () => {
  it('values npro-validator.near: LP in an unlisted pool, unlisted tokens and native staking', async () => {
    const { body } = await read('6253046288164419544382378');
    const share = Number('6253046288164419544382378') / Number('7288694929996948835964691');
    const lp = 741725.18937 * share * NPRO_USD + 51058.78278 * share * NEAR_USD;
    const wallet = 413.41767 * NEAR_USD + 124901.31933 * NPRO_USD + 0.50196 * NEAR_USD;
    const staking = (1021.69058 + 915.53968) * NEAR_USD;
    expect(body.totals.assetsUsd).toBeCloseTo(lp + wallet + staking, -1);

    const rows: Row[] = [...body.holdings, ...body.positions];
    const byKey = (k: string) => rows.find((r) => (r.key ?? `${r.where}-${r.token}`) === k);
    expect(byKey(`wallet-${NPRO}`)).toMatchObject({
      verified: false,
      estimate: true,
      small: false,
    });
    expect(byKey(`wallet-${WNEAR}`)).toMatchObject({ verified: true, estimate: false });
    expect(byKey('v1-6724')).toMatchObject({
      label: 'NPRO/wNEAR',
      verified: false,
      estimate: true,
    });
    expect(byKey(`staked-${STAKING_POOL}`)?.usd).toBeCloseTo(1021.690589 * NEAR_USD, 0);
    expect(byKey(`unstaked-${STAKING_POOL}`)?.usd).toBeCloseTo(915.539688 * NEAR_USD, 0);
  });

  it('sanitises an unlisted symbol, keeps an unpriced unlisted token out of the totals and hides it as small', async () => {
    const { body } = await read('0');
    const spam = body.holdings.find((h) => h.token === 'spam.near');
    expect(spam).toMatchObject({ symbol: 'bCLAIMbatsca', usd: null, verified: false, small: true });
    expect(JSON.stringify(body.metrics)).not.toContain('spam.near');
  });

  it('never offers an action on an unlisted token, even when it dominates the portfolio', async () => {
    const { body } = await read('0');
    expect(body.metrics.concentration?.token).toBe(NPRO);
    expect(JSON.stringify(body.recommendations)).not.toContain(NPRO);
    expect(JSON.stringify(body.actions)).not.toContain(NPRO);
  });

  it('falls back to the allowlists and says so when the indexers are down', async () => {
    const down: AccountDiscovery = {
      account: async () => null,
      v1PoolIds: async () => null,
      prices: async () => null,
      dclVolumes24hUsd: async () => null,
    };
    const { body } = await read('6253046288164419544382378', down);
    expect(body.discovery).toEqual({ complete: false });
    expect(body.holdings.map((h) => h.token)).toEqual(['near']);
  });

  it('keeps the per-read call count bounded', async () => {
    const { calls } = await read('6253046288164419544382378');
    expect(calls.length).toBeLessThan(20);
  });
});

describe('GET /v1/analytics/account/:id?fresh=1 after a transaction', () => {
  afterEach(() => vi.useRealTimers());

  const app = () => {
    const rpc = node('6253046288164419544382378');
    const server = buildAnalyticsServer({
      apiToken: TOKEN,
      store,
      intervalSeconds: 900,
      mainnet: {
        rpc: rpc as unknown as NearRpcClient,
        burrowId: 'contract.main.burrow.near',
        rheaId: 'v2.ref-finance.near',
        pools: [],
        discovery,
      } as never,
    });
    const get = async (query = '') => {
      const before = rpc.calls.length;
      const res = await server.inject({
        method: 'GET',
        url: `/v1/analytics/account/${ACCOUNT}${query}`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      return rpc.calls.length > before;
    };
    return get;
  };

  it('replaces the cached read, at most once per account every 5 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const get = app();
    expect(await get()).toBe(true);
    expect(await get()).toBe(false);
    expect(await get('?fresh=1')).toBe(true);
    expect(await get('?fresh=1')).toBe(false);
    vi.advanceTimersByTime(5_000);
    expect(await get('?fresh=1')).toBe(true);
    expect(await get()).toBe(false);
  });
});
