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
      },
      {
        tool: 'capital_allocator',
        agent: 'Capital Allocator',
        ok: false,
        text: 'Failed',
        provenance: null,
      },
    ];
    reply({ ...base, calledTools: ['liquidation_guardian', 'capital_allocator'], trace });
    const r = await runAnalysis('alice.near');
    expect(r).toEqual({
      ok: true,
      analysis: { ...base, calledTools: ['liquidation_guardian', 'capital_allocator'], trace },
    });
  });

  it('accepts an older reply without them', async () => {
    reply(base);
    expect(await runAnalysis('alice.near')).toEqual({
      ok: true,
      analysis: { ...base, calledTools: [], trace: [] },
    });
  });

  it('rejects a provenance tier it does not know', async () => {
    reply({
      ...base,
      trace: [{ tool: 'x', agent: 'X', ok: true, text: 'y', provenance: 'trust_me' }],
    });
    expect((await runAnalysis('alice.near')).ok).toBe(false);
  });
});
