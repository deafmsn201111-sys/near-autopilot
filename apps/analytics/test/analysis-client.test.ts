import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSaved,
  pipelineOf,
  privacyMark,
  runAnalysis,
  type Pipeline,
} from '../lib/analysis-client';

const reply = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
const base = { source: 'llm', note: null, recommendations: [] };

describe('runAnalysis', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a repay-with-collateral card and its plan', async () => {
    const card = {
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: 'warning',
      title: "Your loan's health factor is 1.37",
      why: 'Three transactions.',
      intent: {
        action: 'repay_with_collateral',
        token: 'usdc',
        collateralToken: 'wrap.near',
        approxUsd: 56,
        amount: '19000000000000000000000000',
        maxSlippageBps: 50,
        plan: {
          hfNow: 1.37,
          hfAfterWithdraw: 1.37,
          hfAfterRepay: null,
          floorHf: 1.15,
          transactions: 2,
        },
      },
    };
    reply({ ...base, recommendations: [card] });
    const out = await runAnalysis('alice.near', 'balanced');
    if (!out.ok) throw new Error(out.error);
    expect(out.analysis.recommendations[0]?.intent).toEqual(card.intent);
  });

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
      model: 'z-ai/glm-5.3-flash',
      turns: 2,
      toolCalls: 5,
      ms: 6200,
      read: { tokens: 7, loan: true },
      checks: { picked: 2, explained: 2, replaced: 0, restored: 1, dropped: 0 },
      ranking: 'The loan comes first: its health factor is 1.37.',
      privacy: { verified: true, reason: null, chatIds: ['c1', 'c2'] },
    };
    reply({ ...base, calledTools: ['liquidation_guardian', 'capital_allocator'], trace, run });
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r).toEqual({
      ok: true,
      analysis: {
        ...base,
        calledTools: ['liquidation_guardian', 'capital_allocator'],
        trace,
        run,
        read: null,
        cachedAt: null,
      },
    });
    expect(r.ok && pipelineOf(r.analysis).ranking).toBe(run.ranking);
    expect(r.ok && pipelineOf(r.analysis).privacy).toEqual(run.privacy);
  });

  it('reads a run saved before the TEE check as not checked', async () => {
    const { privacy: _, ...old } = {
      model: 'z-ai/glm-5.3-flash',
      turns: 1,
      toolCalls: 1,
      ms: 1,
      read: { tokens: 1, loan: false },
      checks: { picked: 1, explained: 1, replaced: 0, restored: 0, dropped: 0 },
      ranking: null,
      privacy: null,
    };
    reply({ ...base, run: old });
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r.ok && r.analysis.run?.privacy).toBeNull();
  });

  it('reads a run without a ranking sentence, or with one over 300 characters, as no sentence', async () => {
    const run = {
      model: 'z-ai/glm-5.3-flash',
      turns: 2,
      toolCalls: 5,
      ms: 6200,
      read: { tokens: 7, loan: true },
      checks: { picked: 1, explained: 1, replaced: 0, restored: 0, dropped: 0 },
    };
    for (const ranking of [undefined, 'x'.repeat(301)]) {
      reply({ ...base, run: { ...run, ranking } });
      const r = await runAnalysis('alice.near', 'balanced');
      expect(r.ok && r.analysis.run?.ranking).toBeNull();
    }
  });

  it('keeps the fallback code and what was read without a model run', async () => {
    const nothing = {
      ...base,
      source: 'heuristic',
      fallback: 'nothing_to_rank',
      read: { tokens: 3, loan: true },
    };
    reply(nothing);
    const out = await runAnalysis('alice.near', 'balanced');
    expect(out).toEqual({
      ok: true,
      analysis: { ...nothing, calledTools: [], trace: [], run: null, cachedAt: null },
    });
    expect(out.ok && pipelineOf(out.analysis).read).toEqual({ tokens: 3, loan: true });
  });

  it('accepts an older reply without them', async () => {
    reply(base);
    expect(await runAnalysis('alice.near', 'balanced')).toEqual({
      ok: true,
      analysis: { ...base, calledTools: [], trace: [], run: null, read: null, cachedAt: null },
    });
  });

  it('sends the portfolio signature with the run', async () => {
    reply(base);
    await runAnalysis('alice.near', 'balanced', () => {}, 'sig-1');
    const [, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(JSON.parse(init?.body as string)).toEqual({
      account: 'alice.near',
      strategy: 'balanced',
      signature: 'sig-1',
    });
  });

  it('keeps when a reused result was computed', async () => {
    reply({ ...base, cachedAt: '2026-11-14T10:00:00.000Z' });
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r.ok && r.analysis.cachedAt).toBe('2026-11-14T10:00:00.000Z');
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
        frame('read', { model: 'z-ai/glm-5.3-flash', tokens: 7, loan: true }) +
          frame('asked', { agents: [{ tool: step.tool, agent: step.agent }] }) +
          frame('agent', { step }) +
          frame('ranked', { turns: 2 }) +
          frame('checked', { checks }) +
          frame('done', done),
      ),
    );
    const seen: unknown[] = [];
    const r = await runAnalysis('alice.near', 'balanced', (p) => seen.push(p));
    expect(r).toMatchObject({
      ok: true,
      analysis: { source: 'llm', trace: done.trace, cachedAt: null },
    });
    const read = { model: 'z-ai/glm-5.3-flash', read: { tokens: 7, loan: true } };
    const asked = [{ tool: step.tool, agent: step.agent }];
    expect(seen).toEqual([
      {
        ...read,
        asked: [],
        trace: [],
        turns: null,
        checks: null,
        ranking: null,
        privacy: null,
        stage: 1,
      },
      {
        ...read,
        asked,
        trace: [],
        turns: null,
        checks: null,
        ranking: null,
        privacy: null,
        stage: 1,
      },
      {
        ...read,
        asked,
        trace: [step],
        turns: null,
        checks: null,
        ranking: null,
        privacy: null,
        stage: 2,
      },
      {
        ...read,
        asked,
        trace: [step],
        turns: 2,
        checks: null,
        ranking: null,
        privacy: null,
        stage: 3,
      },
      { ...read, asked, trace: [step], turns: 2, checks, ranking: null, privacy: null, stage: 4 },
    ]);
  });

  it('never moves the stage back when the model asks more agents in a later turn', async () => {
    const more = { tool: 'yield_scout', agent: 'Yield Scout' };
    serve(
      stream(
        frame('read', { model: 'm', tokens: 1, loan: false }) +
          frame('asked', { agents: [{ tool: step.tool, agent: step.agent }] }) +
          frame('agent', { step }) +
          frame('asked', { agents: [more] }) +
          frame('done', done),
      ),
    );
    const seen: Pipeline[] = [];
    await runAnalysis('alice.near', 'balanced', (p) => p && seen.push(p));
    expect(seen.map((p) => p.stage)).toEqual([1, 1, 2, 2]);
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
      stream(frame('read', { model: 'm', tokens: 1, loan: false })),
      new Response(JSON.stringify(done), { status: 200 }),
    );
    const r = await runAnalysis('alice.near', 'balanced');
    expect(r).toMatchObject({ ok: true, analysis: { source: 'llm' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows an error frame instead of running the same failing pipeline again', async () => {
    const fetch = serve(
      stream(
        frame('read', { model: 'm', tokens: 1, loan: false }) +
          frame('error', { error: 'analysis failed' }),
      ),
    );
    const seen: unknown[] = [];
    const r = await runAnalysis('alice.near', 'balanced', (p) => seen.push(p));
    expect(r).toEqual({ ok: false, error: 'analysis failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBeNull();
  });
});

describe('parseSaved', () => {
  it("reads the owner's saved analysis and its signature", () => {
    const saved = parseSaved({
      analysis: { ...base, cachedAt: '2026-11-14T10:00:00.000Z' },
      signature: 'sig-1',
    });
    expect(saved?.signature).toBe('sig-1');
    expect(saved?.analysis.cachedAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('reads nothing saved, a malformed reply or a missing signature as no saved analysis', () => {
    expect(parseSaved(null)).toBeNull();
    expect(parseSaved({ analysis: null, signature: null })).toBeNull();
    expect(parseSaved({ analysis: { source: 'nope' }, signature: 's' })).toBeNull();
    expect(parseSaved({ analysis: base, signature: null })).toBeNull();
  });
});

describe('privacyMark', () => {
  const model = 'z-ai/glm-5.3-flash';
  it('says signed in TEE only for a verified run, linking to the model attestation', () => {
    expect(privacyMark({ verified: true, reason: null, chatIds: ['c1'] }, model)).toEqual({
      label: 'Private AI · signed in TEE',
      href: 'https://cloud.near.ai/verify?model=z-ai%2Fglm-5.3-flash',
      title: expect.stringContaining('signed by the key') as string,
      chatIds: ['c1'],
    });
  });
  it('never claims a signature for an unverified run, and says why', () => {
    const mark = privacyMark({ verified: false, reason: 'no signature', chatIds: ['c1'] }, model);
    expect(mark?.label).toBe('Private AI · signature not verified');
    expect(mark?.title).toContain('no signature');
  });
  it('shows no mark for a run that was not checked', () => {
    expect(privacyMark(null, model)).toBeNull();
  });
});
