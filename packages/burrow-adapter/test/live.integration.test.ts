import { accountId, type AccountId, type Network } from '@near-autopilot/core';
import { describe, expect, it } from 'vitest';
import {
  BURROW_DEPLOYMENTS,
  BurrowClient,
  BurrowOracleClient,
  BurrowVerifier,
  type BurrowDeploymentId,
} from '../src';
import { LiveRpc } from './support/live-rpc';

/**
 * LIVE read-only integration tests against a real NEAR RPC node. Skipped unless BURROW_LIVE=1, so CI and
 * sandboxes without network never fail, or pass vacuously.
 *
 *   BURROW_LIVE=1 pnpm --filter @near-autopilot/burrow-adapter test:live
 *
 *   BURROW_RPC_URL     JSON-RPC endpoint (default https://rpc.testnet.near.org, or the mainnet one for mainnet)
 *   BURROW_DEPLOYMENT  testnet | mainnet | mainnet-beta     (default testnet)
 *   BURROW_CONTRACT_ID override the Burrow account (then the deployment's network is still used for the chain check
 *                      and the contract is treated as an unlisted fork)
 *
 * These tests only READ. They hold no keys, sign nothing and send no transactions, and no signing key is read
 * from the environment. Nothing asserts that markets, positions or liquidity EXIST on a chain; they report what
 * the chain says and assert only that it parses and is self-consistent. Failing here on testnet is itself a
 * finding: it means the testnet deployment is missing, retired, or differs from the documented interface.
 */
const live = process.env['BURROW_LIVE'] === '1';
const deploymentId = (process.env['BURROW_DEPLOYMENT'] ?? 'testnet') as BurrowDeploymentId;
const info = BURROW_DEPLOYMENTS[deploymentId];
const network: Network = info.network;
const rpcUrl =
  process.env['BURROW_RPC_URL'] ??
  (network === 'mainnet' ? 'https://rpc.mainnet.near.org' : 'https://rpc.testnet.near.org');
const override = process.env['BURROW_CONTRACT_ID'];
const contractId: AccountId = override ? accountId(override) : info.contractId;

describe.skipIf(!live)(`live: Burrow ${deploymentId} ${contractId}`, () => {
  const rpc = new LiveRpc(rpcUrl);
  const client = new BurrowClient(rpc, contractId);
  const verifier = new BurrowVerifier(
    { rpc, client, clock: { now: () => new Date() } },
    { network, contractId, allowUnlistedContract: Boolean(override) },
  );

  it('the RPC node, the Burrow contract and its oracle pass deployment verification', async () => {
    const proof = await verifier.verifyDeployment();
    console.info(
      `[live] chain ${proof.chainId}; burrow ${proof.contractId} code ${proof.contractCodeHash}; oracle ${proof.oracleId} code ${proof.oracleCodeHash}`,
    );
    expect(proof.network).toBe(network);
  });

  it('lists assets that parse, with sane parameters', async () => {
    const assets = await client.listAssets();
    console.info(
      `[live] ${assets.length} assets: ${assets.map((a) => `${a.tokenId}(vr=${a.volatilityRatioBps},xd=${a.extraDecimals})`).join(', ')}`,
    );
    for (const a of assets) {
      expect(a.volatilityRatioBps).toBeLessThanOrEqual(10_000);
      expect(a.extraDecimals).toBeGreaterThanOrEqual(0);
    }
  });

  it('the oracle answers get_price_data for the listed assets (some may legitimately be unpriced)', async () => {
    const proof = await verifier.verifyDeployment();
    const assets = await client.listAssets();
    if (assets.length === 0) return;
    const data = await new BurrowOracleClient(rpc, proof.oracleId).getPriceData(
      assets.slice(0, 10).map((a) => a.tokenId),
    );
    console.info(
      `[live] priced ${data.prices.size}, unpriced ${JSON.stringify(data.unpriced)}, recency ${data.recencyDurationSec}s`,
    );
    expect(data.blockTimestampNs).toBeGreaterThan(0n);
  });

  it('an arbitrary account is either unregistered or parses', async () => {
    const account = await client.getAccount(
      accountId(
        process.env['BURROW_ACCOUNT_ID'] ?? 'burrow-autopilot-probe.invalid-but-wellformed.near',
      ),
    );
    console.info(`[live] probe account registered: ${account !== null}`);
    expect(account === null || Array.isArray(account.collateral)).toBe(true);
  });
});
