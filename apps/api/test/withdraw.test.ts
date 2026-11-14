import { describe, expect, it } from 'vitest';
import { accountId, type PlannedTransaction } from '@near-autopilot/core';
import type { NearRpcClient } from '@near-autopilot/near-adapter';
import {
  withdrawLookup,
  type DepositDeps,
  type StoredDepositQuote,
} from '../src/analytics/deposit';
import { buildAnalyticsServer } from '../src/analytics/server';
import type { CollectorStore } from '../src/collector/store';
import type {
  DepositQuote,
  DepositQuoteRequest,
  OneClickToken,
  SwapStatus,
  SwapStatusReport,
} from '../src/gateway/one-click-deposit';
import { validateCascade } from '../src/wallet/validate-cascade';
import { buildWithdrawTransfer } from '../src/wallet/withdraw';

const NOW = new Date('2026-11-14T10:00:00Z');
const API_TOKEN = 'withdraw-token-withdraw-token-withdraw-1';
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const BASE_USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const BTC = 'nep141:btc.omft.near';
const DEPOSIT = '90fda5d81a9f4cb725fc777bd339c089069e16afb180b4b350a5151544b0cbff';
const RECIPIENT = '0x52908400098527886E0F7030069857D2E4169EE7';
const ALICE = 'alice.near';
const TOKENS: OneClickToken[] = [
  {
    assetId: BASE_USDC,
    decimals: 6,
    blockchain: 'base',
    symbol: 'USDC',
    contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  },
  { assetId: BTC, decimals: 8, blockchain: 'btc', symbol: 'BTC' },
  {
    assetId: `nep141:${USDC}`,
    decimals: 6,
    blockchain: 'near',
    symbol: 'USDC',
    contractAddress: USDC,
  },
  {
    assetId: 'nep141:aurora',
    decimals: 18,
    blockchain: 'near',
    symbol: 'AURORA',
    contractAddress: 'aurora',
  },
];

const quoted = (over: Partial<DepositQuote> = {}): DepositQuote => ({
  depositAddress: DEPOSIT,
  deadline: new Date('2026-11-14T10:10:00Z'),
  amountIn: 1_000_000n,
  amountOut: 997_398n,
  minAmountOut: 987_424n,
  amountOutUsd: '0.99',
  timeEstimateSeconds: 22,
  appFeeBps: 1,
  correlationId: 'c0ffee',
  signature: 'ed25519:sig',
  ...over,
});

const stored = (over: Partial<StoredDepositQuote> = {}): StoredDepositQuote => ({
  id: 'wq_1',
  createdAt: NOW,
  accountId: ALICE,
  originAsset: `nep141:${USDC}`,
  destinationAsset: BASE_USDC,
  amountIn: '1000000',
  amountOut: '997398',
  minAmountOut: '987424',
  refundTo: ALICE,
  depositAddress: DEPOSIT,
  deadline: new Date('2026-11-14T10:10:00Z'),
  correlationId: 'c0ffee',
  signature: 'ed25519:sig',
  feeBps: 1,
  ...over,
});

const report = (status: SwapStatus): SwapStatusReport => ({
  status,
  depositedAmount: null,
  amountOut: null,
  refundedAmount: null,
  refundReason: null,
  nearTxHash: null,
});

function depositDeps(
  o: {
    quote?: () => Promise<DepositQuote>;
    row?: (StoredDepositQuote & { status: string | null }) | null;
    status?: SwapStatus | 'throw';
  } = {},
) {
  const saved: StoredDepositQuote[] = [];
  const asked: DepositQuoteRequest[] = [];
  const issued = new Set<string>();
  const deps: DepositDeps = {
    oneClick: {
      tokens: async () => TOKENS,
      quote: async (r) => {
        asked.push(r);
        return (o.quote ?? (async () => quoted()))();
      },
      status: async () => {
        if (o.status === 'throw') throw new Error('1Click down');
        return report(o.status ?? 'PENDING_DEPOSIT');
      },
    },
    store: {
      save: async (q) => void saved.push(q),
      purge: async () => undefined,
      find: async () => (o.row === undefined ? { ...stored(), status: null } : o.row),
      saveStatus: async () => undefined,
      unfinished: async () => [],
      issueTransfer: async (id) => !issued.has(id) && Boolean(issued.add(id)),
    },
    destinationTokens: [USDC, 'wrap.near'],
    newId: () => 'wq_1',
  };
  return { deps, saved, asked };
}

