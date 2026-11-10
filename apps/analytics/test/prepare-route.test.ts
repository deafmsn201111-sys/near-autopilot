import { beforeEach, describe, expect, it, vi } from 'vitest';

let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));
const apiPost = vi.fn(async () => ({ status: 200, body: { signed: false, transactions: [] } }));
vi.mock('../lib/api', () => ({ apiPost }));

const validBody = JSON.stringify({ account: 'alice.near', intent: { action: 'repay' } });

function request(contentType: string | null, body = validBody): Request {
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  return new Request('http://localhost/api/prepare', { method: 'POST', headers, body });
}

describe('POST /api/prepare', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    forwardedFor = '203.0.113.1';
  });

  it.each([null, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])(
    'answers 415 to content-type %s without calling the API',
    async (contentType) => {
      const { POST } = await import('../app/api/prepare/route');
      const res = await POST(request(contentType));
      expect(res.status).toBe(415);
      expect(apiPost).not.toHaveBeenCalled();
    },
  );

  it('accepts application/json with a charset', async () => {
    const { POST } = await import('../app/api/prepare/route');
    const res = await POST(request('Application/JSON; charset=utf-8'));
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledOnce();
  });

  it('answers 429 once a visitor is over the limit, and another visitor still gets through', async () => {
    const { POST } = await import('../app/api/prepare/route');
    for (let i = 0; i < 30; i++) expect((await POST(request('application/json'))).status).toBe(200);
    const limited = await POST(request('application/json'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(apiPost).toHaveBeenCalledTimes(30);

    forwardedFor = '198.51.100.7';
    expect((await POST(request('application/json'))).status).toBe(200);
  });
});
