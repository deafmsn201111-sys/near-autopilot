import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import type { EvidenceStore } from '../src/evidence/store';

const TOKEN = 'analytics-token-analytics-token-analytics';
const auth = { authorization: `Bearer ${TOKEN}` };
const at = new Date('2026-11-06T10:00:00Z');

const verdict = (
  id: string,
  verdict: string,
  dataSource: string,
  network: string,
  runId: string,
) => ({
  id,
  evaluatedAt: at,
  engine: 'legacy',
  runId,
  intentId: `i-${id}`,
  intentKind: 'lending.repay',
  verdict,
  outcome: verdict === 'ALLOW' ? 'approve' : 'reject',
  policyVersion: 'rules-2026.11.1+cfg:0123456789abcdef',
  snapshotId: 'sha256:x',
  planHash: 'h',
  valueUsdMicro: '40000000',
  checks: [],
  violations: [],
  input: {
    intent: { kind: 'lending.repay', token: 'usdt.fakes.testnet', amount: '40000000' },
    config: {},
  },
  dataSource,
  network,
});

const evidence = {
  verdicts: async () => [
    verdict('v1', 'ALLOW', 'simulation', 'testnet', 'run-1'),
    verdict('v2', 'BLOCK', 'simulation', 'mainnet', 'demo-attack:2026'),
  ],
  chains: async () => ({
    chains: [{ chain: 'simulation:mainnet', entries: 2, firstAt: at, lastAt: at }],
    unchained: 7,
  }),
  verify: async (chain: string) => ({
    chain,
    ok: true as const,
    entries: 2,
    head: { seq: 2, hash: 'f'.repeat(64) },
  }),
  latest: async () => [
    {
      seq: 2,
      at,
      type: 'proposal_dry_run',
      runId: 'r',
      proposalId: null,
      payload: { big: 10n ** 30n },
      prevHash: 'a'.repeat(64),
      hash: 'f'.repeat(64),
    },
  ],
  routes: async () => [
    {
      id: 'route-1',
      createdAt: at,
      origin: 'probe',
      outcome: 'routed',
      decisionId: null,
      intentId: null,
      planHash: null,
      tokenIn: 'wrap.near',
      tokenOut: 'usdc.near',
      amountIn: '1',
      chosenVenue: 'rhea',
      advantageBps: 5,
      reason: 'rhea nets 5 bps more',
      quotes: { scored: [] },
      dataSource: 'simulation',
      network: 'mainnet',
    },
  ],
} as unknown as EvidenceStore;

const app = () =>
  buildAnalyticsServer({
    apiToken: TOKEN,
    store: {} as unknown as CollectorStore,
    evidence,
    intervalSeconds: 900,
  });

describe('analytics evidence endpoints (read-only)', () => {
  it('require the token', async () => {
    for (const url of [
      '/v1/analytics/policy/verdicts',
      '/v1/analytics/audit',
      '/v1/analytics/routes',
      '/v1/analytics/thesis',
      '/v1/analytics/policy/attacks',
    ])
      expect((await app().inject({ url })).statusCode, url).toBe(401);
  });

  it('verdicts carry their environment, a fixture flag, the intent, never the full input', async () => {
    const r = (await app().inject({ url: '/v1/analytics/policy/verdicts', headers: auth })).json<{
      verdicts: Array<Record<string, unknown>>;
    }>();
    expect(r.verdicts.map((v) => [v.id, v.environment, v.fixture])).toEqual([
      ['v1', 'simulation:testnet', false],
      ['v2', 'simulation:mainnet', true],
    ]);
    expect(r.verdicts[0]).toMatchObject({ intent: { kind: 'lending.repay' }, configStored: true });
    expect(r.verdicts[0]).not.toHaveProperty('input');
    const blocked = (
      await app().inject({ url: '/v1/analytics/policy/verdicts?verdict=BLOCK', headers: auth })
    ).json<{
      verdicts: unknown[];
    }>();
    expect(blocked.verdicts).toHaveLength(1);
  });

  it('the attack log is the committed file, labelled as fixtures', async () => {
    const r = (await app().inject({ url: '/v1/analytics/policy/attacks', headers: auth })).json<{
      label: string;
      entries: unknown[];
    }>();
    const lines = readFileSync(
      new URL('../../../docs/evidence/demo-attack.log.jsonl', import.meta.url),
      'utf8',
    )
      .trim()
      .split('\n');
    expect(r.entries).toHaveLength(lines.length);
    expect(r.label).toMatch(/^FIXTURE/);
  });

  it('audit: every chain with its verification; entries JSON-safe', async () => {
    const r = (await app().inject({ url: '/v1/analytics/audit', headers: auth })).json<{
      chains: Array<{ verification: { ok: boolean } }>;
      unchainedRowsBeforeMigration0011: number;
      entries: Array<{ payload: { big: string } }>;
    }>();
    expect(r.chains[0]?.verification.ok).toBe(true);
    expect(r.unchainedRowsBeforeMigration0011).toBe(7);
    expect(r.entries[0]?.payload.big).toBe(String(10n ** 30n));
  });

  it('routes are never marked executed', async () => {
    const r = (await app().inject({ url: '/v1/analytics/routes', headers: auth })).json<{
      routes: Array<Record<string, unknown>>;
    }>();
    expect(r.routes[0]).toMatchObject({
      executed: false,
      environment: 'simulation:mainnet',
      chosenVenue: 'rhea',
    });
  });

  it('thesis: the same verdict as THESIS.md, from the committed raw data', async () => {
    const r = (await app().inject({ url: '/v1/analytics/thesis', headers: auth })).json<{
      available: boolean;
      verdict: { text: string };
      pools: unknown[];
    }>();
    expect(r.available).toBe(true);
    const md = readFileSync(new URL('../../../THESIS.md', import.meta.url), 'utf8');
    expect(md).toContain(`**Verdict: ${r.verdict.text}.**`);
    expect(r.pools.length).toBeGreaterThan(0);
  });
});
