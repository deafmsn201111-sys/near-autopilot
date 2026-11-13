import {
  accountIdSchema,
  BoundedMap,
  MissingPriceError,
  PreconditionError,
  UnsupportedIntentError,
  type AccountId,
  type FunctionCallAction,
  type TokenId,
} from '@near-autopilot/core';
import {
  BurrowClient,
  BurrowLendingReader,
  BurrowPriceOracle,
  BurrowVerifier,
  buildBorrow,
  buildBurrowStorageDeposit,
  buildRepay,
  buildSupply,
  buildWithdraw,
} from '@near-autopilot/burrow-adapter';
import { exactAmount, resolveBalancedLpAmounts, resolveIntentAmount } from '../wallet/amounts';
import { buildUnwrapNear } from '../wallet/wrap';
import { assembleCascade, formatNear, type CascadeStep } from '../wallet/cascade';
import { validateCascade } from '../wallet/validate-cascade';
import { OWNERSHIP_HEADER, proofFromHeader, verifyOwnership } from '../wallet/ownership';
import { z } from 'zod';
import {
  NearAccountReader,
  NearChainContextProvider,
  NearContractViewer,
  NearTokenReader,
  type NearRpcClient,
} from '@near-autopilot/near-adapter';
import {
  assessRisk,
  orchestratorConfigSchema,
  type AgentObservation,
} from '@near-autopilot/orchestrator';
import type { PriceOracle, UnitPrice } from '@near-autopilot/core';
import { parseDecimal, toUnitPrice } from '../market-data/decimal';
import { SnapshotService } from '../services/snapshot';
import { toWad } from '../yield/math';
import {
  analyseAccount,
  MIN_ACTION_USD,
  approxUsdOf,
  walletAgentConfig,
  type AnalysisContext,
  type ToolLlmDeps,
} from './ai-analysis';
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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CollectorStore } from '../collector/store';
import { isSmall, valueAccount, type AccountReads, type Holding, type TokenFacts } from './account';
import { displaySymbol, type AccountDiscovery } from './discovery';
import { loopStrategies, type LoopMarket } from './looping';
import { hurdle, money, type PortfolioAction } from './portfolio-view';
import { consensus } from './series';
import { isKnownToken, modelTokenLabel } from '../thesis/labels';

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
  /** Indexers that find what the account holds outside the allowlists. Null or absent: only the allowlists are read. */
  readonly discovery?: AccountDiscovery | null;
  /** The central LLM and its spend ledger for `POST …/analysis`. Null or absent: that route answers with the rule-based list. */
  readonly ai?: ToolLlmDeps | null;
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

interface NativeStakeView {
  readonly pool: string;
  readonly kind: 'staked' | 'unstaked';
  readonly amount: number;
  readonly usd: number | null;
}

