import { beforeEach, describe, expect, it, vi } from 'vitest';

// The guard reads the visitor's address from the request headers; here each test sets it.
let forwardedFor = '203.0.113.1';
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => new Map([['x-forwarded-for', forwardedFor]]),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
const apiPost = vi.fn(async () => ({ status: 202, body: {} }));
vi.mock('../lib/api', () => ({ apiPost }));

describe('public demo mode (PUBLIC_DEMO=1)', () => {
  beforeEach(() => {
    vi.resetModules();
    apiPost.mockClear();
    forwardedFor = '203.0.113.1';
  });

  it('refuses every operator control on the server, without calling the API', async () => {
    vi.stubEnv('PUBLIC_DEMO', '1');
    const a = await import('../app/autopilot/actions');
    for (const r of [
      await a.runAnalysis(),
      await a.setCollectorPaused(true, 'x'),
      await a.setMode('s', 'read_only', 'x'),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Disabled on the public demo/);
    }
    expect(apiPost).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('rate-limits each visitor, and one visitor over the limit does not block another', async () => {
    vi.stubEnv('PUBLIC_DEMO', '1');
    const { withinLimit } = await import('../lib/public-demo');
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) expect(await withinLimit('action', now)).toBe(true);
    expect(await withinLimit('action', now)).toBe(false);
    forwardedFor = '198.51.100.7';
    expect(await withinLimit('action', now)).toBe(true);
    // the window passes
    forwardedFor = '203.0.113.1';
    expect(await withinLimit('action', now + 10 * 60_000 + 1)).toBe(true);
    vi.unstubAllEnvs();
  });

  it('changes nothing when the mode is off', async () => {
    vi.stubEnv('PUBLIC_DEMO', '');
    const { withinLimit, PUBLIC_DEMO } = await import('../lib/public-demo');
    expect(PUBLIC_DEMO).toBe(false);
    for (let i = 0; i < 50; i++) expect(await withinLimit('action')).toBe(true);
    const a = await import('../app/autopilot/actions');
    expect((await a.runAnalysis()).ok).toBe(true);
    expect(apiPost).toHaveBeenCalledTimes(1);
    vi.unstubAllEnvs();
  });
});
