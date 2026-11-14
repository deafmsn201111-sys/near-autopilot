import { describe, expect, it } from 'vitest';
import {
  spendSummary,
  type AdminStore,
  type LlmSettings,
  type QualityStats,
  type SettingsPatch,
  type SpendRow,
} from '../src/analytics/admin';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const NOW = new Date('2026-11-12T10:00:00Z');
const DEFAULTS: LlmSettings = {
  dailyCapMicroUsd: null,
  llmEnabled: true,
  depositMicroUsd: null,
  depositSetAt: null,
};
const row = (at: string, costMicroUsd: bigint, model = 'claude-haiku-5-5'): SpendRow => ({
  at: new Date(at),
  model,
  costMicroUsd,
});

describe('spendSummary', () => {
  const rows = [
    row('2026-11-12T09:00:00Z', 1_000_000n),
    row('2026-11-12T01:00:00Z', 500_000n, 'claude-sonnet-5-5'),
    row('2026-11-10T12:00:00Z', 2_000_000n),
    row('2026-11-06T00:00:00Z', 3_500_000n),
    row('2026-11-05T23:59:59Z', 9_000_000n),
  ];

  it('sums today against the default cap, and the last 7 UTC days by day, oldest first', () => {
    const s = spendSummary(rows, DEFAULTS, 5_000_000n, NOW);
    expect(s.todayUsd).toBe(1.5);
    expect(s.capUsd).toBe(5);
    expect(s.capIsDefault).toBe(true);
    expect(s.days).toEqual([
      { day: '2026-11-06', usd: 3.5 },
      { day: '2026-11-07', usd: 0 },
      { day: '2026-11-08', usd: 0 },
      { day: '2026-11-09', usd: 0 },
      { day: '2026-11-10', usd: 2 },
      { day: '2026-11-11', usd: 0 },
      { day: '2026-11-12', usd: 1.5 },
    ]);
  });

  it('splits the 7 days by model and averages the cost per analysis', () => {
    const s = spendSummary(rows, DEFAULTS, 5_000_000n, NOW);
    expect(s.models).toEqual([
      { model: 'claude-haiku-5-5', analyses: 3, usd: 6.5 },
      { model: 'claude-sonnet-5-5', analyses: 1, usd: 0.5 },
    ]);
    expect(s.avgPerAnalysisUsd).toBe(1.75);
    expect(s.dailyAvgUsd).toBe(1);
  });

  it('uses the stored cap over the default', () => {
    const s = spendSummary(rows, { ...DEFAULTS, dailyCapMicroUsd: 2_000_000n }, 5_000_000n, NOW);
    expect(s.capUsd).toBe(2);
    expect(s.capIsDefault).toBe(false);
  });

  it('forecasts the run-out date from the deposit minus spend since it was entered, over the daily average', () => {
    const s = spendSummary(
      rows,
      { ...DEFAULTS, depositMicroUsd: 10_000_000n, depositSetAt: new Date('2026-11-10T00:00:00Z') },
      5_000_000n,
      NOW,
    );
    expect(s.deposit).toEqual({
      balanceUsd: 10,
      enteredAt: '2026-11-10T00:00:00.000Z',
      enteredDaysAgo: 2,
      spentSinceUsd: 3.5,
      leftUsd: 6.5,
      runOutDate: '2026-11-18',
    });
  });

  it('gives no run-out date without spend, and today once the deposit is spent', () => {
    const deposit = { ...DEFAULTS, depositMicroUsd: 1_000_000n, depositSetAt: NOW };
    expect(spendSummary([], deposit, 5_000_000n, NOW).deposit?.runOutDate).toBeNull();
    const spent = { ...deposit, depositSetAt: new Date('2026-11-01T00:00:00Z') };
    expect(spendSummary(rows, spent, 5_000_000n, NOW).deposit?.runOutDate).toBe('2026-11-12');
    expect(spendSummary(rows, DEFAULTS, 5_000_000n, NOW).deposit).toBeNull();
  });

  it('averages over the days since the first call on a new server', () => {
    const s = spendSummary([row('2026-11-12T09:00:00Z', 2_000_000n)], DEFAULTS, 5_000_000n, NOW);
    expect(s.dailyAvgUsd).toBe(2);
  });

  it('has no average with no analyses', () => {
    expect(spendSummary([], DEFAULTS, 5_000_000n, NOW).avgPerAnalysisUsd).toBeNull();
  });
});

const NO_RUNS: QualityStats = { outcomes: [], p50Ms: null, p95Ms: null, kinds: [], last: [] };

const API_TOKEN = 'public-token-public-token-public-token-1';
const ADMIN_TOKEN = 'admin-token-admin-token-admin-token-admin-1';

function fakeStore() {
  const state = { settings: { ...DEFAULTS }, patches: [] as SettingsPatch[] };
  const store: AdminStore = {
    settings: async () => state.settings,
    recentCalls: async () => [row('2026-11-12T09:00:00Z', 250_000n)],
    quality: async () => NO_RUNS,
    saveSettings: async (patch) => {
      state.patches.push(patch);
      state.settings = { ...state.settings, ...patch };
    },
  };
  return { state, store };
}

const server = (store: AdminStore, adminToken: string | undefined = ADMIN_TOKEN) =>
  buildAnalyticsServer({
    apiToken: API_TOKEN,
    store: {} as CollectorStore,
    intervalSeconds: 900,
    now: () => NOW,
    ...(adminToken ? { admin: { token: adminToken, store, defaultCapMicro: 5_000_000n } } : {}),
  });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

