import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis } from '../lib/analysis-client';

const reply = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
const base = { source: 'llm', note: null, recommendations: [] };

describe('runAnalysis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the trace and the called tools', async () => {
    const trace = [
      {
        tool: 'liquidation_guardian',
        agent: 'Liquidation Guardian',
        ok: true,
        text: 'Health factor 1.37 → 1.60 after repaying 33.125 USDt',
        provenance: 'calculated_estimate',
        pick: 'ranked',
        rank: 1,
      },
      {
        tool: 'capital_allocator',
        agent: 'Capital Allocator',
        ok: false,
        text: 'Failed',
        provenance: null,
        pick: null,
        rank: null,
      },
    ];
    const run = {
      model: 'claude-haiku-5-5',
      turns: 2,
      toolCalls: 5,
      ms: 6200,
      read: { tokens: 7, loan: true },
      checks: { picked: 2, explained: 2, replaced: 0, restored: 1, dropped: 0 },
    };
    reply({ ...base, calledTools: ['liquidation_guardian', 'capital_allocator'], trace, run });
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r).toEqual({
      ok: true,
      analysis: { ...base, calledTools: ['liquidation_guardian', 'capital_allocator'], trace, run },
    });
  });

  it('accepts an older reply without them', async () => {
    reply(base);
    expect(await runAnalysis('alice.near', 'balanced')).toEqual({
      ok: true,
      analysis: { ...base, calledTools: [], trace: [], run: null },
    });
  });

  it('drops a provenance tier it does not know but keeps the analysis', async () => {
    reply({
      ...base,
      trace: [{ tool: 'x', agent: 'X', ok: true, text: 'y', provenance: 'trust_me' }],
    });
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r.ok && r.analysis.trace).toEqual([
      { tool: 'x', agent: 'X', ok: true, text: 'y', provenance: null, pick: null, rank: null },
    ]);
  });
});
