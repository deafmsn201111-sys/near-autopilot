import { beforeEach, describe, expect, it, vi } from 'vitest';

let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));
const apiPost = vi.fn(async (_path: string, _body: unknown) => ({
  status: 404,
  body: { error: 'unknown cascade' } as Record<string, unknown>,
}));
vi.mock('../lib/api', () => ({ apiPost }));

const post = (url: string, body: unknown, type = 'application/json') =>
  new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-forwarded-for': forwardedFor },
    body: JSON.stringify(body),
  });

const madeUp = {
  account: 'alice.near',
  cascadeId: '00000000-0000-4000-8000-000000000000',
  step: 0,
  hash: '8qw2aCaeCqfsEZQmG77vuzZPvLfhy8BV1wyUcgBFWt22',
};

describe('POST /api/confirm', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    forwardedFor = '203.0.113.1';
  });

  it('a made-up hash gets the API short error back, and only the known fields go on', async () => {
    const { POST } = await import('../app/api/confirm/route');
    const res = await POST(post('/api/confirm', { ...madeUp, ip: '1.2.3.4' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown cascade' });
    expect(apiPost).toHaveBeenCalledWith('/v1/wallet/confirm', madeUp);
  });

  it('answers 415 to a non-JSON body and 400 to a wrong shape, without calling the API', async () => {
    const { POST } = await import('../app/api/confirm/route');
    expect((await POST(post('/api/confirm', madeUp, 'text/plain'))).status).toBe(415);
    expect((await POST(post('/api/confirm', { hash: 1 }))).status).toBe(400);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('answers "too many requests" once a visitor is over the limit', async () => {
    const { POST } = await import('../app/api/confirm/route');
    for (let i = 0; i < 60; i++) await POST(post('/api/confirm', madeUp));
    const limited = await POST(post('/api/confirm', madeUp));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: 'Too many requests. Wait a few minutes and try again.',
    });
  });
});

describe('POST /api/events', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
  });

  it('forwards only a connect with its account', async () => {
    apiPost.mockResolvedValueOnce({ status: 200, body: { stored: true } });
    const { POST } = await import('../app/api/events/route');
    const res = await POST(post('/api/events', { kind: 'connect', account: 'alice.near', x: 1 }));
    expect(res.status).toBe(200);
    expect(apiPost).toHaveBeenCalledWith('/v1/events', { kind: 'connect', account: 'alice.near' });
  });

  it('refuses any other kind', async () => {
    const { POST } = await import('../app/api/events/route');
    expect((await POST(post('/api/events', { kind: 'signed', account: 'a.near' }))).status).toBe(400);
    expect(apiPost).not.toHaveBeenCalled();
  });
});
