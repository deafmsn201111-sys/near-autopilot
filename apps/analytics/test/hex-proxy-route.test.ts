import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));

const upstream = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
);

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  contentType = 'application/json',
) {
  const route = await import('../app/api/hex/[...path]/route');
  const req = new Request(`http://localhost/api/hex/${path}`, {
    method,
    headers: {
      origin: 'https://near-autopilot.tech',
      cookie: 'np_account=alice.near',
      ...(body !== undefined ? { 'content-type': contentType } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  return method === 'GET' ? route.GET(req) : route.POST(req);
}

describe('/api/hex proxy to hex-api (D42)', () => {
  beforeEach(() => {
    vi.resetModules();
    upstream.mockClear();
    forwardedFor = '203.0.113.1';
    vi.stubGlobal('fetch', upstream);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a listed GET with its query, without the visitor origin or cookies', async () => {
    const res = await call('GET', 'market/v1/prices?ns=key&ids=8453%3Anative');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://hex-api.app/market/v1/prices?ns=key&ids=8453%3Anative');
    const sent = new Headers(init?.headers);
    expect(sent.get('origin')).toBeNull();
    expect(sent.get('cookie')).toBeNull();
  });

  it('forwards a 1Click quote POST with its JSON body', async () => {
    const res = await call('POST', 'market/v1/1click/v0/quote', '{"amount":"1"}');
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe('https://hex-api.app/market/v1/1click/v0/quote');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"amount":"1"}');
  });

  it('answers 404 to anything not listed, and to a listed path with the wrong method', async () => {
    for (const [method, path] of [
      ['GET', 'wallet/v1/rpc/1'],
      ['GET', 'market/v1/../../mpc/sign'],
      ['POST', 'market/v1/prices'],
      ['GET', 'market/v1/1click/v0/quote'],
      ['POST', 'market/v1/1click/v0/auth/authenticate'],
    ] as const) {
      expect((await call(method, path, method === 'POST' ? '{}' : undefined)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a non-JSON or oversized POST body', async () => {
    expect((await call('POST', 'market/v1/1click/v0/quote', 'x', 'text/plain')).status).toBe(415);
    const big = JSON.stringify({ pad: 'x'.repeat(20_000) });
    expect((await call('POST', 'market/v1/1click/v0/quote', big)).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('limits quotes per visitor', async () => {
    let last = 0;
    for (let i = 0; i < 121; i++)
      last = (await call('POST', 'market/v1/1click/v0/quote', '{}')).status;
    expect(last).toBe(429);
    forwardedFor = '198.51.100.7';
    expect((await call('POST', 'market/v1/1click/v0/quote', '{}')).status).toBe(200);
  });

  it('answers 502 when hex-api is unreachable', async () => {
    upstream.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await call('GET', 'market/v1/1click/v0/tokens')).status).toBe(502);
  });
});
