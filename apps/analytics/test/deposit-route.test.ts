import { beforeEach, describe, expect, it, vi } from 'vitest';

let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));
const apiPost = vi.fn(async (_path: string, _body?: unknown, _timeoutMs?: number) => ({
  status: 200,
  body: { id: 'dq_1' },
}));
const tryApi = vi.fn(async () => ({
  data: { origins: [], destinations: [] },
  error: null,
  status: null,
}));
vi.mock('../lib/api', () => ({ apiPost, tryApi }));

const fields = {
  account: 'alice.near',
  originAsset: 'nep141:eth-0xa0b8.omft.near',
  destinationAsset: 'nep141:wrap.near',
  amount: '100',
  refundTo: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
};

function request(contentType: string | null, body: string = JSON.stringify(fields)): Request {
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  return new Request('http://localhost/api/deposit/quote', { method: 'POST', headers, body });
}

describe('POST /api/deposit/quote', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    forwardedFor = '203.0.113.1';
  });

  it.each([null, 'text/plain', 'application/x-www-form-urlencoded'])(
    'answers 415 to content-type %s without calling the API',
    async (contentType) => {
      const { POST } = await import('../app/api/deposit/quote/route');
      expect((await POST(request(contentType))).status).toBe(415);
      expect(apiPost).not.toHaveBeenCalled();
    },
  );

  it('forwards only the five form fields to the API', async () => {
    const { POST } = await import('../app/api/deposit/quote/route');
    const res = await POST(
      request('application/json', JSON.stringify({ ...fields, recipient: 'x.near' })),
    );
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledWith('/v1/deposit/quote', fields, 40_000);
  });

  it('answers 400 to a body without the string fields', async () => {
    const { POST } = await import('../app/api/deposit/quote/route');
    const res = await POST(request('application/json', JSON.stringify({ ...fields, amount: 100 })));
    expect(res.status).toBe(400);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('allows 5 quotes per visitor in 10 minutes, then 429; another visitor still gets through', async () => {
    const { POST } = await import('../app/api/deposit/quote/route');
    for (let i = 0; i < 5; i++) expect((await POST(request('application/json'))).status).toBe(200);
    const limited = await POST(request('application/json'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(apiPost).toHaveBeenCalledTimes(5);
    forwardedFor = '198.51.100.7';
    expect((await POST(request('application/json'))).status).toBe(200);
  });

  it('answers 429 to everyone once 100 quotes were asked in the window', async () => {
    const { POST } = await import('../app/api/deposit/quote/route');
    for (let i = 0; i < 100; i++) {
      forwardedFor = `10.0.0.${i}`;
      expect((await POST(request('application/json'))).status).toBe(200);
    }
    forwardedFor = '198.51.100.99';
    expect((await POST(request('application/json'))).status).toBe(429);
  });
});

describe('GET /api/deposit/assets', () => {
  beforeEach(() => {
    vi.resetModules();
    tryApi.mockClear();
  });

  it('returns the API lists', async () => {
    const { GET } = await import('../app/api/deposit/assets/route');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ origins: [], destinations: [] });
    expect(tryApi).toHaveBeenCalledWith('/v1/deposit/assets');
  });
});
