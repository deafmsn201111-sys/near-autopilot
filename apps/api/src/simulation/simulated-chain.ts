import type { AccountId, Clock, Network } from '@near-autopilot/core';
import { demoAssets, type DemoAsset, type DemoPortfolio } from './demo-portfolios';

/**
 * In-process mock of the NEAR JSON-RPC endpoint, serving one SYNTHETIC demo portfolio.
 *
 * It is injected as the RPC client's `fetch`, so in simulation the production adapters, the Burrow deployment
 * verifier, the planners, the policy engine and the executor all run UNCHANGED against it: the simulation exercises
 * the real pipeline, only the chain is fake. It never opens a socket. It cannot accept a transaction: `send_tx` and
 * access-key queries are refused, so even a misconfigured live executor could not "succeed" against it.
 *
 * State: the demo amounts with the simulated ledger applied (demo-portfolios.ts): an action the agent carried out
 * as a dry run is reflected in the next read. No transaction exists; nothing here touches a chain.
 */
export interface SimulatedChainOptions {
  readonly network: Network;
  readonly accountId: AccountId;
  readonly burrowContractId: AccountId;
  readonly burrowOracleId: AccountId;
  readonly rheaContractId: AccountId;
  /** The portfolio, or a function returning its CURRENT state (the simulated ledger applied). */
  readonly portfolio: DemoPortfolio | (() => DemoPortfolio);
  readonly clock: Clock;
  /**
   * Other tokens the deployment tracks (its policy allowlist). They exist in the simulation with a zero balance, no
   * oracle price and no Burrow listing, so a snapshot over the full allowlist still works.
   */
  readonly otherTokens?: readonly AccountId[];
}

/** Exports the production verifiers look for (burrow-adapter constants), plus what the readers call. */
const BURROW_EXPORTS = [
  'get_account',
  'get_asset',
  'get_assets_paged_detailed',
  'get_config',
  'storage_balance_of',
  'execute',
  'ft_on_transfer',
  'oracle_on_call',
];
const ORACLE_EXPORTS = ['get_price_data', 'oracle_call'];
const TOKEN_EXPORTS = [
  'ft_transfer_call',
  'ft_balance_of',
  'ft_transfer',
  'ft_metadata',
  'storage_balance_of',
];
const RHEA_EXPORTS = ['get_return', 'get_pool', 'ft_on_transfer'];
/** Demo swap fee: 0.30%, applied to the oracle-implied output. */
const SWAP_FEE_BPS = 30n;

class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class SimulatedChain {
  private readonly assets: { near: DemoAsset; usdt: DemoAsset };
  private readonly codes: ReadonlyMap<string, readonly string[]>;
  /** Every JSON-RPC method received, for tests and for proving nothing was sent. */
  readonly methods: string[] = [];

  private pf(): DemoPortfolio {
    const p = this.options.portfolio;
    return typeof p === 'function' ? p() : p;
  }

  constructor(private readonly options: SimulatedChainOptions) {
    this.assets = demoAssets(options.network);
    this.codes = new Map<string, readonly string[]>([
      [options.burrowContractId, BURROW_EXPORTS],
      [options.burrowOracleId, ORACLE_EXPORTS],
      [options.rheaContractId, RHEA_EXPORTS],
      [this.assets.near.token, TOKEN_EXPORTS],
      [this.assets.usdt.token, TOKEN_EXPORTS],
      ...(options.otherTokens ?? []).map((t): [string, readonly string[]] => [t, TOKEN_EXPORTS]),
    ]);
    this.otherTokens = new Set(
      (options.otherTokens ?? []).filter(
        (t) => t !== this.assets.near.token && t !== this.assets.usdt.token,
      ),
    );
  }

  private readonly otherTokens: ReadonlySet<string>;

  /** The demo assets' token ids (the deployment's policy allowlist must contain them). */
  get tokens(): readonly AccountId[] {
    return [this.assets.near.token, this.assets.usdt.token];
  }

  /** Drop-in `fetch` for `NearRpcClient`. The URL is ignored: nothing leaves the process. */
  readonly fetch: typeof fetch = async (_input, init) => {
    let id: unknown = null;
    try {
      if (typeof init?.body !== 'string') throw new RpcFault(-32700, 'expected a JSON body');
      const request = JSON.parse(init.body) as { id?: unknown; method?: unknown; params?: unknown };
      id = request.id ?? null;
      const method = typeof request.method === 'string' ? request.method : '';
      this.methods.push(method);
      return json({ jsonrpc: '2.0', id, result: this.handle(method, request.params) });
    } catch (error) {
      const fault =
        error instanceof RpcFault ? error : new RpcFault(-32000, `simulation: ${String(error)}`);
      return json({
        jsonrpc: '2.0',
        id,
        error: { code: fault.code, name: 'HANDLER_ERROR', message: fault.message },
      });
    }
  };

  private handle(method: string, params: unknown): unknown {
    if (method === 'status')
      return { chain_id: this.options.network, version: { version: 'simulation' } };
    if (method !== 'query') {
      throw new RpcFault(-32601, `simulation does not accept "${method}" (nothing can be sent)`);
    }
    const p = record(params);
    const account = String(p['account_id']);
    switch (p['request_type']) {
      case 'view_account':
        if (account !== this.options.accountId)
          throw new RpcFault(-32000, `unknown account ${account}`);
        return {
          amount: this.pf().nativeYocto.toString(),
          locked: '0',
          storage_usage: 500,
          code_hash: '11111111111111111111111111111111',
        };
      case 'view_code': {
        const exports = this.codes.get(account);
        if (!exports) throw new RpcFault(-32000, `no contract code at ${account}`);
        return { code_base64: base64(wasmExporting(exports)), hash: `simulation-${account}` };
      }
      case 'call_function': {
        const encoded = typeof p['args_base64'] === 'string' ? p['args_base64'] : '';
        const text = Buffer.from(encoded, 'base64').toString('utf8');
        const args = record(text ? (JSON.parse(text) as unknown) : {});
        const value = this.view(account, String(p['method_name']), args);
        return { result: [...Buffer.from(JSON.stringify(value), 'utf8')], logs: [] };
      }
      default:
        throw new RpcFault(-32000, `simulation does not serve ${String(p['request_type'])}`);
    }
  }

