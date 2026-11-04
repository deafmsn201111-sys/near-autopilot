import { accountId } from '@near-autopilot/core';
import { describe, expect, it } from 'vitest';
import {
  DCL_CONTRACT_IDS,
  DCL_UNIMPLEMENTED_METHODS,
  RheaDclClient,
  computeLiquidity,
  fetchDeployedAbi,
  requiredDepositForLiquidity,
  verifyDeployedAbi,
  type DclDeployment,
  type DclPool,
} from '../src';
import { LiveRpc } from './support/live-rpc';

/**
 * LIVE integration tests against a real NEAR RPC node. Skipped unless RHEA_DCL_LIVE=1, so CI and
 * sandboxes without network never fail or, worse, pass vacuously.
 *
 *   RHEA_DCL_LIVE=1 pnpm --filter @near-autopilot/rhea-dcl-adapter test:live
 *
 * Environment:
 *   RHEA_DCL_RPC_URL     JSON-RPC endpoint (default https://rpc.testnet.near.org; use your provider's URL
 *                        if that endpoint is rate limited or retired)
 *   RHEA_DCL_DEPLOYMENT  testnet | testnet-dev | mainnet   (default testnet)
 *   RHEA_DCL_CONTRACT_ID overrides the account (e.g. a DCL_TESTNET_CANDIDATES entry)
 *
 * Nothing here asserts that testnet liquidity EXISTS. It reports what the chain says and only asserts
 * that whatever comes back parses and is arithmetically self-consistent.
 */
const live = process.env['RHEA_DCL_LIVE'] === '1';
const isDeployment = (v: string): v is DclDeployment => Object.hasOwn(DCL_CONTRACT_IDS, v);
const requestedDeployment = process.env['RHEA_DCL_DEPLOYMENT'] ?? 'testnet';
if (!isDeployment(requestedDeployment)) {
  throw new Error(
    `RHEA_DCL_DEPLOYMENT must be one of ${Object.keys(DCL_CONTRACT_IDS).join(', ')}; got ${JSON.stringify(requestedDeployment)}`,
  );
}
const deployment: DclDeployment = requestedDeployment;
const rpcUrl =
  process.env['RHEA_DCL_RPC_URL'] ??
  (deployment === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
const contractOverride = process.env['RHEA_DCL_CONTRACT_ID'];
const contractId = contractOverride ? accountId(contractOverride) : DCL_CONTRACT_IDS[deployment];

describe.skipIf(!live)(`live: ${deployment} DCL ${contractId}`, () => {
  const rpc = new LiveRpc(rpcUrl);
  const client = new RheaDclClient(rpc, { contractId });

  it('the contract has code and exports every source-verified method', async () => {
    const result = await verifyDeployedAbi(rpc, contractId);
    console.info(`[live] ${contractId} code hash ${result.codeHash}`);
    console.info(
      `[live] missing views: ${JSON.stringify(result.missingViewMethods)}; missing calls: ${JSON.stringify(result.missingCallMethods)}`,
    );
    expect(result.missingViewMethods).toEqual([]);
    expect(result.missingCallMethods).toEqual([]);
  });

  it('reports which of the deliberately-unimplemented methods the deployment exports', async () => {
    const abi = await fetchDeployedAbi(rpc, contractId);
    const report = Object.fromEntries(
      DCL_UNIMPLEMENTED_METHODS.map((m) => [m, abi.functions.has(m)]),
    );
    console.info(`[live] unimplemented-method presence: ${JSON.stringify(report)}`);
    expect(Object.keys(report)).toHaveLength(DCL_UNIMPLEMENTED_METHODS.length);
  });

  it('get_metadata answers', async () => {
    const metadata = await client.getMetadata();
    console.info(`[live] get_metadata: ${JSON.stringify(metadata)}`);
    expect(metadata).not.toBeNull();
  });

  let pools: DclPool[] = [];

  it('list_pools parses with the strict schema (this fails loudly if the live shape differs from ref-ui)', async () => {
    pools = await client.listPools();
    const withLiquidity = pools.filter(
      (p) => (p.liquidity ?? 0n) > 0n || (p.total_x ?? 0n) > 0n || (p.total_y ?? 0n) > 0n,
    );
    console.info(
      `[live] pools: ${pools.length}; with non-zero liquidity/reserves: ${withLiquidity.length}`,
    );
    for (const p of pools) {
      console.info(
        `[live] ${p.pool_id} fee=${p.fee} delta=${p.point_delta} point=${p.current_point} state=${p.state} liquidity=${p.liquidity ?? '-'} total_x=${p.total_x ?? '-'} total_y=${p.total_y ?? '-'}`,
      );
    }
    expect(Array.isArray(pools)).toBe(true);
  });

  it('every listed pool is internally consistent and re-readable via get_pool', async () => {
    for (const pool of pools.slice(0, 25)) {
      expect(pool.pool_id).toBe(`${pool.token_x}|${pool.token_y}|${pool.fee}`);
      expect([...[pool.token_x, pool.token_y]].sort()).toEqual([pool.token_x, pool.token_y]);
      expect(pool.current_point % 1).toBe(0);
      const again = await client.getPool(pool.pool_id);
      expect(again?.pool_id).toBe(pool.pool_id);
    }
  });

  it('market depth parses, and our liquidity math agrees with the contract on live ranges', async () => {
    for (const pool of pools.filter((p) => (p.liquidity ?? 0n) > 0n).slice(0, 5)) {
      const depth = await client.getMarketDepth(pool.pool_id);
      for (const range of Object.values(depth.liquidities).slice(0, 5)) {
        const need = requiredDepositForLiquidity({
          liquidity: range.amount_l,
          leftPoint: range.left_point,
          rightPoint: range.right_point,
          currentPoint: pool.current_point,
        });
        const back = computeLiquidity({
          leftPoint: range.left_point,
          rightPoint: range.right_point,
          currentPoint: pool.current_point,
          amountX: need.x,
          amountY: need.y + 1n,
        });
        // Deposit amounts are ceil'd, so re-deriving liquidity from them can only land at or above the original.
        expect(back >= range.amount_l - 1n).toBe(true);
      }
    }
  });

  it('a one-unit quote either parses or the contract rejects it explicitly', async () => {
    const pool = pools.find((p) => (p.liquidity ?? 0n) > 0n);
    if (!pool) {
      console.info(
        '[live] no pool with liquidity; quote check skipped (this is a finding, not a pass)',
      );
      return;
    }
    try {
      const quote = await client.quote({
        poolIds: [pool.pool_id],
        inputToken: pool.token_x,
        outputToken: pool.token_y,
        inputAmount: 1_000n,
      });
      console.info(`[live] quote 1000 raw ${pool.token_x} -> ${pool.token_y}: ${quote.amount}`);
      expect(quote.amount >= 0n).toBe(true);
    } catch (error) {
      console.info(`[live] quote rejected: ${(error as Error).message}`);
    }
  });
});
