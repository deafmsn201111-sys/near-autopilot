import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '@near-autopilot/orchestrator';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';

const TOKEN = 'agents-token-agents-token-agents-token-1';
const auth = { authorization: `Bearer ${TOKEN}` };
// The roster endpoint reads only the static descriptors, never the store.
const store = {} as unknown as CollectorStore;

describe('/v1/analytics/agents', () => {
  it('returns the agent roster: identity, version and permissions for every agent', async () => {
    const app = buildAnalyticsServer({ apiToken: TOKEN, store, intervalSeconds: 900 });
    const res = await app.inject({ url: '/v1/analytics/agents', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      agents: {
        id: string;
        title: string;
        version: string;
        proposalKinds: string[];
        advisoryOnly: boolean;
      }[];
    }>();
    expect(body.agents.map((a) => a.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const a of body.agents) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(a.proposalKinds.length).toBeGreaterThan(0);
    }
    const portfolio = body.agents.find((a) => a.id === 'portfolio-intelligence');
    expect(portfolio?.advisoryOnly).toBe(true);
    expect(portfolio?.proposalKinds).toContain('portfolio.signal');
    await app.close();
  });

  it('needs the token', async () => {
    const app = buildAnalyticsServer({ apiToken: TOKEN, store, intervalSeconds: 900 });
    expect((await app.inject({ url: '/v1/analytics/agents' })).statusCode).toBe(401);
    await app.close();
  });
});