/** NEAR delegated to validator pools: staked and unstaked (waiting to be withdrawn) balances, read on-chain. */
async function readNativeStaking(
  viewer: NearContractViewer,
  pools: readonly string[],
  accountId: AccountId,
  nearUsd: number | null,
): Promise<NativeStakeView[]> {
  const yocto = z.string().regex(/^\d{1,39}$/);
  const read = async (pool: string, kind: NativeStakeView['kind']) => {
    const method =
      kind === 'staked' ? 'get_account_staked_balance' : 'get_account_unstaked_balance';
    const raw = await viewer
      .view(accountIdSchema.parse(pool), method, { account_id: accountId })
      .catch(() => null);
    const parsed = yocto.safeParse(raw);
    if (!parsed.success || BigInt(parsed.data) <= 0n) return [];
    const amount = Number(BigInt(parsed.data) / 10n ** 18n) / 1e6;
    return [{ pool, kind, amount, usd: nearUsd === null ? null : amount * nearUsd }];
  };
  const out = await Promise.all(pools.flatMap((p) => [read(p, 'staked'), read(p, 'unstaked')]));
  return out.flat();
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
  poolIds: readonly number[],
  accountId: AccountId,
  metaOf: (token: string) => Promise<{ symbol: string; decimals: number } | undefined>,
  prices: ReadonlyMap<string, number>,
): Promise<V1PositionView[]> {
  const out: V1PositionView[] = [];
  await Promise.all(
    poolIds.map(async (poolId) => {
      const shares = await reader.getPoolShares(poolId, accountId).catch(() => 0n);
      if (shares <= 0n) return;
      const pool = await reader.getPool(poolId).catch(() => null);
      if (!pool || pool.sharesTotalSupply <= 0n) return;
      const metas = await Promise.all(pool.tokens.map(metaOf));
      const symbols: string[] = [];
      const amounts: number[] = [];
      const usdPerToken: (number | null)[] = [];
      let usd: number | null = 0;
      pool.tokens.forEach((t, i) => {
        const raw = ((pool.reserves[i] ?? 0n) * shares) / pool.sharesTotalSupply;
        const f = metas[i];
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
        poolId,
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
  metaOf: (token: string) => Promise<{ symbol: string; decimals: number } | undefined>,
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
    const [fx, fy] = await Promise.all([metaOf(pool.token_x), metaOf(pool.token_y)]);
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
const ORACLE_ID = accountIdSchema.parse('priceoracle.near');
/** `valueAccount` lists native NEAR under this pseudo token; the snapshot reads it as `nativeBalance`. */
const NATIVE_HOLDING = 'near';

const ORCH = orchestratorConfigSchema.parse({});
const GAS = ORCH.swap.estimatedGasUsd;
const HORIZON = ORCH.swap.horizonDays;
const H = HORIZON / 365;
const WNEAR = 'wrap.near' as TokenId;
/** At most this many tokens outside Burrow's list are read per account (each costs an `ft_metadata` view call). */
const MAX_UNLISTED_TOKENS = 30;
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
    // Native NEAR and wNEAR are one price exposure; grouped under wrap.near, the token a swap intent can sell.
    const isNear = l.token === NATIVE_HOLDING || l.token === WNEAR;
    const token = isNear ? WNEAR : l.token;
    const e = byTokenMap.get(token) ?? { token, symbol: isNear ? 'NEAR' : l.symbol, usd: 0 };
    e.usd += l.usd;
    byTokenMap.set(token, e);
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

export interface AccountPositions {
  readonly holdings: readonly Holding[];
  readonly staking: readonly Pick<StakingView, 'token' | 'symbol' | 'amount' | 'usd'>[];
  readonly dclPositions: readonly Pick<
    DclPositionView,
    'lptId' | 'tokenX' | 'tokenY' | 'symbolX' | 'symbolY' | 'usdX' | 'usdY'
  >[];
  readonly v1Positions: readonly Pick<
    V1PositionView,
    'poolId' | 'tokens' | 'symbols' | 'usdPerToken'
  >[];
  readonly nativeStaking?: readonly NativeStakeView[];
  /** Whether a token is on our list and whether its price is an estimate. Absent: every token is listed and confirmed. */
  readonly trust?: (token: string) => { verified: boolean; estimate: boolean };
}

/** A holdings-table row beside the wallet and Burrow holdings: an LP position, or staking the wallet list lacks. */
export interface PositionRow {
  readonly key: string;
  readonly label: string;
  readonly sub: string;
  readonly amount: number | null;
  /** Null when no leg has a price; then the row is listed but adds nothing to the totals. */
  readonly usd: number | null;
  /** False when any leg is a token outside our list. */
  readonly verified: boolean;
  /** True when any priced leg uses an indexer estimate. */
  readonly estimate: boolean;
  readonly small: boolean;
}

/**
 * The one list of priced legs behind every total and percentage of the account view: wallet and Burrow holdings, Rhea
 * v1 + DCL liquidity split into its tokens, and liquid staking. A staking token is a wallet balance, so it counts
 * once: only when the wallet list does not already hold it. `positions` are the same legs grouped per LP position,
 * so the holdings and positions together add up to `totals.assetsUsd`.
 */
export function accountPortfolio(p: AccountPositions) {
  const legs: PortfolioLeg[] = [];
  const positions: PositionRow[] = [];
  const trust = p.trust ?? (() => ({ verified: true, estimate: false }));
  const position = (
    row: Omit<PositionRow, 'usd' | 'verified' | 'estimate' | 'small'>,
    parts: readonly { token: string; symbol: string; usd: number | null | undefined }[],
    protocol: string,
  ) => {
    let usd: number | null = null;
    let estimate = false;
    for (const x of parts)
      if (x.usd !== null && x.usd !== undefined && x.usd > 0) {
        legs.push({ token: x.token, symbol: x.symbol, protocol, usd: x.usd, kind: 'asset' });
        usd = (usd ?? 0) + x.usd;
        estimate ||= trust(x.token).estimate;
      }
    const verified = parts.every((x) => trust(x.token).verified);
    positions.push({ ...row, usd, verified, estimate, small: isSmall(usd, row.amount, verified) });
  };
  for (const h of p.holdings) {
    if (h.usd === null || h.usd <= 0) continue;
    legs.push({
      token: h.token,
      symbol: h.symbol,
      protocol: h.where === 'wallet' ? 'Wallet' : 'Burrow',
      usd: h.usd,
      kind: h.where === 'borrowed' ? 'debt' : 'asset',
    });
  }
  for (const v of p.v1Positions)
    position(
      { key: `v1-${v.poolId}`, label: v.symbols.join('/'), sub: 'Rhea liquidity', amount: null },
      v.tokens.map((t, i) => ({ token: t, symbol: v.symbols[i] ?? t, usd: v.usdPerToken[i] })),
      'Rhea v1',
    );
  for (const d of p.dclPositions)
    position(
      {
        key: `dcl-${d.lptId}`,
        label: `${d.symbolX}/${d.symbolY}`,
        sub: 'Rhea concentrated liquidity',
        amount: null,
      },
      [
        { token: d.tokenX, symbol: d.symbolX, usd: d.usdX },
        { token: d.tokenY, symbol: d.symbolY, usd: d.usdY },
      ],
      'Rhea DCL',
    );
  const inWallet = new Set(p.holdings.filter((h) => h.where === 'wallet').map((h) => h.token));
  for (const s of p.staking.filter((x) => !inWallet.has(x.token)))
    position(
      { key: `staking-${s.token}`, label: s.symbol, sub: 'Liquid staking', amount: s.amount },
      [s],
      'Staking',
    );
  for (const s of p.nativeStaking ?? [])
    position(
      {
        key: `${s.kind}-${s.pool}`,
        label: 'NEAR',
        sub: s.kind === 'staked' ? `Staked with ${s.pool}` : `Unstaking from ${s.pool}`,
        amount: s.amount,
      },
      [{ token: NATIVE_HOLDING, symbol: 'NEAR', usd: s.usd }],
      'Staking',
    );
  const metrics = portfolioMetrics(legs);
  const idleUsd = p.holdings
    .filter((h) => h.where === 'wallet')
    .reduce((s, h) => s + (h.usd ?? 0), 0);
  return {
    metrics,
    positions,
    totals: {
      assetsUsd: metrics.totalAssetsUsd,
      debtUsd: metrics.totalDebtUsd,
      netWorthUsd: metrics.netUsd,
      idleUsd,
    },
  };
}

export type RecommendationIntent =
  | { readonly action: 'swap'; readonly fromToken: string; readonly approxUsd: number }
  | {
      readonly action: 'repay' | 'supply';
      readonly token: string;
      readonly approxUsd: number;
      /** Exact amount in token base units when an orchestrator agent sized it; prepare uses it as is (capped). */
      readonly amount?: string;
    }
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
  /** USD of the concentration token sitting in the wallet: the most a swap can move (staked or pooled is locked). */
  readonly concentrationLiquidUsd?: number;
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

type Concentration = { readonly token: string; readonly pct: number } | null;

const money0 = (usd: number) => `$${Math.round(usd).toLocaleString('en-US')}`;
const money2 = (usd: number) =>
  `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const UNDER_MIN = `under the $${MIN_ACTION_USD} the agents act on`;

export interface PortfolioAdvice {
  readonly recommendations: PortfolioRecommendation[];
  /** Plain-language reasons for actions the agents saw but skipped as too small, so a small wallet still gets a read. */
  readonly skipped: string[];
}

/**
 * Portfolio-health recommendations derived from the real portfolio (brief: the agents analyse it and say what/why).
 * Each carries a concrete intent for the one-click transaction engine. Deterministic, explainable, ordered by urgency,
 * and never an instruction — the user decides and signs.
 */
export function portfolioAdvice(ctx: RecommendationContext): PortfolioAdvice {
  const recs: PortfolioRecommendation[] = [];
  const skipped: string[] = [];

  // 1. Loan safety first: a low health factor is the most time-sensitive thing.
  const hf = ctx.loan?.healthFactor ?? null;
  if (
    ctx.loan?.hasDebt &&
    hf !== null &&
    hf < 1.5 &&
    ctx.largestDebt &&
    ctx.largestDebt.usd >= 0.01
  ) {
    const debt = ctx.largestDebt.usd;
    const approxUsd = approxUsdOf(Math.min(debt, Math.max(debt * 0.3, MIN_ACTION_USD)));
    recs.push({
      id: 'improve-loan-safety',
      kind: 'improve_loan_safety',
      agent: 'Liquidation Guardian',
      severity: hf < 1.3 ? 'warning' : 'info',
      title: `Your loan's health factor is ${hf.toFixed(2)}`,
      why: `A health factor of ${hf.toFixed(2)} is close to the 1.0 liquidation line. Repaying about ${money2(approxUsd)} of your ${ctx.largestDebt.symbol} debt restores a safer buffer.`,
      intent: { action: 'repay', token: ctx.largestDebt.token, approxUsd },
    });
  }

  // 2. Reduce single-asset concentration.
  const c = ctx.metrics.concentration;
  const target = c ? (ctx.metrics.totalAssetsUsd * (c.pct - 50)) / 100 : 0;
  if (c && c.pct >= 60 && ctx.metrics.totalAssetsUsd > 0) {
    const approxUsd = approxUsdOf(Math.min(target, ctx.concentrationLiquidUsd ?? Infinity));
    if (approxUsd < MIN_ACTION_USD) {
      if (target < MIN_ACTION_USD && ctx.metrics.totalAssetsUsd >= 1)
        skipped.push(
          `${c.pct.toFixed(0)}% of your ${money2(ctx.metrics.totalAssetsUsd)} portfolio is in ${c.symbol}. Rebalancing it would move only ${money2(target)}, ${UNDER_MIN}, so they skip it until the portfolio grows.`,
        );
    } else {
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
  }

  // 3. Put idle cash to work: the largest priced wallet asset that earns a meaningful supply rate.
  const earning = ctx.idleEarn.filter((a) => a.aprPct >= 1);
  const idle = earning.find((a) => a.usd >= MIN_ACTION_USD);
  if (idle) {
    recs.push({
      id: 'put-idle-to-work',
      kind: 'put_idle_to_work',
      agent: 'Capital Allocator',
      severity: 'info',
      title: `${money0(idle.usd)} of ${idle.symbol} is sitting idle`,
      why: `${idle.symbol} in your wallet earns nothing. Supplying it on Burrow earns about ${idle.aprPct.toFixed(1)}% a year, and you can withdraw it any time.`,
      intent: { action: 'supply', token: idle.token, approxUsd: approxUsdOf(idle.usd) },
    });
  } else if (earning[0] && earning[0].usd >= 1) {
    const small = earning[0];
    skipped.push(
      `${money2(small.usd)} of ${small.symbol} could earn about ${small.aprPct.toFixed(1)}% a year on Burrow, but that is ${UNDER_MIN}.`,
    );
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

  return { recommendations: recs, skipped };
}

/** The fields of the account view the analysis reuses; the rest of the body is passed through untyped. */
interface AccountBody {
  readonly recommendations: readonly PortfolioRecommendation[];
  readonly holdings: readonly { readonly token: string; readonly verified: boolean }[];
  readonly [field: string]: unknown;
}

const ACCOUNT_CACHE_MAX = 500;
const ACCOUNT_CACHE_TTL_MS = 60_000;
const OWNER_CACHE_TTL_MS = ACCOUNT_CACHE_TTL_MS;
const FRESH_READ_GAP_MS = 5_000;
const freshQuery = z.object({ fresh: z.literal('1').optional() });

const REQUEST_PROBLEMS = [RangeError, MissingPriceError, PreconditionError, UnsupportedIntentError];

/** Why this request cannot be built is shown (422); upstream (RPC, contract) text stays in the log (502). */
export function prepareFailure(req: FastifyRequest, reply: FastifyReply, e: unknown) {
  if (REQUEST_PROBLEMS.some((kind) => e instanceof kind))
    return reply.code(422).send({ error: (e as Error).message });
  req.log.error({ err: e }, 'prepare failed');
  return reply.code(502).send({ error: 'could not prepare the transaction right now' });
}

export function registerAccountView(
  app: FastifyInstance,
  store: CollectorStore,
  deps: MainnetReadDeps,
) {
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
  const allowedPools: ReadonlySet<number> = new Set(deps.pools.map((p) => p.poolId));
  const clock = { now: () => new Date() };
  // Burrow transactions are only built from proofs this verifier mints (chain id, deployed code, oracle, listing).
  const burrowVerifier = new BurrowVerifier(
    { rpc: deps.rpc, client: burrow, clock },
    {
      network: 'mainnet',
      contractId: deps.burrowId,
      expectedOracleId: ORACLE_ID,
    },
  );
  const cache = new BoundedMap<
    string,
    {
      at: number;
      body: AccountBody;
      forModel: readonly PortfolioRecommendation[];
      concentration: Concentration;
    }
  >(ACCOUNT_CACHE_MAX);
  const freshReads = new BoundedMap<string, number>(ACCOUNT_CACHE_MAX);
  const mayReadFresh = (id: string) => {
    const at = freshReads.get(id);
    if (at !== undefined && Date.now() - at < FRESH_READ_GAP_MS) return false;
    freshReads.set(id, Date.now());
    return true;
  };
  const burrowOptions = { contractId: deps.burrowId, oracleId: ORACLE_ID };
  const lending = new BurrowLendingReader(viewer, burrowOptions);
  const burrowOracle = new BurrowPriceOracle(viewer, burrowOptions);
  const accessKeys = new NearChainContextProvider(deps.rpc);
  const ownership = {
    now: () => Date.now(),
    isFullAccessKey: async (account: string, publicKey: string) =>
      (await accessKeys.getContext(accountIdSchema.parse(account), publicKey)).permission.kind ===
      'full_access',
  };
  // Positive results only (junk proofs cost no memory), for 60 s: a revoked key or expired proof is honoured at most
  // that long.
  const owners = new BoundedMap<string, number>(ACCOUNT_CACHE_MAX);
  const isOwner = async (header: unknown, id: string) => {
    if (typeof header !== 'string') return false;
    const key = `${id}:${header}`;
    const at = owners.get(key);
    if (at !== undefined && Date.now() - at < OWNER_CACHE_TTL_MS) return true;
    const ok = await verifyOwnership(proofFromHeader(header), id, ownership);
    if (ok) owners.set(key, Date.now());
    else owners.delete(key);
    return ok;
  };

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

  const readAccount = async (
    id: AccountId,
    log: FastifyRequest['log'],
    fresh = false,
  ): Promise<
    | {
        status: 200;
        body: AccountBody;
        forModel: readonly PortfolioRecommendation[];
        concentration: Concentration;
      }
    | { status: 404 | 502; body: { error: string } }
  > => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ACCOUNT_CACHE_TTL_MS && !(fresh && mayReadFresh(id)))
      return { status: 200, ...hit };
    cache.delete(id);

    let nativeYocto: bigint;
    try {
      nativeYocto = await native.getNativeBalance(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/does not exist|UNKNOWN_ACCOUNT/i.test(msg))
        return { status: 404, body: { error: `account ${id} does not exist on NEAR mainnet` } };
      log.error({ err: e, account: id }, 'account read failed');
      return { status: 502, body: { error: 'could not read the account from NEAR right now' } };
    }
    const [assets, markets, meta, prices, account, found, foundPools, estimates] =
      await Promise.all([
        burrow.listAssets(),
        store.markets(),
        store.tokenMetadata(),
        latestPrices(),
        burrow.getAccount(id).catch(() => null),
        deps.discovery?.account(id) ?? null,
        deps.discovery?.v1PoolIds(id) ?? null,
        deps.discovery?.prices() ?? null,
      ]);
    // Wallet balances of every token Burrow lists (the tokens an action could use), read in parallel.
    const wallet = new Map<TokenId, bigint>();
    await Promise.all(
      assets.map(async (a) => {
        const raw = await tokens.getBalance(a.tokenId, id).catch(() => 0n);
        if (raw > 0n) wallet.set(a.tokenId, raw);
      }),
    );
    const symbol = new Map<string, { symbol: string; decimals: number }>(
      meta.map((m) => [m.token, m] as const),
    );
    // Our list: what Burrow lists and the tokens we name ourselves. Anything else is display-only.
    const burrowListed = new Set<string>(assets.map((a) => a.tokenId));
    const verified = { has: (t: string) => burrowListed.has(t) || isKnownToken(t) };
    // Display prices: the confirmed price, else the indexer's estimate. Actions only ever use `prices`.
    const shown = new Map(prices);
    for (const [t, usd] of estimates ?? []) if (!shown.has(t)) shown.set(t, usd);
    const trust = (t: string) => ({
      verified: verified.has(t),
      estimate: !prices.has(t) && shown.has(t),
    });
    const pending = new Map<string, Promise<{ symbol: string; decimals: number } | undefined>>();
    const metaOf = (t: string) => {
      const known = symbol.get(t);
      if (known) return Promise.resolve(known);
      const id = accountIdSchema.safeParse(t);
      if (!id.success) return Promise.resolve(undefined);
      const read =
        pending.get(t) ??
        tokens.getMetadata(id.data).then(
          (m) => ({ symbol: displaySymbol(m.symbol, t), decimals: m.decimals }),
          () => undefined,
        );
      pending.set(t, read);
      return read;
    };
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
    // Tokens the indexer found beyond Burrow's list: its balance, on-chain metadata, a confirmed or estimated price.
    await Promise.all(
      (found?.tokens ?? [])
        .filter((t) => !wallet.has(t.token as TokenId) && !facts.has(t.token))
        // ponytail: priced tokens first, then a hard cap on ft_metadata reads; a spam-heavy account loses its tail
        .sort((x, y) => Number(shown.has(y.token)) - Number(shown.has(x.token)))
        .slice(0, MAX_UNLISTED_TOKENS)
        .map(async (t) => {
          const m = await metaOf(t.token);
          if (!m) return;
          wallet.set(t.token as TokenId, t.raw);
          facts.set(t.token, {
            decimals: m.decimals,
            symbol: m.symbol,
            usd: shown.get(t.token) ?? null,
            ...trust(t.token),
          });
        }),
    );
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
      (h) => h.where === 'wallet' && h.verified && !h.estimate && h.usd !== null && h.usd >= 1,
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
    const v1PoolIds = [...new Set([...deps.pools.map((p) => p.poolId), ...(foundPools ?? [])])];
    const [dclPositions, v1Positions, staking, nativeStaking] = await Promise.all([
      dcl ? readDclPositions(dcl, id, metaOf, shown) : Promise.resolve([]),
      readV1Positions(poolReader, v1PoolIds, id, metaOf, shown),
      readStaking(tokens, id, symbol, prices),
      readNativeStaking(viewer, found?.stakingPools ?? [], id, prices.get(WNEAR) ?? null),
    ]);

    const { metrics, totals, positions } = accountPortfolio({
      holdings: v.holdings,
      staking,
      dclPositions,
      v1Positions,
      nativeStaking,
      trust,
    });
    // Recommendations only ever name a confirmed-price token on our list (#19); swapping an unlisted token is #90.
    const top = metrics.byToken.find((b) => verified.has(b.token) && !trust(b.token).estimate);
    const actionable = {
      ...metrics,
      concentration: top ? { token: top.token, symbol: top.symbol, pct: top.pct } : null,
    };
    const idleEarn = v.holdings
      .filter((h) => h.where === 'wallet' && h.verified && !h.estimate && h.usd !== null)
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
    const outOfRange = (pair: (d: DclPositionView) => string) =>
      dclPositions
        .filter(
          (d) =>
            !d.inRange && [d.tokenX, d.tokenY].every((t) => verified.has(t) && !trust(t).estimate),
        )
        .map((d) => ({ lptId: d.lptId, poolId: d.poolId, pair: pair(d), usd: d.usd }))
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const loan = { hasDebt: v.loan.hasDebt, healthFactor: v.loan.healthFactor };
    // A NEAR swap wraps native NEAR first, so NEAR and wNEAR in the wallet are one liquid amount.
    const nearLike = new Set<string>([NATIVE_HOLDING, WNEAR]);
    const sameAsset = (t: string) =>
      t === top?.token || (nearLike.has(t) && nearLike.has(top?.token ?? ''));
    const concentrationLiquidUsd = v.holdings
      .filter((h) => h.where === 'wallet' && sameAsset(h.token))
      .reduce((sum, h) => sum + (h.usd ?? 0), 0);
    const { recommendations, skipped } = portfolioAdvice({
      metrics: actionable,
      concentrationLiquidUsd,
      loan,
      idleEarn,
      largestDebt,
      dclOutOfRange: outOfRange((d) => `${d.symbolX}/${d.symbolY}`),
    });
    // The same list as the model sees it: ft_metadata symbols are untrusted text, so only our own labels.
    const labelled = <T extends { token: string }>(x: T) => ({
      ...x,
      symbol: modelTokenLabel(x.token),
    });
    const { recommendations: forModel } = portfolioAdvice({
      metrics: {
        ...actionable,
        concentration:
          actionable.concentration &&
          (actionable.concentration.token === WNEAR
            ? actionable.concentration
            : labelled(actionable.concentration)),
      },
      concentrationLiquidUsd,
      loan,
      idleEarn: idleEarn.map(labelled),
      largestDebt: largestDebt && labelled(largestDebt),
      dclOutOfRange: outOfRange((d) => `${modelTokenLabel(d.tokenX)}/${modelTokenLabel(d.tokenY)}`),
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
      // False: an indexer was down, so only the allowlisted tokens and pools were read.
      ...(deps.discovery && {
        discovery: { complete: found !== null && foundPools !== null && estimates !== null },
      }),
      holdings: v.holdings,
      unpriced: v.unpriced,
      totals,
      positions,
      dclPositions,
      v1Positions,
      staking,
      metrics,
      recommendations,
      skipped,
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
    const concentration = actionable.concentration && {
      token: actionable.concentration.token,
      pct: actionable.concentration.pct,
    };
    cache.set(id, { at: Date.now(), body, forModel, concentration });
    return { status: 200, body, forModel, concentration };
  };

  app.get('/v1/analytics/account/:id', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    // Verified per request, outside the cache: only the wallet's owner may unlock the LLM analysis.
    const ownerVerified = isOwner(req.headers[OWNERSHIP_HEADER], parsed.data);
    const fresh = freshQuery.safeParse(req.query).data?.fresh === '1';
    const out = await readAccount(parsed.data, req.log, fresh);
    if (out.status !== 200) return reply.code(out.status).send(out.body);
    return { ...out.body, ownerVerified: await ownerVerified };
  });

  /**
   * What the orchestrator agents see for this wallet: a fresh Burrow snapshot priced with the same confirmed collector
   * prices as the account view (so the agents' numbers match the portfolio table), today's Burrow supply rates as the
   * yield estimates, and Burrow's own oracle as the second price source for Market Intelligence (empty when it has no
   * recent price). The context is as old as the collector snapshot it was priced from.
   */
  const observe = async (id: AccountId, held: readonly TokenId[]): Promise<AgentObservation> => {
    const [markets, meta, prices, collected] = await Promise.all([
      store.markets(),
      store.tokenMetadata(),
      latestPrices(),
      store.latestSnapshot(),
    ]);
    const decimalsOf = (t: string) => meta.find((x) => x.token === t)?.decimals;
    const unitPrice = (usd: number | undefined, decimals: number | undefined) => {
      const d = usd !== undefined ? parseDecimal(String(usd)) : null;
      return d && d.mantissa > 0n && decimals !== undefined ? toUnitPrice(d, decimals) : null;
    };
    const pricedAt = collected?.takenAt ?? clock.now();
    const collectorOracle: PriceOracle = {
      getPrices: async (wanted) => {
        const out = new Map<TokenId, UnitPrice>();
        for (const t of wanted) {
          const p = unitPrice(prices.get(t), decimalsOf(t));
          if (p) out.set(t, p);
        }
        return { prices: out, asOf: pricedAt };
      },
    };
    const snapshot = await new SnapshotService({
      accountId: id,
      trackedTokens: held,
      native,
      tokens: {
        getBalance: (t, a) => tokens.getBalance(t, a).catch(() => 0n),
        getMetadata: async (t) => {
          const m = meta.find((x) => x.token === t);
          return m ? { id: t, symbol: m.symbol, decimals: m.decimals } : tokens.getMetadata(t);
        },
        isStorageRegistered: (t, a) => tokens.isStorageRegistered(t, a),
      },
      lending,
      oracle: collectorOracle,
      clock,
    }).take();
    const priced = [...snapshot.prices.keys()];
    const config = walletAgentConfig(priced);
    const estimatedYieldWad = new Map<TokenId, bigint>();
    for (const token of priced) {
      const m = markets.find((x) => x.token === token)?.latest as
        (LoopMarket & { status?: string }) | undefined;
      const apr = m?.status === 'OK' ? parseDecimal(m.netSupplyApr ?? m.supplyApr ?? '') : null;
      if (apr && apr.mantissa > 0n) estimatedYieldWad.set(token, toWad(apr));
    }
    const reference = await burrowOracle
      .getPrices(priced)
      .catch(() => ({ prices: new Map<TokenId, UnitPrice>() }));
    return {
      now: clock.now(),
      accountId: id,
      snapshot,
      market: {
        asOf: pricedAt,
        estimatedYieldWad,
        referencePrices: reference.prices,
        volatility24hBps: new Map(),
        lpPositions: [],
      },
      risk: assessRisk(snapshot, config),
      config,
    };
  };

  const analysisInputs = async (
    id: AccountId,
    log: FastifyRequest['log'],
  ): Promise<Omit<AnalysisContext, 'ownerVerified'> | { status: 404 | 502; error: string }> => {
    const view = await readAccount(id, log);
    if (view.status !== 200) return { status: view.status, error: view.body.error };
    const { holdings } = view.body;
    return {
      accountId: id,
      observe: () =>
        observe(id, [
          ...new Set(
            holdings
              .filter((h) => h.token !== NATIVE_HOLDING && h.verified)
              .map((h) => accountIdSchema.parse(h.token)),
          ),
        ]),
      heuristics: view.body.recommendations,
      checks: view.forModel,
      concentration: view.concentration,
    };
  };

  /** Architecture C (see ai-analysis.ts): the central LLM ranks and explains; code computes every number. */
  app.post('/v1/analytics/account/:id/analysis', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    const ownerVerified = isOwner(req.headers[OWNERSHIP_HEADER], parsed.data);
    const inputs = await analysisInputs(parsed.data, req.log);
    if ('error' in inputs) return reply.code(inputs.status).send({ error: inputs.error });
    return analyseAccount(
      deps.ai ?? null,
      { ...inputs, ownerVerified: await ownerVerified },
      (err) => req.log.warn({ err, account: parsed.data }, 'llm analysis fell back'),
    );
  });

  /**
   * Prepare a recommendation intent as an UNSIGNED transaction cascade the user signs in their own wallet. Read-only
   * on the server: verifies the Burrow deployment/token, resolves the exact amount, prepends registration if needed,
   * and returns the ordered transactions + a pre-sign preview. The server never signs and sends nothing.
   */
  app.post('/v1/wallet/prepare', async (req, reply) => {
    const usd = z.number().positive().max(1_000_000);
    const slip = z.number().int().min(1).max(1_000).default(50);
    const amount = z
      .string()
      .regex(/^[1-9]\d{0,38}$/)
      .optional(); // kept a string: the intent is echoed in the JSON reply
    const parsed = z
      .object({
        account: accountIdSchema,
        intent: z.discriminatedUnion('action', [
          z.object({ action: z.literal('supply'), token: accountIdSchema, approxUsd: usd, amount }),
          z.object({ action: z.literal('repay'), token: accountIdSchema, approxUsd: usd, amount }),
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
      if (!allowedPools.has(intent.poolId))
        return reply.code(409).send({ error: `pool ${intent.poolId} is not allowlisted` });
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
          allowedPools,
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
        return prepareFailure(req, reply, e);
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
        return prepareFailure(req, reply, e);
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
        return prepareFailure(req, reply, e);
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
        return prepareFailure(req, reply, e);
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
      const exact = 'amount' in intent ? intent.amount : undefined;
      const { rawAmount, humanAmount } =
        exact !== undefined
          ? exactAmount(BigInt(exact), walletRaw, decimals)
          : resolveIntentAmount(intent.approxUsd, price, decimals, walletHuman);
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
      return prepareFailure(req, reply, e);
    }
  });
  return { analysisInputs };
}
