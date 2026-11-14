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
  recipient: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
};

function request(contentType: string | null, body: string = JSON.stringify(fields)): Request {
  const headers = new Headers();
  if (contentType !== null) headers.set('content-type', contentType);
  return new Request('http://localhost/api/withdraw/quote', { method: 'POST', headers, body });
}

describe('POST /api/withdraw/quote', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    forwardedFor = '203.0.113.1';
  });

  it.each([null, 'text/plain', 'application/x-www-form-urlencoded'])(
    'answers 415 to content-type %s without calling the API',
    async (contentType) => {
      const { POST } = await import('../app/api/withdraw/quote/route');
      expect((await POST(request(contentType))).status).toBe(415);
      expect(apiPost).not.toHaveBeenCalled();
    },
  );

  it('forwards only the five form fields to the API', async () => {
    const { POST } = await import('../app/api/withdraw/quote/route');
    const res = await POST(
      request('application/json', JSON.stringify({ ...fields, refundTo: 'x.near' })),
    );
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledWith('/v1/withdraw/quote', fields, 40_000);
  });

  it('answers 400 to a body without the string fields', async () => {
    const { POST } = await import('../app/api/withdraw/quote/route');
    const res = await POST(request('application/json', JSON.stringify({ ...fields, amount: 100 })));
    expect(res.status).toBe(400);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('allows 5 quotes per visitor in 10 minutes, then 429; another visitor still gets through', async () => {
    const { POST } = await import('../app/api/withdraw/quote/route');
    for (let i = 0; i < 5; i++) expect((await POST(request('application/json'))).status).toBe(200);
    const limited = await POST(request('application/json'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(apiPost).toHaveBeenCalledTimes(5);
    forwardedFor = '198.51.100.7';
    expect((await POST(request('application/json'))).status).toBe(200);
  });

  it('answers 429 to everyone once 100 quotes were asked in the window', async () => {
    const { POST } = await import('../app/api/withdraw/quote/route');
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

describe('GET /api/deposit/status/:id', () => {
  beforeEach(() => {
    vi.resetModules();
    tryApi.mockClear();
    forwardedFor = '203.0.113.1';
  });
  const get = async (id: string) => {
    const { GET } = await import('../app/api/deposit/status/[id]/route');
    return GET(new Request(`http://localhost/api/deposit/status/${id}`), {
      params: Promise.resolve({ id }),
    });
  };

  it('forwards only our quote id to the API', async () => {
    expect((await get('dq_1')).status).toBe(200);
    expect(tryApi).toHaveBeenCalledWith('/v1/deposit/status/dq_1');
  });

  it('answers 400 to an id that is not ours without calling the API', async () => {
    expect((await get('../admin')).status).toBe(400);
    expect(tryApi).not.toHaveBeenCalled();
  });

  it('allows 60 checks per visitor in 10 minutes, apart from the quote limit', async () => {
    for (let i = 0; i < 60; i++) expect((await get('dq_1')).status).toBe(200);
    const limited = await get('dq_1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
    expect(tryApi).toHaveBeenCalledTimes(60);
    forwardedFor = '198.51.100.7';
    expect((await get('dq_1')).status).toBe(200);
    forwardedFor = '203.0.113.1';
    const { POST } = await import('../app/api/withdraw/quote/route');
    expect((await POST(request('application/json'))).status).toBe(200);
  });
});
