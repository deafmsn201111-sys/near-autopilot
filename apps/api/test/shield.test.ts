import { describe, expect, it } from 'vitest';
import {
  SHIELD_BASE_URL,
  SHIELD_TTL_MS,
  ShieldClient,
  incidentsFor,
  type ShieldIncident,
} from '../src/gateway/shield';
import { MarketHttpError } from '../src/market-data/http';

const USDC_ETH = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
const SOL = 'nep141:sol.omft.near';
const HOT_TON = 'nep245:v2_1.omni.hot.tg:1117_';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

const route = (origin: string, chain: string) => ({
  origin: { assetId: origin, blockchain: chain },
  destination: { assetId: USDC_NEAR, blockchain: 'near' },
});

function client(answer: () => Promise<unknown>) {
  let t = 0;
  const calls: { url: string; headers: Record<string, string> | undefined }[] = [];
  const errors: unknown[] = [];
  const shield = new ShieldClient({
    http: {
      getJson: async (url: string, headers?: Record<string, string>) => {
        calls.push({ url, headers });
        return answer();
      },
    },
    jwt: 'shield-key',
    now: () => t,
    onError: (err) => errors.push(err),
  });
  return { shield, calls, errors, tick: (ms: number) => (t += ms) };
}

const feed =
  (...incidents: unknown[]) =>
  async () => ({ status: 'incidents', incidents });

describe('ShieldClient', () => {
  it('reads operational as no incident, with the bearer key', async () => {
    const { shield, calls } = client(async () => ({ status: 'operational' }));
    expect(await shield.incidents()).toEqual([]);
    expect(calls).toEqual([
      { url: `${SHIELD_BASE_URL}/incident`, headers: { authorization: 'Bearer shield-key' } },
    ]);
  });

  it('keeps chain, bridge and token incidents and drops address and malformed ones', async () => {
    const { shield } = client(
      feed(
        { scopeType: 'chain', scopeValue: 'eth', direction: 'deposit', publicDescription: 'Slow' },
        { scopeType: 'bridge', scopeValue: 'POA', direction: 'deposit' },
        { scopeType: 'token', scopeValue: SOL, publicDescription: '' },
        { scopeType: 'address', scopeValue: '0xabc', direction: 'deposit' },
        { scopeType: 'chain', scopeValue: 42 },
        'nonsense',
      ),
    );
    expect(await shield.incidents()).toEqual([
      { scopeType: 'chain', scopeValue: 'eth', direction: 'deposit', text: 'Slow' },
      { scopeType: 'bridge', scopeValue: 'poa', direction: 'deposit', text: null },
      { scopeType: 'token', scopeValue: SOL, direction: null, text: null },
    ]);
  });

  it('treats the public description as untrusted plain text: control characters out, length capped', async () => {
    const { shield } = client(
      feed({
        scopeType: 'chain',
        scopeValue: 'eth',
        publicDescription: `  <b>ETH</b>\u0000 deposits\n\tdelayed  ${'x'.repeat(1000)}`,
      }),
    );
    const [i] = await shield.incidents();
    expect(i?.text?.startsWith('<b>ETH</b> deposits delayed xxx')).toBe(true);
    expect(i?.text?.length).toBeLessThanOrEqual(280);
    expect(i?.text?.endsWith('…')).toBe(true);
  });

  it('calls SHIELD at most once a minute, however many callers', async () => {
    const { shield, calls, tick } = client(async () => ({ status: 'operational' }));
    await Promise.all([shield.incidents(), shield.incidents(), shield.incidents()]);
    tick(SHIELD_TTL_MS - 1);
    await shield.incidents();
    expect(calls).toHaveLength(1);
    tick(1);
    await shield.incidents();
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['bad JSON shape', async () => ({ status: 'incidents', incidents: 'oops' })],
    ['an unknown status', async () => ({ status: 'degraded' })],
    [
      'a timeout',
      async () => {
        throw new MarketHttpError('timeout', 'timed out', true);
      },
    ],
  ])(
    'answers %s with no incident and one log line, and does not retry within the minute',
    async (_, answer) => {
      const { shield, calls, errors } = client(answer);
      expect(await shield.incidents()).toEqual([]);
      expect(await shield.incidents()).toEqual([]);
      expect(calls).toHaveLength(1);
      expect(errors).toHaveLength(1);
    },
  );
});

describe('incidentsFor', () => {
  const chain = (scopeValue: string, direction: string | null): ShieldIncident => ({
    scopeType: 'chain',
    scopeValue,
    direction,
    text: null,
  });

  it('matches a deposit incident on the chain the user sends from, not another chain', () => {
    const eth = chain('eth', 'deposit');
    expect(incidentsFor([eth], route(USDC_ETH, 'eth'))).toEqual([eth]);
    expect(incidentsFor([eth], route(SOL, 'sol'))).toEqual([]);
  });

  it('ignores a withdraw incident on the sending side but not on NEAR, where the deposit arrives', () => {
    const ethOut = chain('eth', 'withdraw');
    const nearOut = chain('near', 'withdraw');
    expect(incidentsFor([ethOut], route(USDC_ETH, 'eth'))).toEqual([]);
    expect(incidentsFor([nearOut], route(USDC_ETH, 'eth'))).toEqual([nearOut]);
    expect(incidentsFor([chain('near', 'deposit')], route(USDC_ETH, 'eth'))).toEqual([]);
  });

  it('matches an incident with no or an unknown direction on either side', () => {
    expect(incidentsFor([chain('eth', null)], route(USDC_ETH, 'eth'))).toHaveLength(1);
    expect(incidentsFor([chain('near', 'both')], route(USDC_ETH, 'eth'))).toHaveLength(1);
  });

  it('maps a bridge incident to the tokens it carries', () => {
    const poa: ShieldIncident = {
      scopeType: 'bridge',
      scopeValue: 'poa',
      direction: 'deposit',
      text: null,
    };
    const hot: ShieldIncident = { ...poa, scopeValue: 'hot' };
    const other: ShieldIncident = { ...poa, scopeValue: 'wormhole' };
    expect(incidentsFor([poa, hot, other], route(USDC_ETH, 'eth'))).toEqual([poa]);
    expect(incidentsFor([poa, hot, other], route(HOT_TON, 'ton'))).toEqual([hot]);
  });

  it('matches a token incident by asset id on its side', () => {
    const token = (scopeValue: string, direction: string): ShieldIncident => ({
      scopeType: 'token',
      scopeValue,
      direction,
      text: null,
    });
    expect(incidentsFor([token(USDC_ETH, 'deposit')], route(USDC_ETH, 'eth'))).toHaveLength(1);
    expect(incidentsFor([token(USDC_NEAR, 'withdraw')], route(USDC_ETH, 'eth'))).toHaveLength(1);
    expect(incidentsFor([token(SOL, 'deposit')], route(USDC_ETH, 'eth'))).toEqual([]);
  });
});
