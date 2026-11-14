import { safeTokenIcon, type ContractViewer } from '@near-autopilot/core';
import { describe, expect, it } from 'vitest';
import { buildAnalyticsServer } from '../src/analytics/server';
import { NEAR_ICON, TokenIcons } from '../src/analytics/token-icons';
import type { CollectorStore } from '../src/collector/store';

const API_TOKEN = 'public-token-public-token-public-token-1';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const USDC_ICON = "data:image/svg+xml,%3Csvg width='96'%3E%3C/svg%3E";

function viewer(icons: Record<string, unknown>) {
  const calls: string[] = [];
  const v: ContractViewer = {
    view: async (contract, method) => {
      calls.push(`${contract}#${method}`);
      if (!(contract in icons)) throw new Error('RPC down');
      return { symbol: 'X', decimals: 6, icon: icons[contract] };
    },
  };
  return { v, calls };
}

describe('TokenIcons', () => {
  it('returns the ft_metadata icon once checked, and reads each token once', async () => {
    const { v, calls } = viewer({ [USDC]: USDC_ICON });
    const icons = new TokenIcons(v);
    expect(await icons.get(USDC)).toBe(USDC_ICON);
    expect(await icons.get(USDC)).toBe(USDC_ICON);
    expect(calls).toEqual([`${USDC}#ft_metadata`]);
  });

  it('drops an icon that is not an image data URI, and remembers that', async () => {
    const { v, calls } = viewer({ 'evil.near': 'data:text/html,<script>alert(1)</script>' });
    const icons = new TokenIcons(v);
    expect(await icons.get('evil.near')).toBeNull();
    expect(await icons.get('evil.near')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('does not remember a failed read', async () => {
    const { v, calls } = viewer({});
    const icons = new TokenIcons(v);
    expect(await icons.get('down.near')).toBeNull();
    expect(await icons.get('down.near')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('serves the checked-in NEAR logo for native NEAR and wNEAR without a view call', async () => {
    const { v, calls } = viewer({});
    const icons = new TokenIcons(v);
    expect(await icons.get('near')).toBe(NEAR_ICON);
    expect(await icons.get('wrap.near')).toBe(NEAR_ICON);
    expect(safeTokenIcon(NEAR_ICON)).toBe(NEAR_ICON);
    expect(calls).toHaveLength(0);
  });

  it('keeps at most `limit` tokens', async () => {
    const { v, calls } = viewer({ 'a.near': USDC_ICON, 'b.near': USDC_ICON });
    const icons = new TokenIcons(v, 1);
    await icons.get('a.near');
    await icons.get('b.near');
    await icons.get('a.near');
    expect(calls).toEqual(['a.near#ft_metadata', 'b.near#ft_metadata', 'a.near#ft_metadata']);
  });
});

describe('GET /v1/tokens/icons', () => {
  const app = () =>
    buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      icons: new TokenIcons(viewer({ [USDC]: USDC_ICON, 'plain.near': '' }).v),
    });
  const get = (url: string) =>
    app().inject({ method: 'GET', url, headers: { authorization: `Bearer ${API_TOKEN}` } });

  it('returns one logo or null per asked token', async () => {
    const res = await get(`/v1/tokens/icons?ids=${USDC},plain.near,near`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      icons: { [USDC]: USDC_ICON, 'plain.near': null, near: NEAR_ICON },
    });
  });

  it('refuses a token id that is not a NEAR account, and too many ids', async () => {
    expect((await get('/v1/tokens/icons?ids=..bad')).statusCode).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `t${i}.near`).join(',');
    expect((await get(`/v1/tokens/icons?ids=${many}`)).statusCode).toBe(400);
  });
});
