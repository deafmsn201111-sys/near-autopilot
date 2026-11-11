import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', '203.0.113.1']]),
}));
const apiPost = vi.fn(async () => ({
  status: 200,
  body: { source: 'llm', note: null, recommendations: [], calledTools: [] },
}));
vi.mock('../lib/api', () => ({ apiPost }));

function request(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost/api/analysis', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  });
}

describe('POST /api/analysis', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
  });

  it('forwards a valid account to the analysis endpoint', async () => {
    const { POST } = await import('../app/api/analysis/route');
    const res = await POST(request({ account: 'Alice.near ' }));
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledWith('/v1/analytics/account/alice.near/analysis', {}, 60_000);
  });

  it.each([{}, { account: 'not a/near id' }, { account: 42 }])(
    'answers 400 to %j without calling the API',
    async (body) => {
      const { POST } = await import('../app/api/analysis/route');
      expect((await POST(request(body))).status).toBe(400);
      expect(apiPost).not.toHaveBeenCalled();
    },
  );

  it('answers 429 once a visitor has used up the tight per-visitor limit', async () => {
    const { POST } = await import('../app/api/analysis/route');
    for (let i = 0; i < 5; i++)
      expect((await POST(request({ account: 'a.near' }))).status).toBe(200);
    const limited = await POST(request({ account: 'a.near' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(5);
  });

  it('answers 415 to a non-JSON content-type', async () => {
    const { POST } = await import('../app/api/analysis/route');
    expect((await POST(request({ account: 'alice.near' }, 'text/plain'))).status).toBe(415);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
