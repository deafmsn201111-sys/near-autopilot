import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let proof: string | undefined;
let ip = '203.0.113.1';
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', ip]]),
  cookies: async () => ({ get: () => (proof === undefined ? undefined : { value: proof }) }),
}));
const apiPost = vi.fn(async () => ({
  status: 200,
  body: { source: 'llm', note: null, recommendations: [], calledTools: [] },
}));
const apiPostStream = vi.fn(
  async (): Promise<Response | null> =>
    new Response('event: done\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
);
vi.mock('../lib/api', () => ({ apiPost, apiPostStream }));

function request(
  body: unknown,
  contentType = 'application/json',
  accept = 'application/json',
): Request {
  return new Request('http://localhost/api/analysis', {
    method: 'POST',
    headers: { 'content-type': contentType, accept },
    body: JSON.stringify(body),
  });
}

describe('POST /api/analysis', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    apiPostStream.mockClear();
    proof = undefined;
    ip = '203.0.113.1';
  });

  it('forwards a valid account to the analysis endpoint', async () => {
    const { POST } = await import('../app/api/analysis/route');
    const req = request({ account: 'Alice.near ' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledWith(
      '/v1/analytics/account/alice.near/analysis',
      { strategy: 'balanced' },
      60_000,
      {},
      req.signal,
    );
  });

  it('passes an event stream through unbuffered when the browser asks for one', async () => {
    proof = 'signed-proof';
    const { POST } = await import('../app/api/analysis/route');
    const req = request({ account: 'alice.near' }, undefined, 'text/event-stream');
    const res = await POST(req);
    expect(apiPostStream).toHaveBeenCalledWith(
      '/v1/analytics/account/alice.near/analysis',
      { strategy: 'balanced' },
      60_000,
      { 'x-ownership-proof': 'signed-proof' },
      req.signal,
    );
    expect(apiPost).not.toHaveBeenCalled();
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(await res.text()).toBe('event: done\ndata: {}\n\n');
  });

  it('answers a stream request with the API error as JSON when the API sends no stream', async () => {
    apiPostStream.mockResolvedValueOnce(
      Response.json({ error: 'the chain read failed' }, { status: 502 }),
    );
    const { POST } = await import('../app/api/analysis/route');
    const res = await POST(request({ account: 'alice.near' }, undefined, 'text/event-stream'));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'the chain read failed' });
  });

  it('answers 502 when the API is unreachable for a stream', async () => {
    apiPostStream.mockResolvedValueOnce(null);
    const { POST } = await import('../app/api/analysis/route');
    const res = await POST(request({ account: 'alice.near' }, undefined, 'text/event-stream'));
    expect(res.status).toBe(502);
  });

  it('forwards the chosen strategy', async () => {
    const { POST } = await import('../app/api/analysis/route');
    await POST(request({ account: 'alice.near', strategy: 'aggressive' }));
    expect(apiPost).toHaveBeenCalledWith(
      '/v1/analytics/account/alice.near/analysis',
      { strategy: 'aggressive' },
      60_000,
      {},
      expect.any(AbortSignal),
    );
  });

  it.each([
    {},
    { account: 'not a/near id' },
    { account: 42 },
    { account: 'alice.near', strategy: 'yolo' },
  ])('answers 400 to %j without calling the API', async (body) => {
    const { POST } = await import('../app/api/analysis/route');
    expect((await POST(request(body))).status).toBe(400);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('forwards the ownership proof cookie so the API can unlock the LLM for the owner', async () => {
    proof = 'signed-proof';
    const { POST } = await import('../app/api/analysis/route');
    await POST(request({ account: 'alice.near' }));
    expect(apiPost).toHaveBeenCalledWith(
      '/v1/analytics/account/alice.near/analysis',
      { strategy: 'balanced' },
      60_000,
      {
        'x-ownership-proof': 'signed-proof',
      },
      expect.any(AbortSignal),
    );
  });

  it('answers 429 once a visitor has used up the tight per-visitor limit', async () => {
    const { POST } = await import('../app/api/analysis/route');
    for (let i = 0; i < 5; i++)
      expect((await POST(request({ account: 'a.near' }))).status).toBe(200);
    const limited = await POST(request({ account: 'a.near' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(5);
  });

  it('leaves the global AI limit to the API: many visitors are never limited here', async () => {
    const { POST } = await import('../app/api/analysis/route');
    for (let i = 1; i <= 70; i++) {
      ip = `198.51.100.${i}`;
      expect((await POST(request({ account: 'a.near' }))).status).toBe(200);
    }
  });

  it('answers 415 to a non-JSON content-type', async () => {
    const { POST } = await import('../app/api/analysis/route');
    expect((await POST(request({ account: 'alice.near' }, 'text/plain'))).status).toBe(415);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
