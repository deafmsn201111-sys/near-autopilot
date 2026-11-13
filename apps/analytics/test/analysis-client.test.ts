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

describe('runAnalysis as a stream', () => {
  afterEach(() => vi.unstubAllGlobals());

  const step = {
    tool: 'liquidation_guardian',
    agent: 'Liquidation Guardian',
    ok: true,
    text: 'Health factor 1.37 → 1.60 after repaying 33.125 USDt',
    provenance: 'calculated_estimate',
    pick: null,
    rank: null,
  };
  const checks = { picked: 1, explained: 1, replaced: 0, restored: 0, dropped: 0 };
  const done = { ...base, trace: [{ ...step, pick: 'ranked', rank: 1 }], calledTools: [] };
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  /** The stream cut at arbitrary points, as the network delivers it. */
  const stream = (text: string, cut = 7) =>
    new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < text.length; i += cut)
            c.enqueue(new TextEncoder().encode(text.slice(i, i + cut)));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const serve = (...replies: Response[]) => {
    const fetch = vi.fn(async () => replies.shift()!);
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('builds the pipeline from each event as it arrives and ends with the done analysis', async () => {
    serve(
      stream(
        frame('read', { model: 'claude-haiku-5-5', tokens: 7, loan: true }) +
          frame('agent', { step }) +
          frame('ranked', { turns: 2 }) +
          frame('checked', { checks }) +
          frame('done', done),
      ),
    );
    const seen: unknown[] = [];
    const r = await runAnalysis('alice.near', 'balanced', (p) => seen.push(p));
    expect(r).toMatchObject({ ok: true, analysis: { source: 'llm', trace: done.trace } });
    expect(seen).toEqual([
      {
        model: 'claude-haiku-5-5',
        read: { tokens: 7, loan: true },
        trace: [],
        turns: null,
        checks: null,
      },
      {
        model: 'claude-haiku-5-5',
        read: { tokens: 7, loan: true },
        trace: [step],
        turns: null,
        checks: null,
      },
      {
        model: 'claude-haiku-5-5',
        read: { tokens: 7, loan: true },
        trace: [step],
        turns: 2,
        checks: null,
      },
      {
        model: 'claude-haiku-5-5',
        read: { tokens: 7, loan: true },
        trace: [step],
        turns: 2,
        checks,
      },
    ]);
  });

  it('ignores an unknown or malformed event', async () => {
    serve(
      stream(
        frame('thinking', { secret: 'x' }) +
          frame('agent', { step: { tool: 1 } }) +
          'event: ranked\ndata: {not json\n\n' +
          frame('done', done),
      ),
    );
    const seen: unknown[] = [];
    const r = await runAnalysis('alice.near', 'balanced', (p) => seen.push(p));
    expect(r.ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it('asks for the plain JSON reply when the stream breaks before done', async () => {
    const fetch = serve(
      stream(
        frame('read', { model: 'm', tokens: 1, loan: false }) + frame('error', { error: 'x' }),
      ),
      new Response(JSON.stringify(done), { status: 200 }),
    );
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r).toMatchObject({ ok: true, analysis: { source: 'llm' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
