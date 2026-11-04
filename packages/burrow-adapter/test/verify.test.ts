import { describe, expect, it } from 'vitest';
import { accountId, NetworkMismatchError, UnexpectedResponseError } from '@near-autopilot/core';
import { BurrowVerificationError, BurrowVerifier, BURROW_DEPLOYMENTS } from '../src';
import {
  BURROW,
  BURROW_BETA,
  BURROW_FUNCTIONS,
  BURROW_TESTNET,
  makeWorld,
  ORACLE,
  ORACLE_FUNCTIONS,
  T0,
  TOKEN_FUNCTIONS,
  USDT,
  WNEAR,
} from './support/fixtures';

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof BurrowVerificationError) return e.reason;
    throw e;
  }
  throw new Error('expected a BurrowVerificationError');
}

describe('BurrowVerifier.verifyDeployment', () => {
  it('checks the chain id BEFORE looking at any deployed code, then Burrow, then the oracle Burrow reports', async () => {
    const w = makeWorld();
    const proof = await w.verifier.verifyDeployment();
    expect(w.rpc.methods[0]).toBe('status');
    expect(w.rpc.codeLookups).toEqual([BURROW, ORACLE]);
    expect(proof).toMatchObject({
      network: 'mainnet',
      chainId: 'mainnet',
      contractId: BURROW,
      oracleId: ORACLE,
      contractCodeHash: `hash-${BURROW}`,
      oracleCodeHash: `hash-${ORACLE}`,
    });
    expect(proof.expiresAt.getTime() - proof.verifiedAt.getTime()).toBe(300_000);
  });

  it('refuses a node on the wrong chain and looks at no code', async () => {
    const w = makeWorld({ chainId: 'testnet', network: 'mainnet' });
    await expect(w.verifier.verifyDeployment()).rejects.toThrow(NetworkMismatchError);
    expect(w.rpc.codeLookups).toEqual([]);
    expect(w.viewer.calls).toEqual([]);
  });

  it('refuses a contract that is not a known deployment of that network, with no RPC traffic at all', async () => {
    const evil = accountId('contract.main.burrow.evil.near');
    const w = makeWorld({ contractId: evil });
    expect(await reasonOf(w.verifier.verifyDeployment())).toBe('UNLISTED_CONTRACT');
    expect(w.rpc.calls).toEqual([]);
  });

  it('refuses a mainnet Burrow account configured for testnet (listing is per network)', async () => {
    const w = makeWorld({ network: 'testnet', contractId: BURROW });
    expect(await reasonOf(w.verifier.verifyDeployment())).toBe('UNLISTED_CONTRACT');
  });

  it('allows an unlisted contract only when explicitly opted in, still running every other check', async () => {
    const fork = accountId('burrow.fork.near');
    const w = makeWorld({ contractId: fork, allowUnlistedContract: true });
    expect(await w.verifier.verifyDeployment()).toMatchObject({ contractId: fork });
    const bad = makeWorld({ contractId: fork, allowUnlistedContract: true });
    bad.rpc.deploy(fork, ['get_account']);
    expect(await reasonOf(bad.verifier.verifyDeployment())).toBe('MISSING_EXPORTS');
  });

  it('accepts the testnet entry on testnet', async () => {
    const w = makeWorld({ network: 'testnet', contractId: BURROW_TESTNET });
    expect(await w.verifier.verifyDeployment()).toMatchObject({
      network: 'testnet',
      contractId: BURROW_TESTNET,
    });
  });

  it('lists exactly the documented deployments', () => {
    expect(Object.values(BURROW_DEPLOYMENTS).map((d) => `${d.network}:${d.contractId}`)).toEqual([
      `mainnet:${BURROW}`,
      `mainnet:${BURROW_BETA}`,
      `testnet:${BURROW_TESTNET}`,
    ]);
  });

  it('names the missing Burrow exports', async () => {
    const w = makeWorld();
    w.rpc.deploy(
      BURROW,
      BURROW_FUNCTIONS.filter((f) => f !== 'ft_on_transfer'),
    );
    await expect(w.verifier.verifyDeployment()).rejects.toThrow('ft_on_transfer');
  });

  it('refuses when Burrow is configured with a different oracle than expected, before touching that oracle', async () => {
    const w = makeWorld();
    w.oracleAccountId = 'other-oracle.near';
    expect(await reasonOf(w.verifier.verifyDeployment())).toBe('ORACLE_MISMATCH');
    expect(w.rpc.codeLookups).toEqual([BURROW]);
  });

  it('refuses an oracle that lacks get_price_data', async () => {
    const w = makeWorld();
    w.rpc.deploy(
      ORACLE,
      ORACLE_FUNCTIONS.filter((f) => f !== 'get_price_data'),
    );
    await expect(w.verifier.verifyDeployment()).rejects.toThrow('get_price_data');
  });

  it('enforces code-hash allowlists for Burrow and for the oracle', async () => {
    const ok = makeWorld({
      allowedCodeHashes: { burrow: [`hash-${BURROW}`], oracle: [`hash-${ORACLE}`] },
    });
    expect(await ok.verifier.verifyDeployment()).toBeDefined();
    const badBurrow = makeWorld({ allowedCodeHashes: { burrow: ['something-else'] } });
    expect(await reasonOf(badBurrow.verifier.verifyDeployment())).toBe('CODE_HASH_NOT_ALLOWED');
    const badOracle = makeWorld({ allowedCodeHashes: { oracle: ['something-else'] } });
    expect(await reasonOf(badOracle.verifier.verifyDeployment())).toBe('CODE_HASH_NOT_ALLOWED');
  });

  it('fails closed on a malformed get_config', async () => {
    const w = makeWorld();
    w.viewer.on(BURROW, 'get_config', { owner_id: 'owner.near' });
    await expect(w.verifier.verifyDeployment()).rejects.toThrow(UnexpectedResponseError);
  });

  it('fails when the contract has no code at all', async () => {
    const w = makeWorld({ contractId: BURROW_BETA });
    w.rpc.deploy(BURROW_BETA, BURROW_FUNCTIONS);
    const empty = makeWorld();
    empty.rpc.deploy(BURROW, []);
    await expect(empty.verifier.verifyDeployment()).rejects.toThrow();
  });

  it('caches within the TTL, re-verifies after it, and de-duplicates concurrent verifications', async () => {
    const w = makeWorld({ ttlMs: 60_000 });
    const [a, b] = await Promise.all([
      w.verifier.verifyDeployment(),
      w.verifier.verifyDeployment(),
    ]);
    expect(a).toBe(b);
    expect(w.rpc.methods.filter((m) => m === 'status')).toHaveLength(1);
    w.clock.advanceSeconds(59);
    await w.verifier.verifyDeployment();
    expect(w.rpc.methods.filter((m) => m === 'status')).toHaveLength(1);
    w.clock.advanceSeconds(2);
    const c = await w.verifier.verifyDeployment();
    expect(w.rpc.methods.filter((m) => m === 'status')).toHaveLength(2);
    expect(c.verifiedAt.getTime()).toBe(T0.getTime() + 61_000);
  });

  it('does not cache a failure', async () => {
    const w = makeWorld();
    w.oracleAccountId = 'other-oracle.near';
    await expect(w.verifier.verifyDeployment()).rejects.toThrow();
    w.oracleAccountId = ORACLE;
    expect(await w.verifier.verifyDeployment()).toBeDefined();
  });

  it('refuses a client that points at a different contract than the verifier', () => {
    const a = makeWorld();
    expect(
      () =>
        new BurrowVerifier(
          { rpc: a.rpc, client: a.client, clock: a.clock },
          { network: 'mainnet', contractId: BURROW_BETA },
        ),
    ).toThrow(BurrowVerificationError);
  });
});

