import { describe, expect, it } from 'vitest';
import {
  accountId,
  type ApprovedPlan,
  type PlannedTransaction,
  type PolicyVerdict,
  type PriceOracle,
  type UnitPrice,
} from '@near-autopilot/core';
import { planHash } from '@near-autopilot/core/hash';
import {
  FixedClock,
  ScriptedContractViewer,
  SequentialIds,
  SilentLogger,
  TestApprovalAuthority,
} from '@near-autopilot/core/testing';
import { RheaPlanner, StaticPoolRegistry } from '@near-autopilot/rhea-adapter';
import { DryRunExecutor } from '@near-autopilot/tx-execution';
import { chooseRoute, type VenueQuote } from '../src/gateway/best-execution';
import { OneClickClient } from '../src/gateway/one-click';
import { ShadowGateway } from '../src/gateway/shadow-gateway';
import { plannedSwap } from '../src/gateway/swap-plan';
import { OneClickVenue, RheaVenue } from '../src/gateway/venues';
import { HttpJsonClient } from '../src/market-data/http';
import type { PolicyVerdictRecord } from '../src/repository';
import { InMemoryRepository } from './in-memory-repository';

const NOW = new Date('2026-11-05T19:00:00Z');
const ALICE = accountId('alice.near');
const WNEAR = accountId('wrap.near');
const USDC = accountId('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
const RHEA = accountId('v2.ref-finance.near');
const ONE_NEAR = 10n ** 24n;
const GAS_PRICE = 100_000_000n; // yoctoNEAR per gas unit

// $3.65 per NEAR (24 decimals), $1 per USDC (6 decimals): valueUsd = raw * multiplier * 1e6 / 10^decimals.
const P_NEAR: UnitPrice = { multiplier: 365n, decimals: 26 };
const P_USDC: UnitPrice = { multiplier: 1n, decimals: 6 };
const prices = { in: P_NEAR, out: P_USDC, near: P_NEAR };
const limits = { maxQuoteAgeSeconds: 180, maxOracleDeviationBps: 150 };
const request = { tokenIn: WNEAR, tokenOut: USDC, amountIn: ONE_NEAR };

const ok = (
  venue: 'rhea' | 'near-intents-1click',
  amountOut: bigint,
  over: Partial<Extract<VenueQuote, { ok: true }>> = {},
): VenueQuote => ({
  venue,
  ok: true,
  quotedAt: NOW,
  amountOut,
  minAmountOut: null,
  feeBps: null,
  gasUpperBoundYocto: 0n,
  settlement: venue === 'rhea' ? 'atomic' : 'async',
  ref: 'x',
  detail: null,
  ...over,
});

describe('chooseRoute (best execution)', () => {
  it('ranks by net USD after gas, not by gross output', () => {
    // Rhea pays 3.658335 USDC but needs 180 Tgas (0.018 NEAR = $0.0657); 1Click 3.654546 with 30 Tgas ($0.01095).
    const d = chooseRoute(
      request,
      [
        ok('rhea', 3_658_335n, { gasUpperBoundYocto: 180_000_000_000_000n * GAS_PRICE }),
        ok('near-intents-1click', 3_654_546n, {
          gasUpperBoundYocto: 30_000_000_000_000n * GAS_PRICE,
        }),
      ],
      prices,
      limits,
      NOW,
    );
    expect(d.chosen).toBe('near-intents-1click');
    expect(d.scored.map((s) => s.netUsdMicro)).toEqual([3_592_635n, 3_643_596n]);
    expect(d.advantageBps).toBe(141); // (3_643_596 - 3_592_635) / 3_592_635
  });

  it('a tie goes to the atomic venue', () => {
    const d = chooseRoute(
      request,
      [ok('near-intents-1click', 3_600_000n), ok('rhea', 3_600_000n)],
      prices,
      limits,
      NOW,
    );
    expect(d.chosen).toBe('rhea');
    expect(d.advantageBps).toBe(0);
  });

  it('excludes stale quotes, failed quotes and routes paying far below the oracle', () => {
    const d = chooseRoute(
      request,
      [
        ok('rhea', 3_600_000n, { quotedAt: new Date(NOW.getTime() - 181_000) }),
        {
          venue: 'near-intents-1click',
          ok: false,
          quotedAt: NOW,
          reason: 'quote failed: HTTP 500',
        },
      ],
      prices,
      limits,
      NOW,
    );
    expect(d.chosen).toBeNull();
    expect(d.scored[0]?.excluded).toBe('quote is 181s old (limit 180s)');
    expect(d.scored[1]?.excluded).toBe('quote failed: HTTP 500');
    // $3.65 in, $3.50 out = 410 bps below the oracle (limit 150).
    const thin = chooseRoute(request, [ok('rhea', 3_500_000n)], prices, limits, NOW);
    expect(thin.chosen).toBeNull();
    expect(thin.scored[0]?.excluded).toMatch(/pays 410 bps below the oracle/);
  });

  it('chooses nothing when prices are missing (gas is never treated as free)', () => {
    const d = chooseRoute(
      request,
      [ok('rhea', 3_600_000n)],
      { ...prices, near: null },
      limits,
      NOW,
    );
    expect(d.chosen).toBeNull();
    expect(d.reason).toMatch(/cannot value the route/);
  });
});

const tokens = { isStorageRegistered: async () => true } as unknown as ConstructorParameters<
  typeof RheaPlanner
>[0];
const swapIntent = {
  id: 'intent-1',
  agentId: 'test',
  kind: 'swap' as const,
  protocol: 'rhea' as const,
  reason: 'test',
  quotedAmountOut: 3_658_335n,
  slippageBps: 50,
  tokenIn: WNEAR,
  tokenOut: USDC,
  amountIn: ONE_NEAR,
  minAmountOut: 3_630_000n,
  poolId: 4512,
};
const swapPlan = () => new RheaPlanner(tokens, { contractId: RHEA }).plan(swapIntent, ALICE);

describe('plannedSwap (the swap is read from the approved plan bytes)', () => {
  it('reads a Rhea plan, and nothing else', async () => {
    const plan = await swapPlan();
    expect(plannedSwap(plan, RHEA)).toEqual({
      tokenIn: WNEAR,
      tokenOut: USDC,
      amountIn: ONE_NEAR,
      minAmountOut: 3_630_000n,
      poolId: 4512,
      attachedGas: 180_000_000_000_000n,
    });
    const [action] = plan.actions;
    if (!action) throw new Error('no action');
    expect(plannedSwap({ ...plan, actions: [action, action] }, RHEA)).toBeNull();
    expect(plannedSwap(plan, accountId('evil.near'))).toBeNull();
    const args = { ...(action.args as Record<string, unknown>), amount: '1' };
    expect(plannedSwap({ ...plan, actions: [{ ...action, args }] }, RHEA)).toBeNull();
  });
});

function oneClickFetch(answer: (body: Record<string, unknown>) => unknown, sent: unknown[] = []) {
  const impl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    sent.push(body);
    return new Response(JSON.stringify(answer(body)), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  };
  return impl;
}
const oneClickAnswer = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  correlationId: 'c-1',
  timestamp: NOW.toISOString(),
  signature: 'ed25519:sig',
  quoteRequest: { ...body, appFees: [{ recipient: 'x', fee: 20 }] },
  quote: {
    amountIn: String(body.amount),
    amountInFormatted: '1.0',
    amountInUsd: '3.65',
    minAmountIn: String(body.amount),
    amountOut: '3654546',
    amountOutFormatted: '3.654546',
    amountOutUsd: '3.65',
    minAmountOut: '3636273',
    timeEstimate: 20,
    ...extra,
  },
});
const client = (impl: typeof fetch) =>
  new OneClickClient({
    http: new HttpJsonClient({ fetchImpl: impl, sleep: async () => {}, maxRetries: 0 }),
    baseUrl: 'https://1click.test',
  });

