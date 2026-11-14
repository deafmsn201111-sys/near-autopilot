import { describe, expect, it } from 'vitest';
import { httpDiscovery, displaySymbol, MAX_DISCOVERED } from '../src/analytics/discovery';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fake = (routes: Record<string, () => Response>) => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    const u = url;
    calls.push(u);
    const route = routes[u];
    if (!route) throw new Error(`unexpected ${u}`);
    return route();
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
};

const FULL = 'https://api.fastnear.com/v1/account/npro-validator.near/full';
const POOLS = 'https://api.ref.finance/liquidity-pools/npro-validator.near';
const PRICES = 'https://indexer.ref.finance/list-token-price';
const DCL_LIST = 'https://indexer.ref.finance/list-pools?type=dcl&sort=tvl&limit=100&offset=0';

describe('httpDiscovery', () => {
  it('reads tokens and staking pools of the account from FastNEAR', async () => {
    const { fetchImpl } = fake({
      [FULL]: () =>
        json({
          pools: [{ pool_id: 'npro.poolv1.near' }, { pool_id: 'npro.poolv1.near' }],
          tokens: [
            { contract_id: 'wrap.near', balance: '413417671877902700000000000' },
            { contract_id: 'empty.near', balance: '0' },
            { contract_id: 'NOT VALID', balance: '5' },
            { contract_id: 'bad-balance.near', balance: '1e9' },
          ],
        }),
    });
    expect(await httpDiscovery(fetchImpl).account('npro-validator.near')).toEqual({
      tokens: [{ token: 'wrap.near', raw: 413417671877902700000000000n }],
      stakingPools: ['npro.poolv1.near'],
    });
  });

  it('caps an account with hundreds of tokens', async () => {
    const tokens = Array.from({ length: 500 }, (_, i) => ({
      contract_id: `spam${i}.near`,
      balance: '1',
    }));
    const { fetchImpl } = fake({ [FULL]: () => json({ tokens, pools: [] }) });
    const out = await httpDiscovery(fetchImpl).account('npro-validator.near');
    expect(out?.tokens).toHaveLength(MAX_DISCOVERED.tokens);
  });

  it('answers null when the indexer fails or returns junk', async () => {
    const down = fake({ [FULL]: () => json({ error: 'x' }, 500), [POOLS]: () => json('nope') });
    const d = httpDiscovery(down.fetchImpl);
    expect(await d.account('npro-validator.near')).toBeNull();
    expect(await d.v1PoolIds('npro-validator.near')).toBeNull();
  });

  it('lists the Rhea v1 pool ids the account has liquidity in', async () => {
    const { fetchImpl } = fake({
      [POOLS]: () => json([{ id: '6724', pool_kind: 'SIMPLE_POOL' }, { id: 'x' }]),
    });
    expect(await httpDiscovery(fetchImpl).v1PoolIds('npro-validator.near')).toEqual([6724]);
  });

  it('reads token prices once and keeps them for five minutes', async () => {
    let now = 0;
    const { fetchImpl, calls } = fake({
      [PRICES]: () =>
        json({
          'npro.nearmobile.near': { price: '0.2340556959', symbol: 'NPRO', decimal: 24 },
          'zero.near': { price: '0', symbol: 'Z', decimal: 18 },
          'junk.near': { price: 'abc', symbol: 'J', decimal: 18 },
        }),
    });
    const d = httpDiscovery(fetchImpl, () => now);
    const prices = await d.prices();
    expect(prices?.get('npro.nearmobile.near')).toBeCloseTo(0.2340556959);
    expect(prices?.has('zero.near')).toBe(false);
    expect(prices?.has('junk.near')).toBe(false);
    await d.prices();
    now = 6 * 60_000;
    await d.prices();
    expect(calls.filter((c) => c === PRICES)).toHaveLength(2);
  });

  it("reads each priced token's decimals from the same answer (#192)", async () => {
    const { fetchImpl, calls } = fake({
      [PRICES]: () =>
        json({
          'imeme-2.v2-launchpad.justhoot.near': { price: '0.000419', symbol: 'IMEME', decimal: 18 },
          'odd.near': { price: '1', symbol: 'O', decimal: 99 },
          'none.near': { price: '1', symbol: 'N' },
        }),
    });
    const d = httpDiscovery(fetchImpl);
    const decimals = await d.decimals();
    expect(decimals?.get('imeme-2.v2-launchpad.justhoot.near')).toBe(18);
    expect(decimals?.has('odd.near')).toBe(false);
    expect(decimals?.has('none.near')).toBe(false);
    expect((await d.prices())?.get('none.near')).toBe(1);
    expect(calls.filter((c) => c === PRICES)).toHaveLength(1);
  });

  it('reads the 24 h volume of DCL pools and drops malformed rows', async () => {
    const { fetchImpl } = fake({
      [DCL_LIST]: () =>
        json({
          code: 0,
          data: {
            list: [
              { id: 'usdc.near|wrap.near|100', volume_24h: '1670037.32', tvl: '634121' },
              { id: 'a.near|wrap.near|2000', volume_24h: '0' },
              { id: 'bad.near|wrap.near|100', volume_24h: '-5' },
              { id: 'huge.near|wrap.near|100', volume_24h: '1e99' },
            ],
          },
        }),
    });
    const volumes = await httpDiscovery(fetchImpl).dclVolumes24hUsd();
    expect(volumes).toEqual(
      new Map([
        ['usdc.near|wrap.near|100', 1670037.32],
        ['a.near|wrap.near|2000', 0],
      ]),
    );
  });

  it('answers null when the indexer reports an error', async () => {
    const { fetchImpl } = fake({ [DCL_LIST]: () => json({ code: -400, message: 'bad' }) });
    expect(await httpDiscovery(fetchImpl).dclVolumes24hUsd()).toBeNull();
  });
});

describe('displaySymbol', () => {
  it('keeps a plain symbol', () =>
    expect(displaySymbol('NPRO', 'npro.nearmobile.near')).toBe('NPRO'));
  it('strips markup, control characters and lookalike text, and caps the length', () => {
    expect(displaySymbol('<img src=x>‮VISIT scam.io NOW', 'a.near')).toBe('imgsrcxVISIT');
  });
  it('falls back to the contract id when nothing readable is left', () =>
    expect(displaySymbol('🚀🚀', 'rocket-token.near')).toBe('rocket-token'));
});