describe('BurrowVerifier.verifyToken', () => {
  it('proves the token is listed, depositable and a fungible token, and carries extra_decimals', async () => {
    const w = makeWorld();
    const d = await w.verifier.verifyDeployment();
    const t = await w.verifier.verifyToken(d, USDT, 'repay');
    expect(t).toMatchObject({
      tokenId: USDT,
      burrowContractId: BURROW,
      purpose: 'repay',
      extraDecimals: 12,
      tokenCodeHash: `hash-${USDT}`,
    });
    expect(t.expiresAt.getTime()).toBeLessThanOrEqual(d.expiresAt.getTime());
  });

  it('refuses unlisted tokens', async () => {
    const w = makeWorld();
    const d = await w.verifier.verifyDeployment();
    expect(await reasonOf(w.verifier.verifyToken(d, accountId('scam.near'), 'supply'))).toBe(
      'TOKEN_NOT_LISTED',
    );
  });

  it('refuses tokens whose deposits are disabled', async () => {
    const w = makeWorld();
    w.assets[USDT] = { ...w.assets[USDT]!, canDeposit: false };
    const d = await w.verifier.verifyDeployment();
    expect(await reasonOf(w.verifier.verifyToken(d, USDT, 'repay'))).toBe('TOKEN_NOT_ACCEPTED');
  });

  it('requires can_use_as_collateral only for the collateral purpose', async () => {
    const w = makeWorld();
    w.assets[USDT] = { ...w.assets[USDT]!, canCollateral: false };
    const d = await w.verifier.verifyDeployment();
    expect(await reasonOf(w.verifier.verifyToken(d, USDT, 'collateral'))).toBe(
      'TOKEN_NOT_ACCEPTED',
    );
    expect(await w.verifier.verifyToken(d, USDT, 'supply')).toBeDefined();
  });

  it('refuses a token that does not export ft_transfer_call', async () => {
    const w = makeWorld();
    w.rpc.deploy(
      WNEAR,
      TOKEN_FUNCTIONS.filter((f) => f !== 'ft_transfer_call'),
    );
    const d = await w.verifier.verifyDeployment();
    await expect(w.verifier.verifyToken(d, WNEAR, 'supply')).rejects.toThrow('ft_transfer_call');
  });

  it('refuses to treat Burrow itself or its oracle as a token', async () => {
    const w = makeWorld();
    const d = await w.verifier.verifyDeployment();
    expect(await reasonOf(w.verifier.verifyToken(d, BURROW, 'supply'))).toBe('RESERVED_ACCOUNT');
    expect(await reasonOf(w.verifier.verifyToken(d, ORACLE, 'supply'))).toBe('RESERVED_ACCOUNT');
  });

  it('enforces the token code-hash allowlist', async () => {
    const w = makeWorld({ allowedCodeHashes: { tokens: [`hash-${WNEAR}`] } });
    const d = await w.verifier.verifyDeployment();
    expect(await w.verifier.verifyToken(d, WNEAR, 'supply')).toBeDefined();
    expect(await reasonOf(w.verifier.verifyToken(d, USDT, 'supply'))).toBe('CODE_HASH_NOT_ALLOWED');
  });

  it('refuses an expired deployment proof and a proof from another contract', async () => {
    const w = makeWorld({ ttlMs: 1_000 });
    const d = await w.verifier.verifyDeployment();
    w.clock.advanceSeconds(2);
    expect(await reasonOf(w.verifier.verifyToken(d, USDT, 'repay'))).toBe('EXPIRED');

    const beta = makeWorld({ contractId: BURROW_BETA });
    const betaProof = await beta.verifier.verifyDeployment();
    const main = makeWorld();
    expect(await reasonOf(main.verifier.verifyToken(betaProof, USDT, 'repay'))).toBe(
      'WRONG_DEPLOYMENT',
    );
  });

  it('serves repeat verifications from cache without new RPC calls', async () => {
    const w = makeWorld();
    const d = await w.verifier.verifyDeployment();
    await w.verifier.verifyToken(d, USDT, 'repay');
    const before = w.rpc.calls.length;
    await w.verifier.verifyToken(d, USDT, 'repay');
    expect(w.rpc.calls.length).toBe(before);
  });
});