describe('OneClickClient (dry quotes only)', () => {
  const req = {
    tokenIn: WNEAR,
    tokenOut: USDC,
    amountIn: ONE_NEAR,
    slippageBps: 50,
    account: ALICE,
    now: NOW,
  };

  it('always asks for a DRY quote and reports the app fee it includes', async () => {
    const sent: unknown[] = [];
    const q = await client(oneClickFetch((b) => oneClickAnswer(b), sent)).dryQuote(req);
    expect(sent[0]).toMatchObject({
      dry: true,
      originAsset: 'nep141:wrap.near',
      destinationAsset: `nep141:${USDC}`,
      amount: ONE_NEAR.toString(),
      slippageTolerance: 50,
      recipient: ALICE,
      refundTo: ALICE,
    });
    expect(q).toMatchObject({ amountOut: 3_654_546n, minAmountOut: 3_636_273n, appFeeBps: 20 });
  });

  it('refuses an answer that carries a deposit address', async () => {
    const impl = oneClickFetch((b) => oneClickAnswer(b, { depositAddress: 'deposit.near' }));
    await expect(client(impl).dryQuote(req)).rejects.toThrow(/deposit address/);
  });
});

// ------------------------------------------------------------------------------------------ the gateway itself

function stored(id: string, verdict: PolicyVerdict, hash: string): PolicyVerdictRecord {
  return {
    id,
    evaluatedAt: NOW,
    engine: 'legacy',
    runId: null,
    intentId: 'intent-1',
    intentKind: 'swap',
    verdict,
    outcome: verdict === 'ALLOW' ? 'approve' : verdict === 'WARN' ? 'require_approval' : 'reject',
    policyVersion: 'v',
    snapshotId: 's',
    planHash: hash,
    valueUsdMicro: null,
    checks: [],
    violations: [],
    input: {},
  };
}