describe('validateCascade — ft_transfer', () => {
  const tx = (args: Record<string, unknown>, deposit = 1n): PlannedTransaction[] => [
    {
      intentId: 'withdraw',
      signerId: accountId(ALICE),
      receiverId: accountId(USDC),
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer',
          args,
          gas: 30_000_000_000_000n,
          deposit,
        },
      ],
    },
  ];
  const ctx = { signerId: ALICE, allowedReceivers: new Set([USDC]), transferTo: DEPOSIT };

  it('passes a 1-yocto transfer to the quoted deposit address', () => {
    expect(validateCascade(tx({ receiver_id: DEPOSIT, amount: '1000000' }), ctx).ok).toBe(true);
  });

  it('refuses ft_transfer in any cascade that names no transfer receiver', () => {
    const r = validateCascade(tx({ receiver_id: DEPOSIT, amount: '1' }), {
      signerId: ALICE,
      allowedReceivers: new Set([USDC, DEPOSIT]),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/unexpected receiver/);
  });

  it('refuses another receiver, a bad amount and a deposit other than 1 yocto', () => {
    expect(validateCascade(tx({ receiver_id: 'bob.near', amount: '1' }), ctx).ok).toBe(false);
    expect(validateCascade(tx({ receiver_id: DEPOSIT, amount: '0' }), ctx).ok).toBe(false);
    expect(validateCascade(tx({ receiver_id: DEPOSIT, amount: '1.5' }), ctx).ok).toBe(false);
    expect(validateCascade(tx({ receiver_id: DEPOSIT, amount: '1' }, 2n), ctx).ok).toBe(false);
  });
});

describe('buildWithdrawTransfer', () => {
  it('registers the deposit address on the token, then transfers, in one transaction', () => {
    const step = buildWithdrawTransfer({
      token: accountId(USDC),
      receiver: DEPOSIT,
      amount: 1_000_000n,
      storageDeposit: 1_250_000_000_000_000_000_000n,
      preview: 'Send 1 USDC',
    });
    expect(step.tx.receiverId).toBe(USDC);
    expect(step.tx.actions).toEqual([
      {
        type: 'FunctionCall',
        methodName: 'storage_deposit',
        args: { account_id: DEPOSIT, registration_only: true },
        gas: 10_000_000_000_000n,
        deposit: 1_250_000_000_000_000_000_000n,
      },
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer',
        args: { receiver_id: DEPOSIT, amount: '1000000' },
        gas: 30_000_000_000_000n,
        deposit: 1n,
      },
    ]);
  });

  it('wraps native NEAR first on wrap.near, in the same transaction', () => {
    const step = buildWithdrawTransfer({
      token: accountId('wrap.near'),
      receiver: DEPOSIT,
      amount: 10n ** 24n,
      storageDeposit: 0n,
      wrap: 10n ** 24n,
      preview: '',
    });
    expect(step.tx.receiverId).toBe('wrap.near');
    expect(step.tx.actions[0]).toEqual({
      type: 'FunctionCall',
      methodName: 'near_deposit',
      args: {},
      gas: 10_000_000_000_000n,
      deposit: 10n ** 24n,
    });
    expect(step.tx.actions.map((a) => a.methodName)).toEqual(['near_deposit', 'ft_transfer']);
  });

  it('skips the registration when the address already holds storage', () => {
    const step = buildWithdrawTransfer({
      token: accountId(USDC),
      receiver: DEPOSIT,
      amount: 5n,
      storageDeposit: 0n,
      preview: '',
    });
    expect(step.tx.actions.map((a) => a.methodName)).toEqual(['ft_transfer']);
  });
});

