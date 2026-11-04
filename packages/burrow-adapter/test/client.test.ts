import { describe, expect, it } from 'vitest';
import { UnexpectedResponseError } from '@near-autopilot/core';
import { ScriptedContractViewer } from '@near-autopilot/core/testing';
import { BurrowClient, BurrowOracleClient } from '../src';
import { ALICE, assetView, BURROW, ONE_USDT_INNER, ORACLE, USDT, WNEAR } from './support/fixtures';

describe('BurrowClient', () => {
  it('parses get_asset including extra_decimals, volatility ratio and flags', async () => {
    const viewer = new ScriptedContractViewer().on(
      BURROW,
      'get_asset',
      assetView({ token: USDT, extra: 12, vr: 8000, canBorrow: false }),
    );
    const asset = await new BurrowClient(viewer, BURROW).getAsset(USDT);
    expect(asset).toMatchObject({
      tokenId: USDT,
      extraDecimals: 12,
      volatilityRatioBps: 8000,
      canBorrow: false,
      canDeposit: true,
      canUseAsCollateral: true,
    });
    expect(asset?.suppliedInner).toBe(1000n);
    expect(viewer.calls[0]).toEqual({
      contractId: BURROW,
      methodName: 'get_asset',
      args: { token_id: USDT },
    });
  });

  it('returns null for an unlisted token', async () => {
    const viewer = new ScriptedContractViewer().on(BURROW, 'get_asset', null);
    expect(await new BurrowClient(viewer, BURROW).getAsset(USDT)).toBeNull();
  });

  it('tolerates unknown extra fields but rejects out-of-range or missing required ones', async () => {
    const extra = {
      ...(assetView({ token: USDT, extra: 12, vr: 8000 }) as object),
      brand_new_field: 1,
    };
    const viewer = new ScriptedContractViewer().on(BURROW, 'get_asset', extra);
    expect((await new BurrowClient(viewer, BURROW).getAsset(USDT))?.tokenId).toBe(USDT);

    const bad = assetView({ token: USDT, extra: 12, vr: 8000 }) as {
      config: Record<string, unknown>;
    };
    bad.config['volatility_ratio'] = 10_001;
    await expect(
      new BurrowClient(new ScriptedContractViewer().on(BURROW, 'get_asset', bad), BURROW).getAsset(
        USDT,
      ),
    ).rejects.toThrow(UnexpectedResponseError);

    delete bad.config['extra_decimals'];
    bad.config['volatility_ratio'] = 8000;
    await expect(
      new BurrowClient(new ScriptedContractViewer().on(BURROW, 'get_asset', bad), BURROW).getAsset(
        USDT,
      ),
    ).rejects.toThrow(UnexpectedResponseError);
  });

  it('pages assets, de-duplicating, whether `limit` means page size or end index', async () => {
    const all = Array.from({ length: 73 }, (_, i) =>
      assetView({ token: `token${i}.near`, extra: 0, vr: 5000 }),
    );
    const asEndIndex = new ScriptedContractViewer().onCall(
      BURROW,
      'get_assets_paged_detailed',
      (a) => all.slice(Number(a['from_index']), Number(a['limit'])),
    );
    const asPageSize = new ScriptedContractViewer().onCall(
      BURROW,
      'get_assets_paged_detailed',
      (a) => all.slice(Number(a['from_index']), Number(a['from_index']) + Number(a['limit'])),
    );
    for (const viewer of [asEndIndex, asPageSize]) {
      const list = await new BurrowClient(viewer, BURROW).listAssets();
      expect(list).toHaveLength(73);
      expect(new Set(list.map((a) => a.tokenId)).size).toBe(73);
    }
  });

  it('terminates when a node keeps returning the same page', async () => {
    const page = [assetView({ token: 'a.near', extra: 0, vr: 5000 })];
    const viewer = new ScriptedContractViewer().on(BURROW, 'get_assets_paged_detailed', page);
    expect(await new BurrowClient(viewer, BURROW).listAssets()).toHaveLength(1);
    expect(viewer.calls.length).toBeLessThanOrEqual(2);
  });

  it('parses accounts, keeps inner units and drops zero balances', async () => {
    const viewer = new ScriptedContractViewer().on(BURROW, 'get_account', {
      account_id: 'alice.near',
      supplied: [{ token_id: USDT, balance: '0', shares: '0' }],
      collateral: [{ token_id: WNEAR, balance: '100', shares: '1' }],
      borrowed: [
        { token_id: USDT, balance: (3n * ONE_USDT_INNER).toString(), shares: '1', apr: '0.1' },
      ],
    });
    const account = await new BurrowClient(viewer, BURROW).getAccount(ALICE);
    expect(account?.supplied).toEqual([]);
    expect(account?.collateral).toEqual([{ tokenId: WNEAR, inner: 100n }]);
    expect(account?.borrowed).toEqual([{ tokenId: USDT, inner: 3n * ONE_USDT_INNER }]);
  });

  it('treats an unregistered account as null and rejects malformed accounts', async () => {
    expect(
      await new BurrowClient(
        new ScriptedContractViewer().on(BURROW, 'get_account', null),
        BURROW,
      ).getAccount(ALICE),
    ).toBeNull();
    const bad = new ScriptedContractViewer().on(BURROW, 'get_account', {
      account_id: 'alice.near',
      supplied: 'x',
      collateral: [],
      borrowed: [],
    });
    await expect(new BurrowClient(bad, BURROW).getAccount(ALICE)).rejects.toThrow(
      UnexpectedResponseError,
    );
  });

  it('reads config and NEP-145 storage balance', async () => {
    const viewer = new ScriptedContractViewer()
      .on(BURROW, 'get_config', {
        oracle_account_id: ORACLE,
        owner_id: 'owner.near',
        maximum_recency_duration_sec: 90,
        extra: true,
      })
      .on(BURROW, 'storage_balance_of', { total: '250000000000000000000000', available: '1' });
    const client = new BurrowClient(viewer, BURROW);
    expect(await client.getConfig()).toMatchObject({
      oracleAccountId: ORACLE,
      maximumRecencyDurationSec: 90,
    });
    expect(await client.getStorageBalance(ALICE)).toEqual({
      total: 250_000_000_000_000_000_000_000n,
      available: 1n,
    });
    expect(
      await new BurrowClient(
        new ScriptedContractViewer().on(BURROW, 'storage_balance_of', null),
        BURROW,
      ).getStorageBalance(ALICE),
    ).toBeNull();
  });
});