  private view(contract: string, method: string, args: Record<string, unknown>): unknown {
    const o = this.options;
    const { near, usdt } = this.assets;
    const pf = this.pf();
    const assetFor = (token: unknown): DemoAsset | undefined =>
      token === near.token ? near : token === usdt.token ? usdt : undefined;

    if (contract === o.burrowContractId) {
      switch (method) {
        case 'get_config':
          return { oracle_account_id: o.burrowOracleId, owner_id: o.burrowContractId };
        case 'get_asset': {
          const a = assetFor(args['token_id']);
          return a ? assetView(a) : null;
        }
        case 'get_assets_paged_detailed':
          return [near, usdt].map(assetView);
        case 'get_account': {
          if (args['account_id'] !== o.accountId) return null;
          const inner = (a: DemoAsset, raw: bigint) => ({
            token_id: a.token,
            balance: (raw * 10n ** BigInt(a.extraDecimals)).toString(),
            shares: (raw * 10n ** BigInt(a.extraDecimals)).toString(),
          });
          return {
            account_id: o.accountId,
            supplied: [
              ...(pf.supplied.usdt > 0n ? [inner(usdt, pf.supplied.usdt)] : []),
              ...((pf.supplied.near ?? 0n) > 0n ? [inner(near, pf.supplied.near ?? 0n)] : []),
            ],
            collateral: [inner(near, pf.collateral.near)],
            borrowed: [{ ...inner(usdt, pf.borrowed.usdt), apr: '0.05' }],
            farms: [],
          };
        }
        case 'storage_balance_of':
          return { total: '250000000000000000000000', available: '0' };
      }
    }
    if (contract === o.burrowOracleId && method === 'get_price_data') {
      const ids = Array.isArray(args['asset_ids']) ? args['asset_ids'] : [];
      return {
        timestamp: (BigInt(o.clock.now().getTime()) * 1_000_000n).toString(),
        recency_duration_sec: 90,
        prices: ids.map((assetId) => {
          const a = assetFor(assetId);
          return {
            asset_id: String(assetId),
            price: a
              ? { multiplier: a.priceMultiplier.toString(), decimals: a.priceDecimals }
              : null,
          };
        }),
      };
    }
    if (contract === o.rheaContractId && method === 'get_return') {
      const tin = assetFor(args['token_in']);
      const tout = assetFor(args['token_out']);
      if (!tin || !tout) return '0';
      const amountIn = BigInt(String(args['amount_in']));
      // amountIn x priceIn = amountOut x priceOut, less the demo fee.
      const out =
        (amountIn *
          tin.priceMultiplier *
          10n ** BigInt(tout.priceDecimals) *
          (10_000n - SWAP_FEE_BPS)) /
        (tout.priceMultiplier * 10n ** BigInt(tin.priceDecimals) * 10_000n);
      return out.toString();
    }
    const token = assetFor(contract);
    if (token) {
      switch (method) {
        case 'ft_balance_of':
          if (args['account_id'] !== o.accountId) return '0';
          return (token === near ? pf.wallet.near : pf.wallet.usdt).toString();
        case 'ft_metadata':
          return {
            spec: 'ft-1.0.0',
            name: `${token.symbol} (simulated)`,
            symbol: token.symbol,
            decimals: token.decimals,
          };
        case 'storage_balance_of':
          return { total: '1250000000000000000000', available: '0' };
      }
    }
    if (this.otherTokens.has(contract)) {
      switch (method) {
        case 'ft_balance_of':
          return '0';
        case 'ft_metadata':
          return {
            spec: 'ft-1.0.0',
            name: `${contract} (simulated, empty)`,
            symbol: contract.split('.')[0],
            decimals: 18,
          };
        case 'storage_balance_of':
          return { total: '1250000000000000000000', available: '0' };
      }
    }
    throw new RpcFault(-32000, `simulation has no view ${contract}#${method}`);
  }
}

function assetView(a: DemoAsset): Record<string, unknown> {
  return {
    token_id: a.token,
    supplied: { shares: '0', balance: '0' },
    borrowed: { shares: '0', balance: '0' },
    reserved: '0',
    config: {
      reserve_ratio: 2500,
      target_utilization: 8000,
      volatility_ratio: a.volatilityRatioBps,
      extra_decimals: a.extraDecimals,
      can_deposit: true,
      can_withdraw: true,
      can_use_as_collateral: true,
      can_borrow: true,
    },
    supply_apr: '0.02',
    borrow_apr: '0.05',
  };
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function leb128(n: number): number[] {
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

/** Smallest structurally valid WASM module whose export section lists `names` as functions. */
function wasmExporting(names: readonly string[]): Uint8Array {
  const entries: number[] = [];
  for (const [i, name] of names.entries()) {
    const bytes = [...new TextEncoder().encode(name)];
    entries.push(...leb128(bytes.length), ...bytes, 0x00, ...leb128(i));
  }
  const body = [...leb128(names.length), ...entries];
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
    ...leb128(body.length),
    ...body,
  ]);
}
