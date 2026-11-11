import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('../lib/env', () => ({
  getEnv: () => ({ API_BASE_URL: 'http://api.internal:4000', API_TOKEN: 'secret-token' }),
}));
const { apiPost, tryApi } = await import('../lib/api');

const respond = (status: number, body: unknown) =>
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));
const unreachable = () =>
  vi.stubGlobal('fetch', async () => {
    throw new TypeError('fetch failed: connect ECONNREFUSED api.internal:4000');
  });

describe('API errors shown to the visitor', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("show the API's own message, not the internal path", async () => {
    respond(404, { error: 'account nobody.near does not exist on NEAR mainnet' });
    const r = await tryApi('/v1/analytics/account/nobody.near');
    expect(r.error).toBe('account nobody.near does not exist on NEAR mainnet');
  });

  it('fall back to the status when the API gives no message', async () => {
    respond(500, {});
    expect((await tryApi('/v1/x')).error).toBe('the analytics service failed (HTTP 500)');
  });

  it('hide the internal address when the API is unreachable', async () => {
    unreachable();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await tryApi('/v1/x')).error).toBe('the analytics service is unreachable');
    expect((await apiPost('/v1/x', {})).body).toEqual({
      error: 'the analytics service is unreachable',
    });
  });
});