describe('BurrowOracleClient', () => {
  const answer = (prices: unknown[], timestamp: unknown = '1760000000000000000') =>
    new ScriptedContractViewer().on(ORACLE, 'get_price_data', {
      timestamp,
      recency_duration_sec: 90,
      prices,
    });

  it('returns prices keyed by asset id and lists assets with no usable price', async () => {
    const viewer = answer([
      { asset_id: WNEAR, price: { multiplier: '50000', decimals: 28 } },
      { asset_id: USDT, price: null },
      { asset_id: 'zero.near', price: { multiplier: '0', decimals: 4 } },
    ]);
    const data = await new BurrowOracleClient(viewer, ORACLE).getPriceData([
      WNEAR,
      USDT,
      'zero.near',
      'missing.near',
      WNEAR,
    ]);
    expect(data.prices.get(WNEAR)).toEqual({ multiplier: 50_000n, decimals: 28 });
    expect([...data.unpriced].sort()).toEqual(['missing.near', USDT, 'zero.near'].sort());
    expect(data.blockTimestampNs).toBe(1_760_000_000_000_000_000n);
    expect(data.recencyDurationSec).toBe(90);
    expect(viewer.calls[0]?.args).toEqual({
      asset_ids: [WNEAR, USDT, 'zero.near', 'missing.near'],
    });
  });

  it('accepts EMA-suffixed asset ids and numeric timestamps', async () => {
    const data = await new BurrowOracleClient(
      answer(
        [{ asset_id: 'wrap.near#3600', price: { multiplier: '1', decimals: 1 } }],
        1_760_000_000_000_000_000,
      ),
      ORACLE,
    ).getPriceData(['wrap.near#3600']);
    expect(data.prices.has('wrap.near#3600')).toBe(true);
  });

  it('rejects a zero timestamp and malformed payloads', async () => {
    await expect(
      new BurrowOracleClient(answer([], '0'), ORACLE).getPriceData([WNEAR]),
    ).rejects.toThrow(UnexpectedResponseError);
    await expect(
      new BurrowOracleClient(
        new ScriptedContractViewer().on(ORACLE, 'get_price_data', { prices: [] }),
        ORACLE,
      ).getPriceData([WNEAR]),
    ).rejects.toThrow(UnexpectedResponseError);
  });
});
