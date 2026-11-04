import { accountId, type AccountId, type JsonRpcCaller } from '@near-autopilot/core';
import { FixedClock, ScriptedContractViewer } from '@near-autopilot/core/testing';
import { BurrowClient, BurrowVerifier, type BurrowVerifierOptions } from '../../src';

/**
 * SYNTHETIC fixtures. Shapes follow the contract source (burrowland v0.7.0 views); the numbers are invented
 * and the account ids are only labels. Nothing here claims anything about what is deployed on a live chain.
 */
export const BURROW = accountId('contract.main.burrow.near');
export const BURROW_BETA = accountId('contract.beta.burrow.near');
export const BURROW_TESTNET = accountId('contract.1638481328.burrow.testnet');
export const ORACLE = accountId('priceoracle.near');
export const ALICE = accountId('alice.near');
export const WNEAR = accountId('wrap.near');
export const USDT = accountId('usdt.tether-token.near');

function leb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
  return out;
}

/** A tiny structurally valid WASM module whose export section lists exactly these functions. */
export function wasmWithExports(names: readonly string[]): Uint8Array {
  const entries: number[] = [];
  for (const [i, name] of names.entries()) {
    const bytes = [...new TextEncoder().encode(name)];
    entries.push(...leb(bytes.length), ...bytes, 0, ...leb(i));
  }
  const body = [...leb(names.length), ...entries];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    0x07,
    ...leb(body.length),
    ...body,
  ]);
}

export const BURROW_FUNCTIONS = [
  'get_account',
  'get_asset',
  'get_assets_paged_detailed',
  'get_config',
  'storage_balance_of',
  'execute',
  'ft_on_transfer',
  'oracle_on_call',
  'new',
];
export const ORACLE_FUNCTIONS = ['get_price_data', 'oracle_call', 'report_prices'];
export const TOKEN_FUNCTIONS = ['ft_transfer_call', 'ft_balance_of', 'ft_transfer'];

/** Fake JSON-RPC node: `status` reports a chain id; `view_code` serves per-account WASM. Records every call. */
export class FakeRpc implements JsonRpcCaller {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly codes = new Map<string, { bytes: Uint8Array; hash: string }>();

  constructor(public chainId = 'mainnet') {}

  deploy(account: AccountId, functions: readonly string[], hash = `hash-${account}`): this {
    this.codes.set(account, { bytes: wasmWithExports(functions), hash });
    return this;
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  get codeLookups(): string[] {
    return this.calls
      .filter((c) => c.method === 'query')
      .map((c) => (c.params as { account_id: string }).account_id);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'status') return { chain_id: this.chainId, version: { version: 'fake' } };
    if (method === 'query') {
      const id = (params as { account_id: string }).account_id;
      const code = this.codes.get(id);
      if (!code) throw new Error(`no contract code at ${id}`);
      return { code_base64: Buffer.from(code.bytes).toString('base64'), hash: code.hash };
    }
    throw new Error(`unexpected rpc method ${method}`);
  }
}

export interface AssetFixture {
  readonly token: string;
  readonly extra: number;
  readonly vr: number;
  readonly canDeposit?: boolean;
  readonly canCollateral?: boolean;
  readonly canBorrow?: boolean;
}

export function assetView(a: AssetFixture): Record<string, unknown> {
  return {
    token_id: a.token,
    supplied: { shares: '1000', balance: '1000' },
    borrowed: { shares: '10', balance: '10' },
    reserved: '0',
    config: {
      reserve_ratio: 2500,
      target_utilization: 8000,
      volatility_ratio: a.vr,
      extra_decimals: a.extra,
      can_deposit: a.canDeposit ?? true,
      can_withdraw: true,
      can_use_as_collateral: a.canCollateral ?? true,
      can_borrow: a.canBorrow ?? true,
    },
    supply_apr: '0.02',
    borrow_apr: '0.05',
  };
}

/**
 * wNEAR: 24 decimals => extra_decimals 0. USDT: 6 decimals => extra_decimals 12, the example in the contract's own
 * doc comment (S: asset_config.rs), giving an 18-decimal inner balance. Synthetic: not read from any chain.
 */
export const ASSET_FIXTURES: Record<string, AssetFixture> = {
  [WNEAR]: { token: WNEAR, extra: 0, vr: 6000 },
  [USDT]: { token: USDT, extra: 12, vr: 8000 },
};

export const ONE_NEAR_INNER = 10n ** 24n;
export const ONE_USDT_INNER = 10n ** 6n * 10n ** 12n;

export interface World {
  readonly rpc: FakeRpc;
  readonly viewer: ScriptedContractViewer;
  readonly clock: FixedClock;
  readonly client: BurrowClient;
  readonly verifier: BurrowVerifier;
  account: unknown;
  assets: Record<string, AssetFixture>;
  oracleAccountId: string;
}

export const T0 = new Date('2026-11-04T12:00:00.000Z');

export function makeWorld(
  overrides: Partial<BurrowVerifierOptions> & { chainId?: string } = {},
): World {
  const { chainId, ...options } = overrides;
  const contractId = options.contractId ?? BURROW;
  const network = options.network ?? 'mainnet';
  const rpc = new FakeRpc(chainId ?? network)
    .deploy(contractId, BURROW_FUNCTIONS)
    .deploy(ORACLE, ORACLE_FUNCTIONS)
    .deploy(WNEAR, TOKEN_FUNCTIONS)
    .deploy(USDT, TOKEN_FUNCTIONS);
  const viewer = new ScriptedContractViewer();
  const world = {
    rpc,
    viewer,
    clock: new FixedClock(T0),
    account: null,
    assets: { ...ASSET_FIXTURES },
    oracleAccountId: ORACLE,
  } as World;
  viewer.onCall(contractId, 'get_config', () => ({
    oracle_account_id: world.oracleAccountId,
    owner_id: 'owner.near',
  }));
  viewer.onCall(contractId, 'get_asset', (args) => {
    const a = world.assets[String(args['token_id'])];
    return a ? assetView(a) : null;
  });
  viewer.onCall(contractId, 'get_account', () => world.account);
  const client = new BurrowClient(viewer, contractId);
  const verifier = new BurrowVerifier(
    { rpc, client, clock: world.clock },
    { network, contractId, expectedOracleId: ORACLE, ...options },
  );
  return Object.assign(world, { client, verifier });
}

/** `get_account` response: 100 NEAR collateral, 200 USDT debt, 5 USDT supplied-not-collateral. */
export function aliceAccount(
  overrides: { collateral?: unknown[]; borrowed?: unknown[]; supplied?: unknown[] } = {},
): unknown {
  return {
    account_id: 'alice.near',
    supplied: overrides.supplied ?? [
      { token_id: USDT, balance: (5n * ONE_USDT_INNER).toString(), shares: '1' },
    ],
    collateral: overrides.collateral ?? [
      { token_id: WNEAR, balance: (100n * ONE_NEAR_INNER).toString(), shares: '1' },
    ],
    borrowed: overrides.borrowed ?? [
      { token_id: USDT, balance: (200n * ONE_USDT_INNER).toString(), shares: '1', apr: '0.05' },
    ],
    farms: [],
  };
}