describe('POST /v1/withdraw/quote', () => {
  const body = {
    account: ALICE,
    originAsset: `nep141:${USDC}`,
    destinationAsset: BASE_USDC,
    amount: '1',
    recipient: RECIPIENT,
  };
  const post = (deps: DepositDeps, payload: object) =>
    buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => NOW,
      deposit: deps,
    }).inject({
      method: 'POST',
      url: '/v1/withdraw/quote',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload,
    });

  it('quotes from NEAR with the NEAR account as refund address and stores the quote', async () => {
    const { deps, saved, asked } = depositDeps();
    const res = await post(deps, body);
    expect(res.statusCode).toBe(200);
    expect(asked[0]).toMatchObject({
      originAsset: `nep141:${USDC}`,
      destinationAsset: BASE_USDC,
      amountIn: 1_000_000n,
      refundTo: ALICE,
      recipient: RECIPIENT,
    });
    expect(saved[0]).toMatchObject({ accountId: ALICE, refundTo: ALICE, depositAddress: DEPOSIT });
    expect(res.json()).toMatchObject({
      id: 'wq_1',
      chain: 'near',
      chainName: 'NEAR',
      to: { chain: 'base', chainName: 'Base' },
      recipient: RECIPIENT,
      refundTo: ALICE,
      depositAddress: DEPOSIT,
      amountIn: '1000000',
      minAmountOut: '987424',
    });
  });

  it('refuses a token we do not list, Bitcoin, and a recipient that is not of the chain', async () => {
    const { deps, asked } = depositDeps();
    for (const bad of [
      { originAsset: 'nep141:aurora' },
      { destinationAsset: BTC, recipient: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq' },
      { recipient: 'alice.near' },
    ])
      expect((await post(deps, { ...body, ...bad })).statusCode).toBe(400);
    expect(asked).toEqual([]);
  });

  it('refuses a quote whose deposit address is not a NEAR implicit account', async () => {
    const { deps, saved } = depositDeps({
      quote: async () => quoted({ depositAddress: RECIPIENT }),
    });
    expect((await post(deps, body)).statusCode).toBe(502);
    expect(saved).toEqual([]);
  });
});

describe('withdrawLookup', () => {
  const lookup = (o: Parameters<typeof depositDeps>[0] = {}) =>
    withdrawLookup(depositDeps(o).deps, () => NOW);

  it('gives the token, receiver and amount of the stored quote', async () => {
    expect(await lookup()('wq_1', ALICE)).toMatchObject({
      quoteId: 'wq_1',
      token: USDC,
      symbol: 'USDC',
      decimals: 6,
      receiver: DEPOSIT,
      amount: 1_000_000n,
    });
  });

  it('refuses a quote of another account, an unknown one and a deposit quote', async () => {
    expect(await lookup()('wq_1', 'bob.near')).toMatchObject({ status: 404 });
    expect(await lookup({ row: null })('wq_1', ALICE)).toMatchObject({ status: 404 });
    const deposit = {
      ...stored({ originAsset: BASE_USDC, depositAddress: RECIPIENT }),
      status: null,
    };
    expect(await lookup({ row: deposit })('wq_1', ALICE)).toMatchObject({ status: 409 });
  });

  it('refuses a quote close to its deadline or already seen by 1Click', async () => {
    const late = { ...stored({ deadline: new Date('2026-11-14T10:01:00Z') }), status: null };
    expect(await lookup({ row: late })('wq_1', ALICE)).toMatchObject({ status: 409 });
    const seen = { ...stored(), status: 'KNOWN_DEPOSIT_TX' };
    expect(await lookup({ row: seen })('wq_1', ALICE)).toMatchObject({ status: 409 });
    expect(await lookup({ status: 'PROCESSING' })('wq_1', ALICE)).toMatchObject({ status: 409 });
    expect(await lookup({ status: 'throw' })('wq_1', ALICE)).toMatchObject({ status: 502 });
  });
});