function gateway(opts: { oneClick?: boolean; policyVersion?: string } = {}) {
  const repo = new InMemoryRepository();
  const clock = new FixedClock(NOW);
  const authority = new TestApprovalAuthority();
  const viewer = new ScriptedContractViewer().on(RHEA, 'get_return', '3658335');
  const sent: unknown[] = [];
  const oracle: PriceOracle = {
    getPrices: async () => ({
      prices: new Map([
        [WNEAR, P_NEAR],
        [USDC, P_USDC],
      ]),
      asOf: NOW,
    }),
  };
  const gw = new ShadowGateway({
    inner: new DryRunExecutor({ clock, logger: new SilentLogger(), approvals: authority }),
    repo,
    venues: [
      new RheaVenue(viewer, {
        contractId: RHEA,
        pools: new StaticPoolRegistry([{ poolId: 4512, tokenA: WNEAR, tokenB: USDC }]),
      }),
      ...(opts.oneClick === false
        ? []
        : [new OneClickVenue(client(oneClickFetch((b) => oneClickAnswer(b), sent)))]),
    ],
    prices: oracle,
    gasPrice: async () => GAS_PRICE,
    nearToken: WNEAR,
    exchange: RHEA,
    account: ALICE,
    limits: { ...limits, slippageBps: 50 },
    clock,
    ids: new SequentialIds('route'),
    logger: new SilentLogger(),
    ...(opts.policyVersion ? { policyVersion: opts.policyVersion } : {}),
  });
  return { gw, repo, authority, viewer, sent };
}

