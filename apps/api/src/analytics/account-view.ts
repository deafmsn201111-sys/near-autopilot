import {
  accountIdSchema,
  type AccountId,
  type FunctionCallAction,
  type TokenId,
} from '@near-autopilot/core';
import {
  BurrowClient,
  BurrowVerifier,
  buildBorrow,
  buildBurrowStorageDeposit,
  buildRepay,
  buildSupply,
  buildWithdraw,
} from '@near-autopilot/burrow-adapter';
import { resolveBalancedLpAmounts, resolveIntentAmount } from '../wallet/amounts';
import { buildUnwrapNear } from '../wallet/wrap';
import { assembleCascade, formatNear, type CascadeStep } from '../wallet/cascade';
import { validateCascade } from '../wallet/validate-cascade';
import { z } from 'zod';
import {
  NearAccountReader,
  NearContractViewer,
  NearTokenReader,
  type NearRpcClient,
} from '@near-autopilot/near-adapter';
import { orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import {
  RheaPoolReader,
  RheaSwapQuoter,
  StaticPoolRegistry,
  buildExchangeDeposit,
  buildExchangeStorageDeposit,
  buildV1AddLiquidity,
} from '@near-autopilot/rhea-adapter';
import {
  RheaDclClient,
  dclPositionAmounts,
  buildRemoveLiquidity,
  buildWithdrawAssets,
  parsePoolId,
  type DclPool,
  type DclPosition,
} from '@near-autopilot/rhea-dcl-adapter';
import type { FastifyInstance } from 'fastify';
import type { CollectorStore } from '../collector/store';
import { valueAccount, type AccountReads, type TokenFacts } from './account';
import { loopStrategies, type LoopMarket } from './looping';
import { hurdle, money, type PortfolioAction } from './portfolio-view';
import { consensus } from './series';

/**
 * YOUR ACCOUNT, read-only: any mainnet account id -> what it holds, how safe its Burrow loan is, and what could be done
 * with the idle tokens, costed the same way as the demo portfolios (a real Rhea quote for the swap). Only VIEW calls:
 * view_account, ft_balance_of, Burrow get_account / get_assets, Rhea get_return. Nothing is signed or sent, and the
 * account is not stored: the answer is computed per request (cached for 60 s).
 */
export interface MainnetReadDeps {
  readonly rpc: NearRpcClient;
  readonly burrowId: AccountId;
  readonly rheaId: AccountId;
  /** The allowlisted Rhea pools (config.rhea.pools): the only swaps an action may assume. */
  readonly pools: readonly { poolId: number; tokenA: TokenId; tokenB: TokenId }[];
  /** Rhea DCL (concentrated liquidity) contract, for reading the account's LP positions. Null disables that read. */
  readonly dclId?: AccountId | null;
}

interface DclPositionView {
  readonly lptId: string;
  readonly poolId: string;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly symbolX: string;
  readonly symbolY: string;
  readonly amountX: number;
  readonly amountY: number;
  readonly usdX: number | null;
  readonly usdY: number | null;
  readonly usd: number | null;
  readonly range: { readonly left: number; readonly right: number };
  /** True when the pool's current point is inside [left, right): only then does the position earn fees. */
  readonly inRange: boolean;
}

/** Known liquid-staking tokens (NEP-141). Their market price already reflects the staking premium, so they are valued
 *  like any token. Native validator-delegated staking needs validator discovery (an indexer) and is out of scope here. */
const LIQUID_STAKING: readonly {
  token: TokenId;
  symbol: string;
  protocol: string;
  /** Plain-language delayed-unstake waiting time; liquid-staking tokens can also be swapped instantly on a DEX. */
  unstakeNote: string;
}[] = [
  {
    token: 'meta-pool.near' as TokenId,
    symbol: 'stNEAR',
    protocol: 'Meta Pool',
    unstakeNote: 'Delayed unstake takes about 4–6 days; or swap stNEAR instantly on a DEX.',
  },
  {
    token: 'linear-protocol.near' as TokenId,
    symbol: 'LiNEAR',
    protocol: 'LiNEAR',
    unstakeNote: 'Delayed unstake takes about 2–4 days; or swap LiNEAR instantly on a DEX.',
  },
];

interface StakingView {
  readonly token: string;
  readonly symbol: string;
  readonly protocol: string;
  readonly amount: number;
  readonly usd: number | null;
  readonly unstakeNote: string;
}

/** The account's liquid-staking holdings (stNEAR, LiNEAR): on-chain FT balances, valued at the latest market price. */
async function readStaking(
  tokens: NearTokenReader,
  accountId: AccountId,
  tokenMeta: ReadonlyMap<string, { symbol: string; decimals: number }>,
  prices: ReadonlyMap<string, number>,
): Promise<StakingView[]> {
  const out: StakingView[] = [];
  await Promise.all(
    LIQUID_STAKING.map(async (s) => {
      const raw = await tokens.getBalance(s.token, accountId).catch(() => 0n);
      if (raw <= 0n) return;
      const amount = Number(raw) / 10 ** (tokenMeta.get(s.token)?.decimals ?? 24);
      const p = prices.get(s.token) ?? null;
      out.push({
        token: s.token,
        symbol: s.symbol,
        protocol: s.protocol,
        amount,
        usd: p !== null ? amount * p : null,
        unstakeNote: s.unstakeNote,
      });
    }),
  );
  return out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

interface V1PositionView {
  readonly poolId: number;
  readonly tokens: readonly string[];
  readonly symbols: readonly string[];
  readonly amounts: readonly number[];
  readonly usdPerToken: readonly (number | null)[];
  readonly usd: number | null;
  readonly sharePct: number;
}

/**
 * The account's Rhea v1 (classic AMM) LP positions across the allowlisted pools. For each pool the account has shares
 * in, the owned token amounts are reserves × shares / total-supply (on-chain facts); USD is a calculated estimate.
 */
async function readV1Positions(
  reader: RheaPoolReader,
  pools: readonly { poolId: number }[],
  accountId: AccountId,
  tokenMeta: ReadonlyMap<string, { symbol: string; decimals: number }>,
  prices: ReadonlyMap<string, number>,
): Promise<V1PositionView[]> {
  const out: V1PositionView[] = [];
  await Promise.all(
    pools.map(async (pl) => {
      const shares = await reader.getPoolShares(pl.poolId, accountId).catch(() => 0n);
      if (shares <= 0n) return;
      const pool = await reader.getPool(pl.poolId).catch(() => null);
      if (!pool || pool.sharesTotalSupply <= 0n) return;
      const symbols: string[] = [];
      const amounts: number[] = [];
      const usdPerToken: (number | null)[] = [];
      let usd: number | null = 0;
      pool.tokens.forEach((t, i) => {
        const raw = ((pool.reserves[i] ?? 0n) * shares) / pool.sharesTotalSupply;
        const f = tokenMeta.get(t);
        const human = Number(raw) / 10 ** (f?.decimals ?? 24);
        amounts.push(human);
        symbols.push(f?.symbol ?? t.slice(0, 10));
        const p = prices.get(t);
        const legUsd = p !== undefined ? human * p : null;
        usdPerToken.push(legUsd);
        if (usd !== null && legUsd !== null) usd += legUsd;
        else usd = null;
      });
      out.push({
        poolId: pl.poolId,
        tokens: [...pool.tokens],
        symbols,
        amounts,
        usdPerToken,
        usd,
        sharePct: Number((shares * 10_000n) / pool.sharesTotalSupply) / 100,
      });
    }),
  );
  return out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
}

/**
 * The account's Rhea DCL (concentrated-liquidity) LP positions, valued at the latest prices. Read-only: `list_liquidities`
 * for the positions and `get_pool` for each pool's current point, then the exact token amounts (dclPositionAmounts).
 * USD is a calculated estimate from on-chain liquidity + current point + market prices.
 */
async function readDclPositions(
  dcl: RheaDclClient,
  accountId: AccountId,
  tokenMeta: ReadonlyMap<string, { symbol: string; decimals: number }>,
  prices: ReadonlyMap<string, number>,
): Promise<DclPositionView[]> {
  const positions: DclPosition[] = await dcl.listPositions(accountId).catch(() => []);
  if (positions.length === 0) return [];
  const pools = new Map<string, DclPool>();
  await Promise.all(
    [...new Set(positions.map((p) => p.pool_id))].map(async (pid) => {
      const p = await dcl.getPool(pid).catch(() => null);
      if (p) pools.set(pid, p);
    }),
  );
  const out: DclPositionView[] = [];
  for (const pos of positions) {
    const pool = pools.get(pos.pool_id);
    if (!pool || pos.amount <= 0n) continue;
    const { x, y } = dclPositionAmounts(pos, pool.current_point);
    const fx = tokenMeta.get(pool.token_x);
    const fy = tokenMeta.get(pool.token_y);
    const amountX = Number(x) / 10 ** (fx?.decimals ?? 24);
    const amountY = Number(y) / 10 ** (fy?.decimals ?? 24);
    const px = prices.get(pool.token_x) ?? null;
    const py = prices.get(pool.token_y) ?? null;
    const usdX = px !== null ? amountX * px : null;
    const usdY = py !== null ? amountY * py : null;
    out.push({
      lptId: pos.lpt_id,
      poolId: pos.pool_id,
      tokenX: pool.token_x,
      tokenY: pool.token_y,
      symbolX: fx?.symbol ?? pool.token_x.slice(0, 10),
      symbolY: fy?.symbol ?? pool.token_y.slice(0, 10),
      amountX,
      amountY,
      usdX,
      usdY,
      usd: usdX !== null && usdY !== null ? usdX + usdY : null,
      range: { left: pos.left_point, right: pos.right_point },
      inRange: pool.current_point >= pos.left_point && pool.current_point < pos.right_point,
    });
  }
  return out;
}

/** Canonical wrapped-NEAR contract (mainnet). Swapping "NEAR" means swapping this NEP-141, wrapping native first. */
const WRAP_NEAR_ID = accountIdSchema.parse('wrap.near');

const ORCH = orchestratorConfigSchema.parse({});
const GAS = ORCH.swap.estimatedGasUsd;
const HORIZON = ORCH.swap.horizonDays;
const H = HORIZON / 365;
const WNEAR = 'wrap.near' as TokenId;
/** Native NEAR left untouched for gas and storage when proposing to use the rest. */
const NEAR_RESERVE = 1;

interface PortfolioLeg {
  readonly token: string;
  readonly symbol: string;
  readonly protocol: string;
  readonly usd: number;
  readonly kind: 'asset' | 'debt';
}

export interface PortfolioMetrics {
  readonly totalAssetsUsd: number;
  readonly totalDebtUsd: number;
  readonly netUsd: number;
  readonly byToken: readonly { token: string; symbol: string; usd: number; pct: number }[];
  readonly byProtocol: readonly { protocol: string; usd: number; pct: number }[];
  readonly concentration: { token: string; symbol: string; pct: number } | null;
}

/**
 * Exposure of the whole portfolio: USD by token and by protocol (venue), and the single-asset concentration. A pure
 * aggregation over priced legs from every source (wallet, Burrow, Rhea v1 + DCL, staking). Debt is tracked separately
 * and never dilutes asset concentration.
 */
export function portfolioMetrics(legs: readonly PortfolioLeg[]): PortfolioMetrics {
  const assets = legs.filter((l) => l.kind === 'asset' && l.usd > 0);
  const totalAssetsUsd = assets.reduce((s, l) => s + l.usd, 0);
  const totalDebtUsd = legs.filter((l) => l.kind === 'debt').reduce((s, l) => s + l.usd, 0);
  const pct = (usd: number) => (totalAssetsUsd > 0 ? (usd / totalAssetsUsd) * 100 : 0);

  const byTokenMap = new Map<string, { token: string; symbol: string; usd: number }>();
  for (const l of assets) {
    const e = byTokenMap.get(l.token) ?? { token: l.token, symbol: l.symbol, usd: 0 };
    e.usd += l.usd;
    byTokenMap.set(l.token, e);
  }
  const byToken = [...byTokenMap.values()]
    .map((e) => ({ ...e, pct: pct(e.usd) }))
    .sort((a, b) => b.usd - a.usd);

  const byProtoMap = new Map<string, number>();
  for (const l of assets) byProtoMap.set(l.protocol, (byProtoMap.get(l.protocol) ?? 0) + l.usd);
  const byProtocol = [...byProtoMap]
    .map(([protocol, usd]) => ({ protocol, usd, pct: pct(usd) }))
    .sort((a, b) => b.usd - a.usd);

  const top = byToken[0] ?? null;
  return {
    totalAssetsUsd,
    totalDebtUsd,
    netUsd: totalAssetsUsd - totalDebtUsd,
    byToken,
    byProtocol,
    concentration: top ? { token: top.token, symbol: top.symbol, pct: top.pct } : null,
  };
}

export type RecommendationIntent =
  | { readonly action: 'swap'; readonly fromToken: string; readonly approxUsd: number }
  | { readonly action: 'repay'; readonly token: string; readonly approxUsd: number }
  | { readonly action: 'supply'; readonly token: string; readonly approxUsd: number }
  | { readonly action: 'reposition_dcl'; readonly lptId: string; readonly poolId: string };

export interface PortfolioRecommendation {
  readonly id: string;
  readonly kind:
    'reduce_concentration' | 'improve_loan_safety' | 'put_idle_to_work' | 'reposition_dcl_position';
  /** Which agent produced it (the orchestrator's roles), so the dashboard can show who/why. */
  readonly agent: string;
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly why: string;
  /** The concrete, parameterised intent Phase 4 turns into a transaction the user signs. Amounts are USD estimates. */
  readonly intent: RecommendationIntent;
}

export interface RecommendationContext {
  readonly metrics: PortfolioMetrics;
  readonly loan: { readonly hasDebt: boolean; readonly healthFactor: number | null } | null;
  /** Wallet assets that are priced and could earn a Burrow supply rate, largest USD first. aprPct is a percentage. */
  readonly idleEarn: readonly { token: string; symbol: string; usd: number; aprPct: number }[];
  readonly largestDebt: { token: string; symbol: string; usd: number } | null;
  /** DCL LP positions currently out of range (earning no fees), largest USD first. */
  readonly dclOutOfRange: readonly {
    lptId: string;
    poolId: string;
    pair: string;
    usd: number | null;
  }[];
}

const money0 = (usd: number) => `$${Math.round(usd).toLocaleString('en-US')}`;

/**
 * Portfolio-health recommendations derived from the real portfolio (brief: the agents analyse it and say what/why).
 * Each carries a concrete intent for the one-click transaction engine. Deterministic, explainable, ordered by urgency,
 * and never an instruction — the user decides and signs.
 */
export function portfolioRecommendations(ctx: RecommendationContext): PortfolioRecommendation[] {
  const recs: PortfolioRecommendation[] = [];

  // 1. Loan safety first: a low health factor is the most time-sensitive thing.
  const hf = ctx.loan?.healthFactor ?? null;
  if (ctx.loan?.hasDebt && hf !== null && hf < 1.5 && ctx.largestDebt) {
    const approxUsd = Math.round(ctx.largestDebt.usd * 0.3);
    recs.push({
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: hf < 1.3 ? 'warning' : 'info',
      title: `Your loan's health factor is ${hf.toFixed(2)}`,
      why: `A health factor of ${hf.toFixed(2)} is close to the 1.0 liquidation line. Repaying about ${money0(approxUsd)} of your ${ctx.largestDebt.symbol} debt restores a safer buffer.`,
      intent: { action: 'repay', token: ctx.largestDebt.token, approxUsd },
    });
  }

  // 2. Reduce single-asset concentration.
  const c = ctx.metrics.concentration;
  if (c && c.pct >= 60 && ctx.metrics.totalAssetsUsd > 0) {
    const approxUsd = Math.round((ctx.metrics.totalAssetsUsd * (c.pct - 50)) / 100);
    recs.push({
      id: 'reduce-concentration',
      kind: 'reduce_concentration',
      agent: 'Portfolio Intelligence',
      severity: c.pct >= 85 ? 'warning' : 'info',
      title: `${c.pct.toFixed(0)}% of your portfolio is in ${c.symbol}`,
      why: `A ${c.pct.toFixed(0)}% position in ${c.symbol} means a fall in ${c.symbol} hits almost your whole portfolio. Moving about ${money0(approxUsd)} of it into other assets brings the single-asset risk down toward half the portfolio.`,
      intent: { action: 'swap', fromToken: c.token, approxUsd },
    });
  }

  // 3. Put idle cash to work: the largest priced wallet asset that earns a meaningful supply rate.
  const idle = ctx.idleEarn.filter((a) => a.aprPct >= 1 && a.usd >= 10)[0];
  if (idle) {
    recs.push({
      id: 'put-idle-to-work',
      kind: 'put_idle_to_work',
      agent: 'Capital Allocator',
      severity: 'info',
      title: `${money0(idle.usd)} of ${idle.symbol} is sitting idle`,
      why: `${idle.symbol} in your wallet earns nothing. Supplying it on Burrow earns about ${idle.aprPct.toFixed(1)}% a year, and you can withdraw it any time.`,
      intent: { action: 'supply', token: idle.token, approxUsd: Math.round(idle.usd) },
    });
  }

  // 4. DCL positions that have drifted out of range earn no fees until repositioned.
  const oor = ctx.dclOutOfRange.filter((d) => (d.usd ?? 0) > 1)[0];
  if (oor) {
    recs.push({
      id: `reposition-dcl-${oor.lptId}`,
      kind: 'reposition_dcl_position',
      agent: 'Liquidity Optimizer',
      severity: 'info',
      title: `Your ${oor.pair} liquidity is out of range`,
      why: `This concentrated-liquidity position has drifted outside its price range, so it is earning no fees. Repositioning it around the current price puts it back to work.`,
      intent: { action: 'reposition_dcl', lptId: oor.lptId, poolId: oor.poolId },
    });
  }

  return recs;
}

export function registerAccountView(
  app: FastifyInstance,
  store: CollectorStore,
  deps: MainnetReadDeps,
): void {
  const viewer = new NearContractViewer(deps.rpc);
  const tokens = new NearTokenReader(viewer);
  const native = new NearAccountReader(deps.rpc);
  const burrow = new BurrowClient(viewer, deps.burrowId);
  const quoter = new RheaSwapQuoter(viewer, {
    contractId: deps.rheaId,
    pools: new StaticPoolRegistry(deps.pools),
  });
  const dcl = deps.dclId ? new RheaDclClient(viewer, { contractId: deps.dclId }) : null;
  const poolReader = new RheaPoolReader(viewer, deps.rheaId);
  const clock = { now: () => new Date() };
  // Burrow transactions are only built from proofs this verifier mints (chain id, deployed code, oracle, listing).
  const burrowVerifier = new BurrowVerifier(
    { rpc: deps.rpc, client: burrow, clock },
    {
      network: 'mainnet',
      contractId: deps.burrowId,
      expectedOracleId: accountIdSchema.parse('priceoracle.near'),
    },
  );
  const cache = new Map<string, { at: number; body: unknown }>();

  /** Confirmed prices of the latest snapshot: the median of the valid USD quotes per token. */
  const latestPrices = async () => {
    const snap = await store.latestSnapshot();
    if (!snap) return new Map<string, number>();
    const obs = await store.pricesForSnapshot(snap.id);
    const by = new Map<string, typeof obs>();
    for (const o of obs) by.set(o.asset, [...(by.get(o.asset) ?? []), o]);
    const out = new Map<string, number>();
    for (const [asset, list] of by) {
      const c = consensus(list);
      if (c.price !== null) out.set(asset, c.price);
    }
    const summary = (snap.summary ?? {}) as {
      prices?: { token: string; usd: string; quality: string }[];
    };
    for (const p of summary.prices ?? []) if (p.quality === 'OK') out.set(p.token, Number(p.usd));
    return out;
  };

  app.get('/v1/analytics/account/:id', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    const id = parsed.data;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit.body;

    let nativeYocto: bigint;
    try {
      nativeYocto = await native.getNativeBalance(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(/does not exist|UNKNOWN_ACCOUNT/i.test(msg) ? 404 : 502).send({
        error: /does not exist|UNKNOWN_ACCOUNT/i.test(msg)
          ? `account ${id} does not exist on NEAR mainnet`
          : `could not read the account: ${msg}`,
      });
    }
    const [assets, markets, meta, prices, account] = await Promise.all([
      burrow.listAssets(),
      store.markets(),
      store.tokenMetadata(),
      latestPrices(),
      burrow.getAccount(id).catch(() => null),
    ]);
    // Wallet balances of every token Burrow lists (the tokens an action could use), read in parallel.
    const wallet = new Map<TokenId, bigint>();
    await Promise.all(
      assets.map(async (a) => {
        const raw = await tokens.getBalance(a.tokenId, id).catch(() => 0n);
        if (raw > 0n) wallet.set(a.tokenId, raw);
      }),
    );
    const symbol = new Map(meta.map((m) => [m.token, m] as const));
    const facts = new Map<string, TokenFacts>();
    for (const a of assets) {
      const m = symbol.get(a.tokenId);
      facts.set(a.tokenId, {
        decimals: m?.decimals ?? (a.tokenId === WNEAR ? 24 : 18),
        symbol: m?.symbol ?? a.tokenId.slice(0, 10),
        usd: prices.get(a.tokenId) ?? null,
        extraDecimals: a.extraDecimals,
        vr: a.volatilityRatioBps / 10_000,
      });
    }
    const reads: AccountReads = {
      accountId: id,
      nativeYocto,
      wallet,
      burrow: account && {
        supplied: account.supplied.map((x) => ({ token: x.tokenId, inner: x.inner })),
        collateral: account.collateral.map((x) => ({ token: x.tokenId, inner: x.inner })),
        borrowed: account.borrowed.map((x) => ({ token: x.tokenId, inner: x.inner })),
      },
    };
    const v = valueAccount(reads, facts);
    const market = (t: string) =>
      markets.find((m) => m.token === t)?.latest as (LoopMarket & { status?: string }) | undefined;
    const rate = (t: string, f: 'netSupplyApr' | 'borrowApr') => {
      const m = market(t);
      const x = m?.status === 'OK' ? (m[f] ?? (f === 'netSupplyApr' ? m.supplyApr : null)) : null;
      return x === null || x === undefined ? null : Number(x);
    };
    const sym = (t: string) => facts.get(t)?.symbol ?? t;
    const actions: PortfolioAction[] = [];
    const add = (
      a: Omit<PortfolioAction, 'netUsd' | 'netAprOnCapital' | 'horizonDays' | 'autopilot'> & {
        autopilot?: PortfolioAction['autopilot'];
      },
    ) => {
      if (a.grossUsd === null || a.capitalUsd <= 0) return;
      const cost = a.costs.reduce((s, c) => s + c.usd, 0);
      const net = a.grossUsd - cost;
      actions.push({
        ...a,
        horizonDays: HORIZON,
        netUsd: net,
        netAprOnCapital: (net / a.capitalUsd) * (365 / HORIZON),
        autopilot: a.autopilot ?? hurdle(net, a.grossUsd, cost),
      });
    };
    const walletHoldings = v.holdings.filter(
      (h) => h.where === 'wallet' && h.usd !== null && h.usd >= 1,
    );
    // 1. repay a loan with the same token sitting idle in the wallet
    for (const debt of v.holdings.filter((h) => h.where === 'borrowed' && h.usd !== null)) {
      const idle = walletHoldings.find((w) => w.token === debt.token);
      const b = rate(debt.token, 'borrowApr');
      if (!idle?.usd || !debt.usd || b === null) continue;
      const repay = Math.min(idle.usd, debt.usd);
      add({
        id: `repay-${debt.token}`,
        kind: 'keep',
        title: `Repay ${money(repay)} of your ${debt.symbol} loan`,
        summary: `The loan costs ${(b * 100).toFixed(1)}% a year and you hold idle ${debt.symbol} in the wallet. Repaying saves that interest and makes the loan safer.`,
        capitalUsd: repay,
        grossUsd: repay * b * H,
        costs: [{ label: 'Network fee (gas)', usd: GAS }],
        risk: 'low',
        steps: [`Repay ${money(repay)} ${debt.symbol} on Burrow.`],
        risks: ['You no longer have this amount at hand.'],
        basis: `Interest saved at today's ${debt.symbol} borrow rate for ${HORIZON} days.`,
      });
    }
    // 2. lend each idle token Burrow accepts (native NEAR as wNEAR, keeping a reserve for gas)
    for (const w of walletHoldings) {
      const token = w.token === 'near' ? WNEAR : w.token;
      const s = rate(token, 'netSupplyApr');
      const usdPer = w.usd !== null && w.amount > 0 ? w.usd / w.amount : 0;
      const capital =
        w.token === 'near' ? Math.max(0, (w.amount - NEAR_RESERVE) * usdPer) : (w.usd ?? 0);
      if (s === null || s <= 0 || capital < 1) continue;
      add({
        id: `lend-${w.token}`,
        kind: 'lend',
        title: `Lend your idle ${w.symbol} on Burrow`,
        summary: `Deposit it and earn the ${(s * 100).toFixed(2)}% supply rate.${w.token === 'near' ? ` ${NEAR_RESERVE} NEAR stays in the wallet for fees.` : ''}`,
        capitalUsd: capital,
        grossUsd: capital * s * H,
        costs: [
          {
            label:
              w.token === 'near'
                ? 'Network fees (wrap, deposit, withdraw)'
                : 'Network fees (deposit, withdraw)',
            usd: (w.token === 'near' ? 3 : 2) * GAS,
          },
        ],
        risk: 'low',
        steps: [
          ...(w.token === 'near' ? ['Wrap NEAR to wNEAR.'] : []),
          `Deposit ${money(capital)} of ${w.symbol} into Burrow.`,
        ],
        risks: [
          'Variable rate; withdrawals can wait when almost everything is borrowed.',
          'Smart-contract risk.',
        ],
        basis: `Today's supply rate for ${HORIZON} days, not compounded.`,
      });
    }
    // 3. swap idle NEAR into a stablecoin through the allowlisted pool, with a REAL quote, and lend it
    const nearIdle = walletHoldings.filter((w) => w.token === 'near' || w.token === WNEAR);
    const nearUsdPrice = prices.get(WNEAR) ?? null;
    for (const pool of deps.pools) {
      const stable =
        pool.tokenA === WNEAR ? pool.tokenB : pool.tokenB === WNEAR ? pool.tokenA : null;
      const s = stable ? rate(stable, 'netSupplyApr') : null;
      const f = stable ? facts.get(stable) : undefined;
      const nearAmount = nearIdle.reduce(
        (a, w) => a + (w.token === 'near' ? Math.max(0, w.amount - NEAR_RESERVE) : w.amount),
        0,
      );
      if (!stable || s === null || !f?.usd || nearUsdPrice === null || nearAmount < 1) continue;
      const amountIn = BigInt(Math.floor(nearAmount * 1e6)) * 10n ** 18n;
      const q = await quoter
        .quote({ tokenIn: WNEAR, tokenOut: stable, amountIn })
        .catch(() => null);
      if (!q) continue;
      const inUsd = nearAmount * nearUsdPrice;
      const outUsd =
        (Number(q.amountOut / 10n ** BigInt(Math.max(0, f.decimals - 6))) / 1e6) * f.usd;
      add({
        id: `swap-lend-${stable}`,
        kind: 'lend',
        title: `Swap idle NEAR to ${sym(stable)} and lend it`,
        summary: `${sym(stable)} earns ${(s * 100).toFixed(2)}% on Burrow; the swap price is a live Rhea quote.`,
        capitalUsd: inUsd,
        grossUsd: outUsd * s * H,
        costs: [
          {
            label: `Swap cost (live quote, pool #${pool.poolId})`,
            usd: Math.max(0, inUsd - outUsd),
          },
          { label: 'Network fees (wrap, swap, deposit, withdraw)', usd: 4 * GAS },
        ],
        risk: 'low',
        steps: [
          'Wrap NEAR to wNEAR.',
          `Swap ${nearAmount.toFixed(2)} wNEAR to ${sym(stable)} on Rhea (pool #${pool.poolId}).`,
          `Deposit into Burrow.`,
        ],
        risks: [
          'You give up NEAR price exposure on this part.',
          'Stablecoin peg risk; variable rate.',
        ],
        basis: "Live Rhea get_return quote vs the confirmed NEAR price; today's supply rate.",
      });
    }
    // 4. loops on the largest idle holding, for comparison only
    const biggest = [...walletHoldings].sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))[0];
    if (biggest?.usd)
      for (const l of loopStrategies(
        markets
          .filter((m) => m.token === (biggest.token === 'near' ? WNEAR : biggest.token))
          .map((m) => ({ ...(m.latest as LoopMarket), token: m.token })),
        {
          equityUsd: biggest.usd,
          targetHealthFactor: ORCH.risk.targetHealthFactorBps / 10_000,
          gasUsdPerTx: GAS,
          horizonDays: HORIZON,
        },
      ))
        // Shown for comparison only when it would actually earn after every cost (on a small amount the
        // network fees of the rounds alone exceed the interest, so it would only be a loss on display).
        if (l.netUsd > 0)
          add({
            id: `loop-${l.token}`,
            kind: 'loop',
            title: `Loop ${sym(l.token)} on Burrow (${l.leverage.toFixed(1)}× leverage)`,
            summary: `Deposit, borrow the same token, deposit again (${l.rounds} rounds): supply rate on ${money(l.depositedUsd)}, borrow rate on ${money(l.borrowedUsd)}.`,
            capitalUsd: l.equityUsd,
            grossUsd: l.grossUsd,
            costs: [
              { label: `Interest on ${money(l.borrowedUsd)} borrowed`, usd: l.borrowCostUsd },
              { label: 'Network fees (every round in and out)', usd: l.gasUsd },
            ],
            risk: 'high',
            steps: [
              `End state: ${money(l.depositedUsd)} deposited, ${money(l.borrowedUsd)} borrowed, health factor ${l.targetHealthFactor}.`,
            ],
            risks: [
              `Loses money above a ${(l.breakEvenBorrowApr * 100).toFixed(1)}% borrow rate.`,
              'Leverage multiplies rate and smart-contract risk.',
            ],
            basis:
              "Exact leverage from Burrow's health factor for the same token on both sides; today's rates.",
            autopilot: {
              verdict: 'not_allowed',
              sentence: 'Borrowing to loop raises risk; shown only for comparison.',
            },
          });
    actions.sort((a, b) => (b.netUsd ?? -Infinity) - (a.netUsd ?? -Infinity));

    // What the current Burrow position earns or costs per month at today's rates (deposits earn, loans cost).
    let monthly = 0;
    const noRate: string[] = [];
    for (const h of v.holdings) {
      // dust (under $1) in dead markets would only block the figure; larger positions without a rate are named
      if (h.where === 'wallet' || h.usd === null || h.usd < 1) continue;
      const r = rate(h.token, h.where === 'borrowed' ? 'borrowApr' : 'netSupplyApr');
      if (r === null) noRate.push(h.symbol);
      else monthly += (h.where === 'borrowed' ? -1 : 1) * h.usd * r * H;
    }
    const hasPosition = v.holdings.some((h) => h.where !== 'wallet');
    const [dclPositions, v1Positions, staking] = await Promise.all([
      dcl ? readDclPositions(dcl, id, symbol, prices) : Promise.resolve([]),
      readV1Positions(poolReader, deps.pools, id, symbol, prices),
      readStaking(tokens, id, symbol, prices),
    ]);

    const legs: PortfolioLeg[] = [];
    for (const h of v.holdings) {
      if (h.usd === null || h.usd <= 0) continue;
      legs.push({
        token: h.token,
        symbol: h.symbol,
        protocol: h.where === 'wallet' ? 'Wallet' : 'Burrow',
        usd: h.usd,
        kind: h.where === 'borrowed' ? 'debt' : 'asset',
      });
    }
    for (const s of staking)
      if (s.usd !== null)
        legs.push({
          token: s.token,
          symbol: s.symbol,
          protocol: 'Staking',
          usd: s.usd,
          kind: 'asset',
        });
    for (const d of dclPositions) {
      if (d.usdX !== null)
        legs.push({
          token: d.tokenX,
          symbol: d.symbolX,
          protocol: 'Rhea DCL',
          usd: d.usdX,
          kind: 'asset',
        });
      if (d.usdY !== null)
        legs.push({
          token: d.tokenY,
          symbol: d.symbolY,
          protocol: 'Rhea DCL',
          usd: d.usdY,
          kind: 'asset',
        });
    }
    for (const p of v1Positions)
      p.tokens.forEach((t, i) => {
        const u = p.usdPerToken[i];
        if (u !== null && u !== undefined)
          legs.push({
            token: t,
            symbol: p.symbols[i] ?? t,
            protocol: 'Rhea v1',
            usd: u,
            kind: 'asset',
          });
      });
    const metrics = portfolioMetrics(legs);
    const idleEarn = v.holdings
      .filter((h) => h.where === 'wallet' && h.usd !== null && h.usd >= 10)
      .map((h) => ({
        token: h.token,
        symbol: h.symbol,
        usd: h.usd as number,
        aprPct: (rate(h.token, 'netSupplyApr') ?? 0) * 100,
      }))
      .filter((a) => a.aprPct > 0)
      .sort((a, b) => b.usd - a.usd);
    const debts = v.holdings
      .filter((h) => h.where === 'borrowed' && h.usd !== null)
      .sort((a, b) => (b.usd as number) - (a.usd as number));
    const largestDebt = debts[0]
      ? { token: debts[0].token, symbol: debts[0].symbol, usd: debts[0].usd as number }
      : null;
    const dclOutOfRange = dclPositions
      .filter((d) => !d.inRange)
      .map((d) => ({
        lptId: d.lptId,
        poolId: d.poolId,
        pair: `${d.symbolX}/${d.symbolY}`,
        usd: d.usd,
      }))
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const recommendations = portfolioRecommendations({
      metrics,
      loan: { hasDebt: v.loan.hasDebt, healthFactor: v.loan.healthFactor },
      idleEarn,
      largestDebt,
      dclOutOfRange,
    });

    const body = {
      earnings: {
        monthlyNetUsd: hasPosition ? monthly : 0,
        sentence: !hasPosition
          ? 'Nothing is deposited on Burrow: the tokens in the wallet earn nothing.'
          : (monthly >= 0
              ? `Your Burrow position earns about ${money(monthly)} a month at today's rates.`
              : `Your Burrow position costs about ${money(-monthly)} a month: the loan interest is higher than what the deposits earn.`) +
            (noRate.length ? ` Not counted (no current rate): ${noRate.join(', ')}.` : ''),
      },
      accountId: id,
      network: 'mainnet',
      readOnly: true,
      asOf: new Date().toISOString(),
      holdings: v.holdings,
      unpriced: v.unpriced,
      totals: v.totals,
      dclPositions,
      v1Positions,
      staking,
      metrics,
      recommendations,
      loan: v.loan,
      health: !v.loan.hasDebt
        ? {
            level: 'low',
            label: 'No loan',
            sentence: 'Nothing is borrowed: there is nothing to liquidate.',
          }
        : v.loan.healthFactor === null
          ? {
              level: 'high',
              label: 'Unknown',
              sentence: 'The loan could not be valued: a price or a risk parameter is missing.',
            }
          : {
              level:
                v.loan.healthFactor >= 1.5 ? 'low' : v.loan.healthFactor >= 1.1 ? 'medium' : 'high',
              label:
                v.loan.healthFactor >= 1.5
                  ? 'Safe'
                  : v.loan.healthFactor >= 1.1
                    ? 'Needs watching'
                    : 'At risk',
              sentence:
                v.loan.collateralDropToLiquidation !== null
                  ? `Health factor ${v.loan.healthFactor.toFixed(2)}: the loan stays safe unless your collateral loses ${(v.loan.collateralDropToLiquidation * 100).toFixed(0)}% of its value.`
                  : 'The loan can be liquidated now.',
            },
      actions,
    };
    cache.set(id, { at: Date.now(), body });
    return body;
  });

  /**
   * Prepare a recommendation intent as an UNSIGNED transaction cascade the user signs in their own wallet. Read-only
   * on the server: verifies the Burrow deployment/token, resolves the exact amount, prepends registration if needed,
   * and returns the ordered transactions + a pre-sign preview. The server never signs and sends nothing.
   */
  app.post('/v1/wallet/prepare', async (req, reply) => {
    const usd = z.number().positive().max(1_000_000);
    const slip = z.number().int().min(1).max(1_000).default(50);
    const parsed = z
      .object({
        account: accountIdSchema,
        intent: z.discriminatedUnion('action', [
          z.object({ action: z.literal('supply'), token: accountIdSchema, approxUsd: usd }),
          z.object({ action: z.literal('repay'), token: accountIdSchema, approxUsd: usd }),
          z.object({
            action: z.literal('swap'),
            token: accountIdSchema,
            tokenOut: accountIdSchema,
            approxUsd: usd,
            maxSlippageBps: slip,
          }),
          z.object({
            action: z.literal('add_liquidity'),
            token: accountIdSchema,
            tokenOut: accountIdSchema,
            poolId: z.number().int().nonnegative(),
            approxUsd: usd,
          }),
          // reposition_dcl: exit an out-of-range DCL position back to the wallet (remove + withdraw).
          z.object({
            action: z.literal('reposition_dcl'),
            lptId: z.string().min(1),
            maxSlippageBps: slip,
          }),
          // unwrap: wNEAR -> native NEAR.
          z.object({ action: z.literal('unwrap'), approxUsd: usd }),
          // Burrow borrow / withdraw — priced through the oracle.
          z.object({ action: z.literal('borrow'), token: accountIdSchema, approxUsd: usd }),
          z.object({ action: z.literal('withdraw'), token: accountIdSchema, approxUsd: usd }),
        ]),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid prepare request' });
    const { account, intent } = parsed.data;

    // add_liquidity — balanced ("50/50") deposit into a Rhea v1 SIMPLE_POOL. Handled on its own: it sizes two
    // tokens at the pool's reserve ratio, so nothing is stranded, and assembles register? -> deposit x2 -> add.
    if (intent.action === 'add_liquidity') {
      const token0 = intent.token;
      const token1 = intent.tokenOut;
      try {
        const [prices, meta, pool, w0, w1, exchangeStorage] = await Promise.all([
          latestPrices(),
          store.tokenMetadata(),
          poolReader.getPool(intent.poolId),
          tokens.getBalance(token0, account).catch(() => 0n),
          tokens.getBalance(token1, account).catch(() => 0n),
          viewer.view(deps.rheaId, 'storage_balance_of', { account_id: account }).catch(() => null),
        ]);
        if (pool.kind !== 'SIMPLE_POOL')
          return reply.code(409).send({ error: `pool ${intent.poolId} is not a v1 SIMPLE_POOL` });
        // The pool reports its tokens in a fixed order; map the request's two tokens onto that order.
        const idx0 = pool.tokens.indexOf(token0);
        const idx1 = pool.tokens.indexOf(token1);
        if (idx0 < 0 || idx1 < 0 || idx0 === idx1)
          return reply
            .code(409)
            .send({ error: `pool ${intent.poolId} does not pair ${token0} with ${token1}` });
        const metaOf = (t: string) => meta.find((x) => x.token === t);
        const dec0 = metaOf(token0)?.decimals ?? 24;
        const dec1 = metaOf(token1)?.decimals ?? 24;
        const sym0 = metaOf(token0)?.symbol ?? token0.slice(0, 10);
        const sym1 = metaOf(token1)?.symbol ?? token1.slice(0, 10);
        const p0 = prices.get(token0);
        const p1 = prices.get(token1);
        if (p0 === undefined || !(p0 > 0))
          return reply.code(409).send({ error: `no confirmed price for ${token0}` });
        if (p1 === undefined || !(p1 > 0))
          return reply.code(409).send({ error: `no confirmed price for ${token1}` });
        const w0Human = Number(w0) / 10 ** dec0;
        const w1Human = Number(w1) / 10 ** dec1;
        if (w0Human <= 0 || w1Human <= 0)
          return reply
            .code(409)
            .send({ error: `your wallet must hold both ${sym0} and ${sym1} to add liquidity` });
        const { side0, side1 } = resolveBalancedLpAmounts({
          budgetUsd: intent.approxUsd,
          reserve0Human: Number(pool.reserves[idx0]) / 10 ** dec0,
          reserve1Human: Number(pool.reserves[idx1]) / 10 ** dec1,
          price0Usd: p0,
          price1Usd: p1,
          decimals0: dec0,
          decimals1: dec1,
          wallet0Human: w0Human,
          wallet1Human: w1Human,
        });
        if (side0.rawAmount <= 0n || side1.rawAmount <= 0n)
          return reply.code(409).send({ error: 'the resolved deposit amounts are zero' });
        const h0 = side0.humanAmount.toFixed(Math.min(6, dec0));
        const h1 = side1.humanAmount.toFixed(Math.min(6, dec1));

        const steps: CascadeStep[] = [];
        if (exchangeStorage === null) {
          const b = (await viewer.view(deps.rheaId, 'storage_balance_bounds', {})) as {
            min?: string;
          };
          const minDeposit = BigInt(b.min ?? '1020000000000000000000');
          steps.push({
            intentId: 'register-exchange',
            tx: buildExchangeStorageDeposit({
              contractId: deps.rheaId,
              accountId: account,
              deposit: minDeposit,
            }),
            preview: `Register on Rhea exchange — one-time, ${formatNear(minDeposit)} NEAR, refundable.`,
          });
        }
        steps.push({
          intentId: 'deposit-0',
          tx: buildExchangeDeposit({
            tokenId: token0,
            contractId: deps.rheaId,
            rawAmount: side0.rawAmount,
          }),
          preview: `Move ${h0} ${sym0} into your Rhea exchange balance.`,
        });
        steps.push({
          intentId: 'deposit-1',
          tx: buildExchangeDeposit({
            tokenId: token1,
            contractId: deps.rheaId,
            rawAmount: side1.rawAmount,
          }),
          preview: `Move ${h1} ${sym1} into your Rhea exchange balance.`,
        });
        // Order amounts into the pool's own token order for the call.
        const amounts: [bigint, bigint] =
          idx0 < idx1 ? [side0.rawAmount, side1.rawAmount] : [side1.rawAmount, side0.rawAmount];
        steps.push({
          intentId: 'add-liquidity',
          tx: buildV1AddLiquidity({ contractId: deps.rheaId, poolId: intent.poolId, amounts }),
          preview: `Add ${h0} ${sym0} + ${h1} ${sym1} to pool #${intent.poolId} (balanced; any dust stays in your exchange balance, withdrawable).`,
        });

        const cascade = assembleCascade(account, steps);
        const check = validateCascade(cascade.transactions, {
          signerId: account,
          allowedReceivers: new Set<string>([deps.rheaId, token0, token1]),
        });
        if (!check.ok)
          return reply
            .code(422)
            .send({ error: 'assembled cascade failed safety checks', reasons: check.reasons });
        return {
          account,
          intent,
          amounts: [
            { raw: side0.rawAmount.toString(), human: side0.humanAmount, symbol: sym0 },
            { raw: side1.rawAmount.toString(), human: side1.humanAmount, symbol: sym1 },
          ],
          transactions: cascade.transactions.map((t) => ({
            intentId: t.intentId,
            receiverId: t.receiverId,
            actions: t.actions.map((a) => ({
              methodName: a.methodName,
              args: a.args,
              gas: a.gas.toString(),
              deposit: a.deposit.toString(),
            })),
          })),
          preview: cascade.preview,
          signed: false,
          note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
        };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    // reposition_dcl — a concentrated-liquidity position has drifted out of range and earns nothing. The precise,
    // fully-safe action is to EXIT it back to the wallet (remove_liquidity -> withdraw both tokens); re-entering at a
    // new range is then a fresh balanced decision. (A true in-range re-center of a single-asset position needs a swap
    // to rebalance, which is deliberately not assembled here without a rebalancing quote.)
    if (intent.action === 'reposition_dcl') {
      if (!dcl) return reply.code(409).send({ error: 'DCL is not configured' });
      const dclId = deps.dclId;
      if (!dclId) return reply.code(409).send({ error: 'DCL is not configured' });
      try {
        const positions = await dcl.listPositions(account);
        const pos = positions.find((p) => p.lpt_id === intent.lptId);
        if (!pos)
          return reply
            .code(409)
            .send({ error: `${account} does not own DCL position ${intent.lptId}` });
        if (pos.v_liquidity !== undefined && pos.v_liquidity > 0n)
          return reply.code(409).send({
            error: `position ${intent.lptId} is staked in a farm; unstake it there before repositioning`,
          });
        if (pos.amount <= 0n)
          return reply.code(409).send({ error: `position ${intent.lptId} is already empty` });
        const pool = await dcl.getPool(pos.pool_id);
        if (!pool) return reply.code(409).send({ error: `pool ${pos.pool_id} not found` });
        const { tokenX, tokenY } = parsePoolId(pos.pool_id);
        const tokX = accountIdSchema.parse(tokenX);
        const tokY = accountIdSchema.parse(tokenY);
        // Expected freed amounts at the current price; used only as slippage-protected minimums for the removal.
        const freed = dclPositionAmounts(pos, pool.current_point);
        const keep = BigInt(10_000 - intent.maxSlippageBps);
        const minX = (freed.x * keep) / 10_000n;
        const minY = (freed.y * keep) / 10_000n;

        const meta = await store.tokenMetadata();
        const metaOf = (t: string) => meta.find((x) => x.token === t);
        const symX = metaOf(tokX)?.symbol ?? tokX.slice(0, 10);
        const symY = metaOf(tokY)?.symbol ?? tokY.slice(0, 10);
        const decX = metaOf(tokX)?.decimals ?? 24;
        const decY = metaOf(tokY)?.decimals ?? 24;
        const hX = (Number(freed.x) / 10 ** decX).toFixed(Math.min(6, decX));
        const hY = (Number(freed.y) / 10 ** decY).toFixed(Math.min(6, decY));

        const steps: CascadeStep[] = [
          {
            intentId: 'remove-liquidity',
            tx: buildRemoveLiquidity({
              dcl: dclId,
              lptId: intent.lptId,
              liquidity: pos.amount,
              minAmountX: minX,
              minAmountY: minY,
            }),
            preview: `Remove your out-of-range ${symX}/${symY} liquidity (≈ ${hX} ${symX} + ${hY} ${symY}, min ${(intent.maxSlippageBps / 100).toFixed(2)}% slippage).`,
          },
          {
            intentId: 'withdraw',
            tx: buildWithdrawAssets({ dcl: dclId, tokenIds: [tokX, tokY] }),
            preview: `Withdraw the freed ${symX} and ${symY} to your wallet (re-enter at a new range afterwards).`,
          },
        ];

        const cascade = assembleCascade(account, steps);
        const check = validateCascade(cascade.transactions, {
          signerId: account,
          allowedReceivers: new Set<string>([dclId]),
        });
        if (!check.ok)
          return reply
            .code(422)
            .send({ error: 'assembled cascade failed safety checks', reasons: check.reasons });
        return {
          account,
          intent,
          position: { lptId: pos.lpt_id, poolId: pos.pool_id },
          freed: [
            { raw: freed.x.toString(), human: Number(freed.x) / 10 ** decX, symbol: symX },
            { raw: freed.y.toString(), human: Number(freed.y) / 10 ** decY, symbol: symY },
          ],
          transactions: cascade.transactions.map((t) => ({
            intentId: t.intentId,
            receiverId: t.receiverId,
            actions: t.actions.map((a) => ({
              methodName: a.methodName,
              args: a.args,
              gas: a.gas.toString(),
              deposit: a.deposit.toString(),
            })),
          })),
          preview: cascade.preview,
          signed: false,
          note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
        };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    // unwrap — wNEAR back to native NEAR (a utility, e.g. after a swap left wNEAR in the wallet).
    if (intent.action === 'unwrap') {
      const WRAP = accountIdSchema.parse('wrap.near');
      try {
        const [prices, walletRaw] = await Promise.all([
          latestPrices(),
          tokens.getBalance(WRAP, account).catch(() => 0n),
        ]);
        const price = prices.get(WRAP);
        if (price === undefined || !(price > 0))
          return reply.code(409).send({ error: 'no confirmed price for wNEAR' });
        const walletHuman = Number(walletRaw) / 1e24;
        if (walletHuman <= 0) return reply.code(409).send({ error: 'your wallet holds no wNEAR' });
        const { rawAmount, humanAmount } = resolveIntentAmount(
          intent.approxUsd,
          price,
          24,
          walletHuman,
        );
        if (rawAmount <= 0n) return reply.code(409).send({ error: 'the resolved amount is zero' });
        const steps: CascadeStep[] = [
          {
            intentId: 'unwrap',
            tx: buildUnwrapNear({ wrapContractId: WRAP, rawAmount }),
            preview: `Unwrap ${humanAmount.toFixed(6)} wNEAR to native NEAR.`,
          },
        ];
        const cascade = assembleCascade(account, steps);
        const check = validateCascade(cascade.transactions, {
          signerId: account,
          allowedReceivers: new Set<string>([WRAP]),
        });
        if (!check.ok)
          return reply
            .code(422)
            .send({ error: 'assembled cascade failed safety checks', reasons: check.reasons });
        return {
          account,
          intent,
          amount: { raw: rawAmount.toString(), human: humanAmount, symbol: 'wNEAR' },
          transactions: cascade.transactions.map((t) => ({
            intentId: t.intentId,
            receiverId: t.receiverId,
            actions: t.actions.map((a) => ({
              methodName: a.methodName,
              args: a.args,
              gas: a.gas.toString(),
              deposit: a.deposit.toString(),
            })),
          })),
          preview: cascade.preview,
          signed: false,
          note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
        };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    // borrow / withdraw — priced Burrow actions routed through the verified oracle (oracle_call). No wallet balance
    // is needed (you borrow what you do not hold; you withdraw what Burrow holds). Burrow re-checks, at fresh prices,
    // that collateral still covers debt, or the call reverts on-chain.
    if (intent.action === 'borrow' || intent.action === 'withdraw') {
      try {
        const [prices, meta, acct, deployment] = await Promise.all([
          latestPrices(),
          store.tokenMetadata(),
          burrow.getAccount(account),
          burrowVerifier.verifyDeployment(),
        ]);
        const metaOf = (t: string) => meta.find((x) => x.token === t);
        const decimals = metaOf(intent.token)?.decimals ?? 24;
        const sym = metaOf(intent.token)?.symbol ?? intent.token.slice(0, 10);
        const price = prices.get(intent.token);
        if (price === undefined || !(price > 0))
          return reply.code(409).send({ error: `no confirmed price for ${intent.token}` });
        if (!acct) return reply.code(409).send({ error: `${account} has no Burrow account` });
        if (intent.action === 'borrow' && acct.collateral.length === 0)
          return reply.code(409).send({ error: 'you have no Burrow collateral to borrow against' });
        // The oracle must price every asset Burrow values for this account, plus the action token.
        const assetIds = [
          ...new Set<string>([
            intent.token,
            ...acct.collateral.map((b) => b.tokenId),
            ...acct.borrowed.map((b) => b.tokenId),
          ]),
        ];
        const verifiedToken = await burrowVerifier.verifyToken(
          deployment,
          intent.token,
          intent.action,
        );
        const { rawAmount, humanAmount } = resolveIntentAmount(intent.approxUsd, price, decimals);
        if (rawAmount <= 0n) return reply.code(409).send({ error: 'the resolved amount is zero' });
        const human = humanAmount.toFixed(Math.min(6, decimals));

        const common = { deployment, token: verifiedToken, now: clock.now(), rawAmount, assetIds };
        const steps: CascadeStep[] =
          intent.action === 'borrow'
            ? [
                {
                  intentId: 'borrow',
                  tx: buildBorrow(common),
                  preview: `Borrow ${human} ${sym} from Burrow against your collateral and send it to your wallet (Burrow caps this at what your collateral safely allows).`,
                },
              ]
            : [
                {
                  intentId: 'withdraw',
                  tx: buildWithdraw(common),
                  preview: `Withdraw up to ${human} ${sym} from your Burrow balance to your wallet (capped at your available balance).`,
                },
              ];

        const cascade = assembleCascade(account, steps);
        const check = validateCascade(cascade.transactions, {
          signerId: account,
          allowedReceivers: new Set<string>([deployment.oracleId]),
        });
        if (!check.ok)
          return reply
            .code(422)
            .send({ error: 'assembled cascade failed safety checks', reasons: check.reasons });
        return {
          account,
          intent,
          amount: { raw: rawAmount.toString(), human: humanAmount, symbol: sym },
          transactions: cascade.transactions.map((t) => ({
            intentId: t.intentId,
            receiverId: t.receiverId,
            actions: t.actions.map((a) => ({
              methodName: a.methodName,
              args: a.args,
              gas: a.gas.toString(),
              deposit: a.deposit.toString(),
            })),
          })),
          preview: cascade.preview,
          signed: false,
          note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
        };
      } catch (e) {
        return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    try {
      const [prices, meta, walletRaw] = await Promise.all([
        latestPrices(),
        store.tokenMetadata(),
        tokens.getBalance(intent.token, account).catch(() => 0n),
      ]);
      const metaOf = (t: string) => meta.find((x) => x.token === t);
      const decimals = metaOf(intent.token)?.decimals ?? 24;
      const sym = metaOf(intent.token)?.symbol ?? intent.token.slice(0, 10);
      const price = prices.get(intent.token);
      if (price === undefined || !(price > 0))
        return reply.code(409).send({ error: `no confirmed price for ${intent.token}` });
      const walletHuman = Number(walletRaw) / 10 ** decimals;
      // A swap FROM wNEAR can wrap native NEAR first (handled in the swap branch), so an empty wNEAR balance is not a
      // blocker here; other actions (supply/repay) do need the token in the wallet.
      const isWrapSwap = intent.action === 'swap' && intent.token === WRAP_NEAR_ID;
      if (walletHuman <= 0 && !isWrapSwap)
        return reply.code(409).send({ error: `your wallet holds no ${sym}` });
      const { rawAmount, humanAmount } = resolveIntentAmount(
        intent.approxUsd,
        price,
        decimals,
        walletHuman,
      );
      if (rawAmount <= 0n && !isWrapSwap)
        return reply.code(409).send({ error: 'the resolved amount is zero' });
      const human = humanAmount.toFixed(Math.min(6, decimals));

      const steps: CascadeStep[] = [];
      // Swap economics shown to the user (honest, real): slippage cap, what they get, and the price impact + fee
      // implied by the pool's reserves. Null for non-swap intents.
      let swapCost: {
        readonly slippageBps: number;
        readonly estReceived: { raw: string; human: number; symbol: string };
        readonly minReceived: { raw: string; human: number; symbol: string };
        readonly priceImpactPct: number | null;
      } | null = null;

      if (intent.action === 'swap') {
        const tokenOut = intent.tokenOut;
        if (!tokenOut) return reply.code(400).send({ error: 'a swap needs tokenOut' });

        // Swapping wNEAR but most of the holding is NATIVE NEAR: wrap the shortfall first (near_deposit, 1:1), so the
        // recommendation's size can actually be met. A buffer of native NEAR is left for gas and storage.
        let swapRawAmount = rawAmount;
        let swapHuman = humanAmount;
        // If native NEAR must be wrapped, do it as the FIRST action of the SAME transaction as the swap (both are
        // calls on wrap.near): near_deposit mints wNEAR, then ft_transfer_call spends it — one signature, not two.
        let wrapShortfall = 0n;
        if (intent.token === WRAP_NEAR_ID) {
          const nativeYocto = await native.getNativeBalance(account).catch(() => 0n);
          const NATIVE_BUFFER = 1_000_000_000_000_000_000_000_000n; // keep 1 NEAR native for gas + storage
          const wrappable = nativeYocto > NATIVE_BUFFER ? nativeYocto - NATIVE_BUFFER : 0n;
          const availHuman = walletHuman + Number(wrappable) / 1e24;
          const resized = resolveIntentAmount(intent.approxUsd, price, decimals, availHuman);
          swapRawAmount = resized.rawAmount;
          swapHuman = resized.humanAmount;
          if (swapRawAmount > walletRaw) wrapShortfall = swapRawAmount - walletRaw; // yocto == raw at 24 decimals
        }
        if (swapRawAmount <= 0n)
          return reply.code(409).send({ error: 'the resolved swap amount is zero' });

        const quote = await quoter.quote({
          tokenIn: intent.token,
          tokenOut,
          amountIn: swapRawAmount,
        });
        if (!quote)
          return reply
            .code(409)
            .send({ error: `no route for ${sym} -> ${tokenOut} in the allowlisted pools` });
        const minOut = (quote.amountOut * BigInt(10_000 - intent.maxSlippageBps)) / 10_000n;
        const decOut = metaOf(tokenOut)?.decimals ?? 24;
        const symOut = metaOf(tokenOut)?.symbol ?? tokenOut.slice(0, 10);
        const humanMinOut = (Number(minOut) / 10 ** decOut).toFixed(Math.min(6, decOut));
        // Price impact (incl. the pool fee) from the pool's reserves vs the executed rate; honest, no fabrication.
        let priceImpactPct: number | null = null;
        const poolInfo = await poolReader.getPool(quote.poolId).catch(() => null);
        if (poolInfo) {
          const iIn = poolInfo.tokens.indexOf(intent.token);
          const iOut = poolInfo.tokens.indexOf(tokenOut);
          const rIn = iIn >= 0 ? Number(poolInfo.reserves[iIn]) / 10 ** decimals : 0;
          const rOut = iOut >= 0 ? Number(poolInfo.reserves[iOut]) / 10 ** decOut : 0;
          const execIn = Number(swapRawAmount) / 10 ** decimals;
          const execOut = Number(quote.amountOut) / 10 ** decOut;
          if (rIn > 0 && rOut > 0 && execIn > 0) {
            const spot = rOut / rIn; // output per input at the pool mid-price
            const exec = execOut / execIn; // what this size actually gets
            priceImpactPct = Math.max(0, (1 - exec / spot) * 100);
          }
        }
        swapCost = {
          slippageBps: intent.maxSlippageBps,
          estReceived: {
            raw: quote.amountOut.toString(),
            human: Number(quote.amountOut) / 10 ** decOut,
            symbol: symOut,
          },
          minReceived: {
            raw: minOut.toString(),
            human: Number(minOut) / 10 ** decOut,
            symbol: symOut,
          },
          priceImpactPct,
        };
        // Register on the OUTPUT token first, or the swap output would be stranded on the exchange.
        if (!(await tokens.isStorageRegistered(tokenOut, account))) {
          const bounds = (await viewer.view(tokenOut, 'storage_balance_bounds', {})) as {
            min?: string;
          };
          const minDeposit = BigInt(bounds.min ?? '1250000000000000000000');
          steps.push({
            intentId: 'register-out',
            tx: {
              receiverId: tokenOut,
              actions: [
                {
                  type: 'FunctionCall',
                  methodName: 'storage_deposit',
                  args: { account_id: account },
                  gas: 10_000_000_000_000n,
                  deposit: minDeposit,
                },
              ],
            },
            preview: `Register to receive ${symOut} — one-time, ${formatNear(minDeposit)} NEAR, refundable.`,
          });
        }
        const swapActions: FunctionCallAction[] = [];
        if (wrapShortfall > 0n) {
          swapActions.push({
            type: 'FunctionCall',
            methodName: 'near_deposit',
            args: {},
            gas: 10_000_000_000_000n,
            deposit: wrapShortfall,
          });
        }
        swapActions.push({
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: deps.rheaId,
            amount: swapRawAmount.toString(),
            msg: JSON.stringify({
              force: 0,
              actions: [
                {
                  pool_id: quote.poolId,
                  token_in: intent.token,
                  token_out: tokenOut,
                  amount_in: swapRawAmount.toString(),
                  min_amount_out: minOut.toString(),
                },
              ],
            }),
          },
          gas: 180_000_000_000_000n,
          deposit: 1n,
        });
        const wrapNote =
          wrapShortfall > 0n ? `Wrap ${(Number(wrapShortfall) / 1e24).toFixed(6)} NEAR, then ` : '';
        steps.push({
          intentId: 'swap',
          tx: { receiverId: intent.token, actions: swapActions },
          preview: `${wrapNote}swap ${swapHuman.toFixed(Math.min(6, decimals))} ${sym} for at least ${humanMinOut} ${symOut} on Rhea (max ${(intent.maxSlippageBps / 100).toFixed(2)}% slippage).`,
        });
      } else {
        // supply / repay — Burrow, from proofs the verifier mints.
        const deployment = await burrowVerifier.verifyDeployment();
        const verifiedToken = await burrowVerifier.verifyToken(
          deployment,
          intent.token,
          intent.action === 'repay' ? 'repay' : 'supply',
        );
        if (intent.action === 'repay') {
          steps.push({
            intentId: 'repay',
            tx: buildRepay({ deployment, token: verifiedToken, now: clock.now(), rawAmount }),
            preview: `Repay up to ${human} ${sym} toward your Burrow loan (capped at the actual debt).`,
          });
        } else {
          if ((await burrow.getStorageBalance(account)) === null) {
            const b = await burrow.getStorageBalanceBounds();
            steps.push({
              intentId: 'register',
              tx: buildBurrowStorageDeposit({ deployment, accountId: account, deposit: b.min }),
              preview: `Register your account on Burrow — one-time, ${formatNear(b.min)} NEAR, refundable.`,
            });
          }
          steps.push({
            intentId: 'supply',
            tx: buildSupply({ deployment, token: verifiedToken, now: clock.now(), rawAmount }),
            preview: `Supply ${human} ${sym} to Burrow (earns the current supply rate).`,
          });
        }
      }

      const cascade = assembleCascade(account, steps);
      const allowed = new Set<string>([deps.burrowId, deps.rheaId, intent.token]);
      if (intent.action === 'swap') allowed.add(intent.tokenOut);
      const check = validateCascade(cascade.transactions, {
        signerId: account,
        allowedReceivers: allowed,
      });
      if (!check.ok)
        return reply
          .code(422)
          .send({ error: 'assembled cascade failed safety checks', reasons: check.reasons });
      // Upper-bound network fee: total prepaid gas × the minimum gas price (most of it is refunded in practice).
      const totalGas = cascade.transactions.reduce(
        (s, t) => s + t.actions.reduce((g, a) => g + a.gas, 0n),
        0n,
      );
      const networkFeeMaxNear =
        Number((totalGas * 100_000_000n) / 1_000_000_000_000_000_000n) / 1e6;
      return {
        account,
        intent,
        amount: { raw: rawAmount.toString(), human: humanAmount, symbol: sym },
        transactions: cascade.transactions.map((t) => ({
          intentId: t.intentId,
          receiverId: t.receiverId,
          actions: t.actions.map((a) => ({
            methodName: a.methodName,
            args: a.args,
            gas: a.gas.toString(),
            deposit: a.deposit.toString(),
          })),
        })),
        preview: cascade.preview,
        cost: { networkFeeMaxNear, swap: swapCost },
        signed: false,
        note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
      };
    } catch (e) {
      return reply.code(502).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