describe('prepare withdraw_1click', () => {
  // ft_balance_of / storage_balance_of / storage_balance_bounds on the token, answered by method name.
  // A function view answers by its call's args; view_account answers with `native` yocto.
  type Args = { account_id?: string };
  type View = string | null | object | ((args: Args) => unknown);
  const rpc = (views: Record<string, View>, native = 0n) =>
    ({
      call: async (
        _: string,
        p: { request_type: string; method_name: string; args_base64: string },
      ) => {
        if (p.request_type === 'view_account')
          return { amount: native.toString(), locked: '0', storage_usage: 0 };
        const v = views[p.method_name];
        const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString()) as Args;
        return {
          result: [
            ...Buffer.from(
              JSON.stringify(typeof v === 'function' ? (v as (a: Args) => unknown)(args) : v),
            ),
          ],
          logs: [],
        };
      },
    }) as unknown as NearRpcClient;

  const prepare = (
    views: Record<string, View>,
    o: Parameters<typeof depositDeps>[0] = {},
    deposit = depositDeps(o).deps,
    native = 0n,
  ) =>
    buildAnalyticsServer({
      apiToken: API_TOKEN,
      store: {} as CollectorStore,
      intervalSeconds: 900,
      now: () => NOW,
      deposit,
      mainnet: {
        rpc: rpc(views, native),
        burrowId: 'contract.main.burrow.near',
        rheaId: 'v2.ref-finance.near',
        pools: [],
      } as never,
    }).inject({
      method: 'POST',
      url: '/v1/wallet/prepare',
      headers: { authorization: `Bearer ${API_TOKEN}` },
      payload: { account: ALICE, intent: { action: 'withdraw_1click', quoteId: 'wq_1' } },
    });

  const views = {
    ft_balance_of: '5000000',
    storage_balance_of: null,
    storage_balance_bounds: { min: '1250000000000000000000', max: null },
  };

  it('builds register + transfer to the stored deposit address, sealed', async () => {
    const res = await prepare(views);
    expect(res.statusCode).toBe(200);
    const out = res.json<{ transactions: unknown; amount: unknown }>();
    expect(out.transactions).toEqual([
      {
        intentId: 'withdraw',
        receiverId: USDC,
        actions: [
          {
            methodName: 'storage_deposit',
            args: { account_id: DEPOSIT, registration_only: true },
            gas: '10000000000000',
            deposit: '1250000000000000000000',
          },
          {
            methodName: 'ft_transfer',
            args: { receiver_id: DEPOSIT, amount: '1000000' },
            gas: '30000000000000',
            deposit: '1',
          },
        ],
      },
    ]);
    expect(out.amount).toEqual({ raw: '1000000', human: 1, symbol: 'USDC' });
  });

  it('refuses when the wallet holds less than the quote', async () => {
    const res = await prepare({ ...views, ft_balance_of: '999999' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toMatch(/holds less/);
  });

  it('builds a quote once, and a failed build does not use it up', async () => {
    const { deps } = depositDeps();
    expect((await prepare({ ...views, ft_balance_of: '1' }, {}, deps)).statusCode).toBe(409);
    expect((await prepare(views, {}, deps)).statusCode).toBe(200);
    const again = await prepare(views, {}, deps);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: string }>().error).toMatch(/already built/);
  });

  it('passes the lookup refusal through', async () => {
    expect((await prepare(views, { row: null })).statusCode).toBe(404);
  });

  describe('from native NEAR (wNEAR quote)', () => {
    const NEAR = 10n ** 24n;
    const REG = 1_250_000_000_000_000_000_000n;
    const wnear = {
      ...stored({ originAsset: 'nep141:wrap.near', amountIn: NEAR.toString() }),
      status: null,
    };
    const near = (wallet: string, aliceRegistered = true) => ({
      ft_balance_of: wallet,
      storage_balance_of: ({ account_id }: { account_id?: string }) =>
        account_id === ALICE && aliceRegistered ? { total: REG.toString(), available: '0' } : null,
      storage_balance_bounds: { min: REG.toString(), max: null },
    });
    const TOKENS_WNEAR: OneClickToken[] = [
      ...TOKENS,
      {
        assetId: 'nep141:wrap.near',
        decimals: 24,
        blockchain: 'near',
        symbol: 'wNEAR',
        contractAddress: 'wrap.near',
      },
    ];
    const deps = () => {
      const d = depositDeps({ row: wnear }).deps;
      return { ...d, oneClick: { ...d.oneClick, tokens: async () => TOKENS_WNEAR } };
    };
    const methods = (res: { json: () => unknown }) =>
      (res.json() as { transactions: { actions: { methodName: string; deposit: string }[] }[] })
        .transactions[0]!.actions;

    it('wraps only the wNEAR the wallet lacks, before the transfer, in one transaction', async () => {
      const res = await prepare(near((NEAR / 4n).toString()), {}, deps(), 5n * NEAR);
      expect(res.statusCode).toBe(200);
      expect(methods(res).map((a) => a.methodName)).toEqual([
        'near_deposit',
        'storage_deposit',
        'ft_transfer',
      ]);
      expect(methods(res)[0]!.deposit).toBe(((NEAR * 3n) / 4n).toString());
    });

    it('adds the wrap.near registration to the wrap when the wallet is not registered', async () => {
      const res = await prepare(near('0', false), {}, deps(), 5n * NEAR);
      expect(res.statusCode).toBe(200);
      expect(methods(res)[0]!.deposit).toBe((NEAR + REG).toString());
    });

    it('does not wrap when the wallet already holds the wNEAR', async () => {
      const res = await prepare(near(NEAR.toString()), {}, deps(), 0n);
      expect(res.statusCode).toBe(200);
      expect(methods(res).map((a) => a.methodName)).toEqual(['storage_deposit', 'ft_transfer']);
    });

    it('lets Max (all but 1 NEAR) through for a wallet not yet on wrap.near', async () => {
      const max = { ...wnear, amountIn: (4n * NEAR).toString() };
      const d = deps();
      const res = await prepare(
        near('0', false),
        {},
        { ...d, store: { ...d.store, find: async () => max } },
        5n * NEAR,
      );
      expect(res.statusCode).toBe(200);
      expect(methods(res)[0]!.deposit).toBe((4n * NEAR + REG).toString());
    });

    it('wraps, registers the deposit address and transfers when nothing is registered', async () => {
      const res = await prepare(near('0', false), {}, deps(), 5n * NEAR);
      const actions = methods(res);
      expect(actions.map((a) => a.methodName)).toEqual([
        'near_deposit',
        'storage_deposit',
        'ft_transfer',
      ]);
      expect(actions[1]!.deposit).toBe(REG.toString());
      expect(JSON.stringify(res.json())).toMatch(/wrap 1 NEAR into wNEAR \(plus 0\.0012 NEAR/);
    });

    it('builds at exactly the quote plus 1 NEAR, and refuses 1 yocto less', async () => {
      expect((await prepare(near('0'), {}, deps(), 2n * NEAR)).statusCode).toBe(200);
      expect((await prepare(near('0'), {}, deps(), 2n * NEAR - 1n)).statusCode).toBe(409);
    });

    it('keeps 1 NEAR in the wallet for fees', async () => {
      const res = await prepare(near('0'), {}, deps(), 2n * NEAR - 1n);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toMatch(/1 NEAR/);
    });
  });
});