describe('ShadowGateway: the verdict cannot be bypassed, nothing is ever sent', () => {
  it('ALLOW: re-checks the stored verdict, quotes both venues, records the best execution, returns dry_run', async () => {
    const { gw, repo, authority, viewer, sent } = gateway();
    const plan = await swapPlan();
    const approved = authority.mint(plan, { now: NOW, decisionId: 'd-1' });
    await repo.insertPolicyVerdict(stored('d-1', 'ALLOW', approved.planHash));

    const r = await gw.execute(approved);
    expect(r).toEqual({ status: 'dry_run', mode: 'dry-run', txHash: null, error: null });
    const [route] = repo.routes;
    expect(route).toMatchObject({
      origin: 'gateway',
      outcome: 'routed',
      decisionId: 'd-1',
      planHash: approved.planHash,
      tokenIn: WNEAR,
      tokenOut: USDC,
      amountIn: ONE_NEAR,
      chosenVenue: 'near-intents-1click',
    });
    // Rhea was quoted on the plan's own pool; 1Click got a DRY request for exactly the planned amount.
    expect(viewer.calls).toEqual([
      {
        contractId: RHEA,
        methodName: 'get_return',
        args: {
          pool_id: 4512,
          token_in: WNEAR,
          amount_in: ONE_NEAR.toString(),
          token_out: USDC,
        },
      },
    ]);
    expect(sent).toEqual([expect.objectContaining({ dry: true, amount: ONE_NEAR.toString() })]);
  });

  it('refuses a decision whose verdict was never stored, before the approval is even looked at', async () => {
    const { gw, repo, authority, sent } = gateway();
    const approved = authority.mint(await swapPlan(), { now: NOW, decisionId: 'd-x' });
    const r = await gw.execute(approved);
    expect(r).toMatchObject({ status: 'rejected', txHash: null });
    expect(r.error).toBe('no stored policy verdict for this decision');
    expect(repo.routes).toMatchObject([{ outcome: 'refused', chosenVenue: null }]);
    expect(sent).toEqual([]);
  });

  it.each<PolicyVerdict>(['WARN', 'BLOCK'])(
    'refuses a %s verdict even with an authentic approval in hand',
    async (verdict) => {
      const { gw, repo, authority, sent } = gateway();
      const approved = authority.mint(await swapPlan(), { now: NOW, decisionId: 'd-2' });
      await repo.insertPolicyVerdict(stored('d-2', verdict, approved.planHash));
      const r = await gw.execute(approved);
      expect(r.status).toBe('rejected');
      expect(r.error).toBe(`stored verdict is ${verdict}, not ALLOW`);
      expect(sent).toEqual([]);
    },
  );

  it('refuses an ALLOW stored for a different plan', async () => {
    const { gw, repo, authority } = gateway();
    const approved = authority.mint(await swapPlan(), { now: NOW, decisionId: 'd-3' });
    await repo.insertPolicyVerdict(stored('d-3', 'ALLOW', 'sha256:other'));
    expect((await gw.execute(approved)).error).toBe(
      'the stored ALLOW verdict is for a different plan',
    );
  });

  it('refuses a forged approval (a structural copy) even when an ALLOW verdict is stored for it', async () => {
    const { gw, repo, sent } = gateway();
    const plan = await swapPlan();
    const forged = {
      plan,
      decisionId: 'd-4',
      planHash: planHash(plan),
      approvedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    } as ApprovedPlan;
    await repo.insertPolicyVerdict(stored('d-4', 'ALLOW', forged.planHash));
    const r = await gw.execute(forged);
    expect(r.status).toBe('rejected');
    expect(r.error).toMatch(/not issued by the policy engine/);
    expect(repo.routes).toMatchObject([{ outcome: 'refused' }]);
    expect(sent).toEqual([]);
  });

  it('refuses a replayed approval', async () => {
    const { gw, repo, authority } = gateway({ oneClick: false });
    const approved = authority.mint(await swapPlan(), { now: NOW, decisionId: 'd-5' });
    await repo.insertPolicyVerdict(stored('d-5', 'ALLOW', approved.planHash));
    expect((await gw.execute(approved)).status).toBe('dry_run');
    expect((await gw.execute(approved)).error).toMatch(/already been used/);
  });

  it('refuses an ALLOW issued under another policy version (the policy changed after approval)', async () => {
    const { gw, repo, authority, sent } = gateway({ policyVersion: 'rules-v2+cfg:new' });
    const approved = authority.mint(await swapPlan(), { now: NOW, decisionId: 'd-6' });
    await repo.insertPolicyVerdict(stored('d-6', 'ALLOW', approved.planHash)); // stored under policy 'v'
    const r = await gw.execute(approved);
    expect(r.status).toBe('rejected');
    expect(r.error).toMatch(/issued under policy v, not the one in force/);
    expect(sent).toEqual([]);
  });

  it('a non-swap plan (a Burrow repay) is approved dry-run with nothing to route', async () => {
    const { gw, repo, authority } = gateway();
    const plan: PlannedTransaction = {
      intentId: 'i-r',
      signerId: ALICE,
      receiverId: USDC,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: { receiver_id: 'contract.main.burrow.near', amount: '1', msg: '' },
          gas: 1n,
          deposit: 1n,
        },
      ],
    };
    const approved = authority.mint(plan, { now: NOW, decisionId: 'd-6' });
    await repo.insertPolicyVerdict(stored('d-6', 'ALLOW', approved.planHash));
    expect((await gw.execute(approved)).status).toBe('dry_run');
    expect(repo.routes).toMatchObject([{ outcome: 'not_a_swap', chosenVenue: null }]);
  });

  it('has no signer: the gateway module never imports one, never signs, never broadcasts', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const f of [
      'shadow-gateway',
      'venues',
      'one-click',
      'best-execution',
      'probe',
      'swap-plan',
    ]) {
      const src = await readFile(new URL(`../src/gateway/${f}.ts`, import.meta.url), 'utf8');
      expect(src).not.toMatch(
        /loadSigner|TransactionSigner|TransactionExecutor|broadcast_tx|send_tx|signTransaction/,
      );
    }
  });
});
