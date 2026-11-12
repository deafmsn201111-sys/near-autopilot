import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
let host = '127.0.0.1:3002';
vi.mock('next/headers', () => ({ headers: async () => new Map([['host', host]]) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

const API_TOKEN = 'public-token-public-token-public-token-1';
const ADMIN_TOKEN = 'admin-token-admin-token-admin-token-admin-1';
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));

describe('admin', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('API_BASE_URL', 'http://analytics-api:4000');
    vi.stubEnv('API_TOKEN', API_TOKEN);
    host = '127.0.0.1:3002';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('answers 404 for /admin without ADMIN_UI=1', async () => {
    vi.stubEnv('ADMIN_UI', '');
    const { default: AdminLayout } = await import('../app/admin/layout');
    expect(() => AdminLayout({ children: null })).toThrow('NEXT_NOT_FOUND');
  });

  it('answers a real 404 status for /admin and its subpaths without ADMIN_UI=1', async () => {
    vi.stubEnv('ADMIN_UI', '');
    const { middleware } = await import('../middleware');
    const { NextRequest } = await import('next/server');
    for (const path of ['/admin', '/admin/', '/admin/x', '/%61dmin', '/ADMIN'])
      expect(middleware(new NextRequest(`http://localhost${path}`)).status).toBe(404);
    expect(middleware(new NextRequest('http://localhost/administrator')).status).toBe(200);
    vi.stubEnv('ADMIN_UI', '1');
    const loopback = { headers: { host: '127.0.0.1:3002' } };
    expect(middleware(new NextRequest('http://localhost/admin', loopback)).status).toBe(200);
  });

  it('serves the admin container only on a loopback Host', async () => {
    vi.stubEnv('ADMIN_UI', '1');
    const { middleware } = await import('../middleware');
    const { NextRequest } = await import('next/server');
    const at = (host: string) =>
      middleware(new NextRequest('http://127.0.0.1:3002/admin', { headers: { host } })).status;
    expect(at('127.0.0.1:3002')).toBe(200);
    expect(at('localhost:3002')).toBe(200);
    expect(at('evil.example:3002')).toBe(403);
    expect(at('127.0.0.1.evil.example')).toBe(403);
  });

  it('never calls the admin API from the public site, even with a token', async () => {
    vi.stubEnv('ADMIN_UI', '');
    vi.stubEnv('ADMIN_API_TOKEN', ADMIN_TOKEN);
    const { adminApi } = await import('../lib/admin');
    await expect(adminApi('/spend')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 404 in the admin container without an admin token', async () => {
    vi.stubEnv('ADMIN_UI', '1');
    vi.stubEnv('ADMIN_API_TOKEN', '');
    const { adminApi } = await import('../lib/admin');
    await expect(adminApi('/spend')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('never calls the admin API for a non-loopback Host (a server action posted past the middleware)', async () => {
    vi.stubEnv('ADMIN_UI', '1');
    vi.stubEnv('ADMIN_API_TOKEN', ADMIN_TOKEN);
    host = 'evil.example:3002';
    const { adminApi } = await import('../lib/admin');
    await expect(adminApi('/settings', { llmEnabled: false })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the admin token, not the public one, to /v1/admin', async () => {
    vi.stubEnv('ADMIN_UI', '1');
    vi.stubEnv('ADMIN_API_TOKEN', ADMIN_TOKEN);
    const { adminApi } = await import('../lib/admin');
    await adminApi('/settings', { llmEnabled: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://analytics-api:4000/v1/admin/settings');
    expect(init).toMatchObject({ method: 'POST', body: '{"llmEnabled":false}' });
    expect(init.headers).toMatchObject({ authorization: `Bearer ${ADMIN_TOKEN}` });
  });
});