describe('/v1/admin', () => {
  it('reads calls back to the deposit entry when it is older than the 7-day window', async () => {
    const since: Date[] = [];
    const store: AdminStore = {
      settings: async () => ({
        ...DEFAULTS,
        depositMicroUsd: 10_000_000n,
        depositSetAt: new Date('2026-11-05T22:00:00Z'),
      }),
      recentCalls: async (s) => (
        since.push(s),
        [row('2026-11-05T23:00:00Z', 5_000_000n), row('2026-11-12T09:00:00Z', 1_000_000n)]
      ),
      quality: async () => NO_RUNS,
      saveSettings: async () => {},
    };
    const res = await server(store).inject({
      url: '/v1/admin/spend',
      headers: bearer(ADMIN_TOKEN),
    });
    expect(since).toEqual([new Date('2026-11-05T22:00:00Z')]);
    expect(res.json()).toMatchObject({ deposit: { spentSinceUsd: 6, leftUsd: 4 }, todayUsd: 1 });
  });

  it('rejects the public API token and accepts only the admin token', async () => {
    const app = server(fakeStore().store);
    const pub = await app.inject({ url: '/v1/admin/spend', headers: bearer(API_TOKEN) });
    expect(pub.statusCode).toBe(401);
    const none = await app.inject({ url: '/v1/admin/spend' });
    expect(none.statusCode).toBe(401);
    const ok = await app.inject({ url: '/v1/admin/spend', headers: bearer(ADMIN_TOKEN) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ todayUsd: 0.25, capUsd: 5, llmEnabled: true });
  });

  it.each(['/%761/admin/spend', '/v1/%61dmin/spend', '/v1//admin/spend', '/V1/admin/spend'])(
    'never serves %s without the admin token',
    async (url) => {
      const app = server(fakeStore().store);
      for (const headers of [{}, bearer(API_TOKEN)]) {
        const res = await app.inject({ url, headers });
        expect(res.statusCode === 401 || res.statusCode === 404).toBe(true);
        expect(res.body).not.toContain('todayUsd');
      }
    },
  );

  it('asks for the API token on an encoded /v1 path', async () => {
    const res = await server(fakeStore().store).inject({ url: '/%761/analytics/freshness' });
    expect(res.statusCode).toBe(401);
  });

  it('does not let the admin token into the other routes', async () => {
    const app = server(fakeStore().store);
    const res = await app.inject({ url: '/v1/analytics/freshness', headers: bearer(ADMIN_TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 on every admin route when no admin token is configured', async () => {
    const app = server(fakeStore().store, '');
    const res = await app.inject({ url: '/v1/admin/spend', headers: bearer(API_TOKEN) });
    expect(res.statusCode).toBe(401);
  });

  it('turns the LLM off, sets the cap and the deposit', async () => {
    const { state, store } = fakeStore();
    const app = server(store);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/settings',
      headers: bearer(ADMIN_TOKEN),
      payload: { llmEnabled: false, dailyCapUsd: 2.5, depositUsd: 40 },
    });
    expect(res.statusCode).toBe(200);
    expect(state.patches).toEqual([
      {
        llmEnabled: false,
        dailyCapMicroUsd: 2_500_000n,
        depositMicroUsd: 40_000_000n,
        depositSetAt: NOW,
      },
    ]);
    expect(res.json()).toMatchObject({ llmEnabled: false, capUsd: 2.5 });
  });

  it.each([
    { dailyCapUsd: 0 },
    { dailyCapUsd: -1 },
    { dailyCapUsd: 1001 },
    { depositUsd: 0 },
    { depositUsd: 1e-7 },
    { dailyCapUsd: 1e-7 },
    { depositUsd: 1_000_001 },
    { llmEnabled: 'no' },
    { extra: 1 },
    {},
  ])('rejects %o', async (payload) => {
    const { state, store } = fakeStore();
    const res = await server(store).inject({
      method: 'POST',
      url: '/v1/admin/settings',
      headers: bearer(ADMIN_TOKEN),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(state.patches).toEqual([]);
  });
});

describe('/v1/admin/funnel and /v1/admin/llm', () => {
  const app = () =>
    buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => NOW,
      admin: {
        token: ADMIN_TOKEN,
        store: {
          ...fakeStore().store,
          quality: async () => ({
            ...NO_RUNS,
            outcomes: [{ outcome: 'ok', count: 1 }],
            last: [
              {
                at: NOW,
                accountId: 'alice.near',
                model: 'claude-haiku-5-5',
                latencyMs: 1000,
                tools: [],
                outcome: 'ok',
                input: null,
                output: null,
              },
            ],
          }),
        },
        defaultCapMicro: 5_000_000n,
        events: {
          funnel: async () => [
            { day: '2026-11-12', kind: 'connect', events: 1, accounts: 1 },
            { day: null, kind: 'connect', events: 1, accounts: 1 },
            { day: null, kind: null, events: 1, accounts: 1 },
          ],
        },
      },
    });

  it.each(['/v1/admin/funnel', '/v1/admin/llm'])('%s accepts only the admin token', async (url) => {
    const a = app();
    expect((await a.inject({ url })).statusCode).toBe(401);
    expect((await a.inject({ url, headers: bearer(API_TOKEN) })).statusCode).toBe(401);
    expect((await a.inject({ url, headers: bearer(ADMIN_TOKEN) })).statusCode).toBe(200);
  });

  it('serves the funnel and the LLM quality', async () => {
    const a = app();
    const funnel = await a.inject({ url: '/v1/admin/funnel', headers: bearer(ADMIN_TOKEN) });
    expect(funnel.json()).toMatchObject({ total: { connect: 1, accounts: 1 } });
    const llm = await a.inject({ url: '/v1/admin/llm', headers: bearer(ADMIN_TOKEN) });
    expect(llm.json()).toMatchObject({ calls: 1, last: [{ outcome: 'ok' }] });
  });
});
