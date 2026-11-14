import { PassThrough } from 'node:stream';
import {
  accountIdSchema,
  BoundedMap,
  hfAfterRepay,
  MissingPriceError,
  DEFAULT_STRATEGY,
  repayToReach,
  SWAP_REPAY_FLOOR_HF,
  swapRepayPlan,
  withdrawableToKeep,
  type RepaySizing,
  type RepaySource,
  errorMessage,
  PreconditionError,
  STRATEGIES,
  STRATEGY_IDS,
  strategySchema,
  UnsupportedIntentError,
  type AccountId,
  type FunctionCallAction,
  type Strategy,
  type StrategyId,
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
  buildRepayFromCollateral,
  buildSupply,
  buildWithdraw,
} from '@near-autopilot/burrow-adapter';
import { exactAmount, resolveBalancedLpAmounts, resolveIntentAmount } from '../wallet/amounts';
import { buildUnwrapNear } from '../wallet/wrap';
import {
  assembleCascade,
  formatNear,
  type CascadeStep,
  type PreparedCascade,
} from '../wallet/cascade';
import type { CascadeValidationContext } from '../wallet/validate-cascade';
import { sealCascade } from '../wallet/seal';
import { activityTimeline, eventRecorder, utcDay, type EventStore } from './events';
import { prepareSwapRepay } from '../wallet/swap-repay';
import { OWNERSHIP_HEADER, proofFromHeader, verifyOwnership } from '../wallet/ownership';
import { z } from 'zod';
import {
  NearAccountReader,
  NearChainContextProvider,
  NearContractViewer,
  NearTokenReader,
  type NearRpcClient,
} from '@near-autopilot/near-adapter';
import { assessRisk, orchestratorConfigSchema } from '@near-autopilot/orchestrator';
import type { PriceOracle, UnitPrice } from '@near-autopilot/core';
import { parseDecimal, toUnitPrice } from '../market-data/decimal';
import { SnapshotService } from '../services/snapshot';
import { toWad } from '../yield/math';
import {
  analyseAccount,
  type AnalysisEvent,
  MIN_ACTION_USD,
  MIN_SUPPLY_APR_PCT,
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
  buildRheaSwap,
  buildV1AddLiquidity,
} from '@near-autopilot/rhea-adapter';
import {
  RheaDclClient,
  dclPositionAmounts,
  buildRemoveLiquidity,
  buildWithdrawAssets,
  parsePoolId,
  type DclMarketDepth,
  type DclPool,
  type DclPosition,
} from '@near-autopilot/rhea-dcl-adapter';
import {
  RecentreRefused,
  lpObservation,
  recentreSteps,
  type WalletObservation,
} from './lp-recentre';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CollectorStore } from '../collector/store';
import { isSmall, valueAccount, type AccountReads, type Holding, type TokenFacts } from './account';
import { displaySymbol, type AccountDiscovery } from './discovery';
import { loopFor, loopStrategies, type LoopMarket } from './looping';
import { hurdle, money, type PortfolioAction } from './portfolio-view';
import { range24hBps, type SnapshotPrice, snapshotPrices } from './series';
import { isKnownToken, modelTokenLabel, STABLES } from '../thesis/labels';

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
  /** Reviewed DCL pools (config `rhea.dclPools`): the only pools a re-centre may add liquidity to. */
  readonly dclPools?: readonly string[];
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
const DAY_MS = 24 * 60 * 60 * 1000;
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
  readonly tokens: readonly { readonly token: string; readonly symbol: string }[];
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
    row: Omit<PositionRow, 'tokens' | 'usd' | 'verified' | 'estimate' | 'small'>,
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
    positions.push({
      ...row,
      tokens: parts.map((x) => ({ token: x.token, symbol: x.symbol })),
      usd,
      verified,
      estimate,
      small: isSmall(usd, row.amount, verified),
    });
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
      readonly action: 'repay' | 'repay_from_collateral' | 'supply' | 'withdraw';
      readonly token: string;
      readonly approxUsd: number;
      /** Exact amount in token base units when code sized it; prepare uses it as is (capped). */
      readonly amount?: string;
      /** Repay cards only: what the amount picker needs to recompute the health factor as the user changes it. */
      readonly sizing?: RepaySizing;
    }
  | { readonly action: 'reposition_dcl'; readonly lptId: string; readonly poolId: string }
  | SwapRepayIntent
  | {
      readonly action: 'recentre_dcl';
      readonly lptId: string;
      readonly poolId: string;
      readonly leftPoint: number;
      readonly rightPoint: number;
    };

/**
 * Repay a debt with another collateral token: withdraw it from Burrow (only what the wallet lacks), swap it on Rhea,
 * repay with the swap's minimum output plus any of the debt token already in the wallet. Separate transactions,
 * signed in order; the health factor never drops below SWAP_REPAY_FLOOR_HF after any of them (#69).
 */
export interface SwapRepayIntent {
  readonly action: 'repay_with_collateral';
  /** The debt token repaid. */
  readonly token: string;
  /** The collateral token withdrawn and swapped. */
  readonly collateralToken: string;
  /** USD of the repayment at the swap's minimum output. */
  readonly approxUsd: number;
  /** Collateral token to swap, base units (wallet first, then the withdrawal). */
  readonly amount: string;
  /** Collateral token to withdraw from Burrow, base units; absent when the wallet already holds enough. */
  readonly withdraw?: string;
  readonly maxSlippageBps: number;
  /** The card's estimate of the health factor after each step; prepare recomputes it from a fresh read. */
  readonly plan: {
    readonly hfNow: number;
    readonly hfAfterWithdraw: number;
    readonly hfAfterRepay: number | null;
    readonly floorHf: number;
    readonly transactions: 2 | 3;
  };
}

export interface PortfolioRecommendation {
  readonly id: string;
  readonly kind:
    | 'reduce_concentration'
    | 'improve_loan_safety'
    | 'put_idle_to_work'
    | 'reposition_dcl_position'
    | 'withdraw_from_burrow';
  /** Which agent produced it (the orchestrator's roles), so the dashboard can show who/why. */
  readonly agent: string;
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly why: string;
  /** The parameterised intent the transaction engine turns into a cascade to sign; null = advice with no button. */
  readonly intent: RecommendationIntent | null;
  /**
   * A computed line under the why. Loan cards: what the loan costs against what the deposits earn, so a profitable
   * loan never reads as bad. Idle cards: what the strategy weighed against plain supply.
   */
  readonly carry?: {
    readonly text: string;
    readonly provenance: 'calculated_estimate' | 'protocol_reported';
  };
}

/** Today's rates on the Burrow position; a side's figure is null when one of its positions is unpriced or unrated. */
export interface LoanCarry {
  readonly borrowAprPct: number | null;
  readonly loanMonthlyUsd: number | null;
  readonly depositsMonthlyUsd: number | null;
}

/** A token's Burrow-side numbers in whole tokens, for sizing a repay or a withdrawal. */
interface BurrowTokenFacts {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly usdPerToken: number;
  readonly vr: number;
}

export interface RecommendationContext {
  readonly metrics: PortfolioMetrics;
  /** USD of the concentration token sitting in the wallet: the most a swap can move (staked or pooled is locked). */
  readonly concentrationLiquidUsd?: number;
  readonly loan: {
    readonly hasDebt: boolean;
    readonly healthFactor: number | null;
    readonly collateralAdjUsd: number;
    readonly debtAdjUsd: number;
  } | null;
  /**
   * Wallet assets that are priced and could earn a Burrow supply rate, largest USD first. aprPct is a percentage.
   * loop is the token's Burrow market, for the same-asset loop an Aggressive strategy weighs.
   */
  readonly idleEarn: readonly {
    token: string;
    symbol: string;
    usd: number;
    aprPct: number;
    loop?: LoopMarket;
  }[];
  /** The largest debt, with what the wallet and the collateral hold of the same token (whole tokens). */
  readonly largestDebt:
    | (BurrowTokenFacts & {
        readonly usd: number;
        readonly amount: number;
        readonly wallet: number;
        readonly collateral: number;
      })
    | null;
  /** Priced Burrow supply per token (whole tokens): plain deposit and collateral. aprPct is null with no rate. */
  readonly burrowBalances: readonly (BurrowTokenFacts & {
    readonly deposited: number;
    readonly collateral: number;
    readonly aprPct: number | null;
  })[];
  /** borrowAprPct is the debts' rate weighted by their USD value. */
  readonly carry?: LoanCarry;
  /**
   * Another Burrow token that can repay the largest debt through an allowlisted Rhea pool (whole tokens), with the
   * swap rate at its minimum output from a live quote. Null without one.
   */
  readonly swapRepay?:
    | (BurrowTokenFacts & {
        readonly deposited: number;
        readonly collateral: number;
        readonly wallet: number;
        readonly outPerIn: number;
        readonly slippageBps: number;
      })
    | null;
  /** DCL LP positions currently out of range (earning no fees), largest USD first. */
  readonly dclOutOfRange: readonly {
    lptId: string;
    poolId: string;
    pair: string;
    usd: number | null;
  }[];
}

type Concentration = { readonly token: string; readonly pct: number } | null;

export function earningsSentence(
  monthly: number,
  hasPosition: boolean,
  noRate: readonly string[],
): string {
  if (!hasPosition) return 'Nothing is deposited on Burrow: the tokens in the wallet earn nothing.';
  const cents = Math.sign(monthly) * Math.round(Math.abs(monthly) * 100);
  const main =
    cents === 0
      ? "Your Burrow position roughly breaks even at today's rates: under $0.01 a month either way."
      : cents > 0
        ? `Your Burrow position earns about ${money(monthly)} a month at today's rates.`
        : `Your Burrow position costs about ${money(-monthly)} a month: the loan interest is higher than what the deposits earn.`;
  return main + (noRate.length ? ` Not counted (no current rate): ${noRate.join(', ')}.` : '');
}

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
export function portfolioAdvice(
  ctx: RecommendationContext,
  strategy: Strategy = STRATEGIES.balanced,
): PortfolioAdvice {
  const recs: PortfolioRecommendation[] = [];
  const skipped: string[] = [];

  // 1. Loan safety first: a low health factor is the most time-sensitive thing.
  const hf = ctx.loan?.healthFactor ?? null;
  if (
    ctx.loan?.hasDebt &&
    hf !== null &&
    hf < strategy.healthyAt &&
    ctx.largestDebt &&
    ctx.largestDebt.usd >= 0.01
  )
    recs.push({
      ...loanSafety(ctx.loan, hf, ctx.largestDebt, strategy, ctx.swapRepay ?? null),
      ...(ctx.carry && { carry: carryLine(ctx.carry) }),
    });

  // 2. Reduce single-asset concentration, swapping only what the wallet holds.
  const c = ctx.metrics.concentration;
  const target = c
    ? (ctx.metrics.totalAssetsUsd * (c.pct - strategy.concentrationTargetPct)) / 100
    : 0;
  if (c && c.pct >= strategy.concentrationInfoPct && ctx.metrics.totalAssetsUsd > 0) {
    const liquid = ctx.concentrationLiquidUsd ?? Infinity;
    const approxUsd = approxUsdOf(Math.min(target, liquid));
    if (target < MIN_ACTION_USD) {
      if (ctx.metrics.totalAssetsUsd >= 1)
        skipped.push(
          `${c.pct.toFixed(0)}% of your ${money2(ctx.metrics.totalAssetsUsd)} portfolio is in ${c.symbol}. Rebalancing it would move only ${money2(target)}, ${UNDER_MIN}, so they skip it until the portfolio grows.`,
        );
    } else {
      // Only what the wallet holds can be swapped; too little there leaves advice without a button.
      const advice = approxUsd < MIN_ACTION_USD;
      const where = advice
        ? liquid < 1
          ? ' None of it is in your wallet: it sits on Burrow or in liquidity, so withdraw it there first.'
          : ` Your wallet holds only ${money2(liquid)} of it; the rest sits on Burrow or in liquidity, so withdraw it there first.`
        : approxUsd < target
          ? ` Your wallet holds ${money0(approxUsd)} of it, so this swaps that part; the rest sits on Burrow or in liquidity.`
          : '';
      recs.push({
        id: 'reduce-concentration',
        kind: 'reduce_concentration',
        agent: 'Portfolio Intelligence',
        severity: c.pct >= strategy.concentrationWarningPct ? 'warning' : 'info',
        title: `${c.pct.toFixed(0)}% of your portfolio is in ${c.symbol}`,
        why: `A ${c.pct.toFixed(0)}% position in ${c.symbol} means a fall in ${c.symbol} hits almost your whole portfolio. Moving about ${money0(target)} of it into other assets brings it down toward ${strategy.concentrationTargetPct}% of the portfolio.${where}`,
        intent: advice ? null : { action: 'swap', fromToken: c.token, approxUsd },
      });
    }
  }

  // 3. Put idle cash to work: the wallet asset that earns the most dollars a year at its supply rate.
  const earning = ctx.idleEarn.filter((a) => a.aprPct >= MIN_SUPPLY_APR_PCT);
  const yearly = (a: (typeof earning)[number]) => (a.usd * a.aprPct) / 100;
  const [idle, runnerUp] = earning
    .filter((a) => a.usd >= MIN_ACTION_USD)
    .sort((a, b) => yearly(b) - yearly(a));
  if (idle) {
    const other = runnerUp
      ? ` Your ${money0(runnerUp.usd)} of ${runnerUp.symbol} would earn about ${money2(yearly(runnerUp))} a year.`
      : '';
    recs.push({
      id: 'put-idle-to-work',
      kind: 'put_idle_to_work',
      agent: 'Capital Allocator',
      severity: 'info',
      title: `${money0(idle.usd)} of ${idle.symbol} is sitting idle`,
      why: `${idle.symbol} in your wallet earns nothing. Supplying it on Burrow earns about ${idle.aprPct.toFixed(1)}% a year, about ${money2(yearly(idle))} a year, and you can withdraw it any time.${other}`,
      intent: { action: 'supply', token: idle.token, approxUsd: approxUsdOf(idle.usd) },
      carry: idleRule(idle, strategy),
    });
  } else if (earning[0] && earning[0].usd >= 0.1) {
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
      title: `Your ${oor.pair} liquidity is out of range: exit it to your wallet`,
      why: `This concentrated-liquidity position has drifted outside its price range, so it is earning no fees. This takes both tokens back to your wallet; you can add them to a new range later.`,
      intent: { action: 'reposition_dcl', lptId: oor.lptId, poolId: oor.poolId },
    });
  }

  // 5. Last: Burrow supply that can move to the wallet (all of it with no loan, else what keeps the HF at target).
  const withdrawal = withdrawable(ctx, strategy);
  if (withdrawal) recs.push(withdrawal);

  return { recommendations: recs, skipped };
}

const pct1 = (apr: number) => `${(apr * 100).toFixed(1)}%`;

/** What the strategy weighed against plain supply of this idle token (#132). The app never borrows: no loop button. */
function idleRule(
  idle: RecommendationContext['idleEarn'][number],
  strategy: Strategy,
): NonNullable<PortfolioRecommendation['carry']> {
  const { label, idle: rule, targetHealthFactor: h } = strategy;
  const supply = `${idle.aprPct.toFixed(1)}%`;
  if (!rule.weighsLoop)
    return {
      text: `${label}: Burrow supply at ${supply} a year; ${rule.rule}.`,
      provenance: 'protocol_reported',
    };
  const l =
    idle.loop &&
    loopFor(idle.loop, {
      equityUsd: idle.usd,
      targetHealthFactor: h,
      gasUsdPerTx: GAS,
      horizonDays: HORIZON,
    });
  if (!l)
    return {
      text: `${label}: ${rule.rule}, but no ${idle.symbol} loop can be computed from Burrow's market today, so this supplies at ${supply} a year.`,
      provenance: 'protocol_reported',
    };
  // after the gas of every round in and out, like the loop action: on a small amount the fees eat the interest
  const netApr = (l.netUsd / l.equityUsd) * (365 / l.horizonDays);
  const loop = `${label}: a ${l.leverage.toFixed(1)}× ${idle.symbol} loop at health factor ${h}`;
  const drift =
    l.daysToLiquidationFromRates === null
      ? ''
      : ` At today's rates its health factor reaches 1.0 in about ${Math.round(l.daysToLiquidationFromRates)} days without a top-up.`;
  const text =
    netApr * 100 <= idle.aprPct
      ? `${loop} would earn ${pct1(netApr)} a year after fees (${pct1(l.supplyApr)} supply on ${l.leverage.toFixed(1)}×, ${pct1(l.borrowApr)} borrow on ${(l.leverage - 1).toFixed(1)}×), less than plain supply at ${supply}, so this supplies.`
      : !l.fitsLiquidity
        ? `${loop} would earn ${pct1(netApr)} a year after fees, but Burrow has too little ${idle.symbol} left to lend for it, so this supplies at ${supply}.`
        : `${loop} would earn about ${pct1(netApr)} a year after fees (${money2(idle.usd * netApr)}), more than plain supply at ${supply}, but it borrows: it loses money above a ${pct1(l.breakEvenBorrowApr)} borrow rate and the loan can be liquidated.${drift} The app does not borrow; supplying is the first step of a loop.`;
  return { text, provenance: 'calculated_estimate' };
}

export function carryLine(c: LoanCarry): NonNullable<PortfolioRecommendation['carry']> {
  const loan =
    c.borrowAprPct === null || c.loanMonthlyUsd === null
      ? 'Loan rate unavailable'
      : `Loan costs ${c.borrowAprPct.toFixed(1)}% a year (≈ ${money2(c.loanMonthlyUsd)}/month)`;
  const deposits =
    c.depositsMonthlyUsd === null
      ? 'deposit rate unavailable'
      : `your Burrow deposits earn ≈ ${money2(c.depositsMonthlyUsd)}/month`;
  return { text: `${loan}; ${deposits}.`, provenance: 'calculated_estimate' };
}

/** A safe loan whose deposits earn more than it costs is the point of borrowing: nothing should offer to repay it. */
export function keepsProfitableLoan(ctx: RecommendationContext, strategy: Strategy): boolean {
  const hf = ctx.loan?.healthFactor ?? null;
  const loan = ctx.carry?.loanMonthlyUsd ?? null;
  const deposits = ctx.carry?.depositsMonthlyUsd ?? null;
  return (
    hf !== null && hf >= strategy.healthyAt && loan !== null && deposits !== null && deposits > loan
  );
}

/** The token a concentration card may name: the largest one we can act on, never a stablecoin. */
export const concentratedToken = <T extends { readonly token: string }>(
  byToken: readonly T[],
  actionable: (token: string) => boolean,
): T | undefined => byToken.find((b) => actionable(b.token) && !STABLES.has(b.token));

const DANGER_HF = ORCH.risk.dangerBelowBps / 10_000;

/** The loan's safety label on the account view: "Safe" from the strategy's healthy line, "At risk" below the agents' danger line. */
export function loanHealth(
  loan: {
    readonly hasDebt: boolean;
    readonly healthFactor: number | null;
    readonly collateralDropToLiquidation: number | null;
  },
  strategy: Strategy,
) {
  if (!loan.hasDebt)
    return {
      level: 'low',
      label: 'No loan',
      sentence: 'Nothing is borrowed: there is nothing to liquidate.',
    } as const;
  const hf = loan.healthFactor;
  if (hf === null)
    return {
      level: 'high',
      label: 'Unknown',
      sentence: 'The loan could not be valued: a price or a risk parameter is missing.',
    } as const;
  const safe = hf >= strategy.healthyAt;
  const watch = hf >= DANGER_HF;
  return {
    level: safe ? 'low' : watch ? 'medium' : 'high',
    label: safe ? 'Safe' : watch ? 'Needs watching' : 'At risk',
    sentence:
      loan.collateralDropToLiquidation !== null
        ? `Health factor ${hf.toFixed(2)}: the loan stays safe unless your collateral loses ${(loan.collateralDropToLiquidation * 100).toFixed(0)}% of its value.`
        : 'The loan can be liquidated now.',
  } as const;
}

type LoanForHealth = Parameters<typeof loanHealth>[0];

const presets = STRATEGY_IDS.map((id) => STRATEGIES[id]);
const span = (pick: (s: Strategy) => number) =>
  `${Math.min(...presets.map(pick))}–${Math.max(...presets.map(pick))}%`;

/** When the preset changes nothing on this account, one sentence on why, so the picker does not look broken. */
export function strategyNote(ctx: RecommendationContext, loan: LoanForHealth): string | null {
  const outcome = (s: Strategy) => JSON.stringify([portfolioAdvice(ctx, s), loanHealth(loan, s)]);
  if (new Set(presets.map(outcome)).size > 1) return null;
  const c = ctx.metrics.concentration;
  const hf = loan.healthFactor;
  const loanPart = !loan.hasDebt
    ? 'there is no loan'
    : hf !== null
      ? `your loan's health factor ${hf.toFixed(2)} is safe under all three`
      : 'your loan could not be valued';
  const tokenPart =
    c && c.pct >= 1
      ? `your largest non-stablecoin, ${c.symbol}, is ${c.pct.toFixed(0)}% of the portfolio`
      : 'you hold no non-stablecoin of note';
  return `All three strategies give the same advice here: ${loanPart}, and ${tokenPart}. A strategy changes when a loan counts as safe and how much to repay, and from what share one token (${span((s) => s.concentrationInfoPct)}) needs rebalancing.`;
}

/** The swap-repay card's slippage limit: the prepare default. */
const SWAP_REPAY_SLIPPAGE_BPS = 50;
/** The card plans the withdraw this far above SWAP_REPAY_FLOOR_HF, which prepare enforces at a fresh read. */
const CARD_FLOOR_MARGIN = 0.02;

const tokenText = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/** Whole tokens -> base units at up to 6 decimals, rounded `up` or down; null when that is zero. */
function rawOf(tokens: number, decimals: number, up: boolean): bigint | null {
  const places = Math.min(decimals, 6);
  const scaled = (up ? Math.ceil : Math.floor)(tokens * 10 ** places - (up ? 1e-6 : -1e-6));
  return scaled > 0 ? BigInt(scaled) * 10n ** BigInt(decimals - places) : null;
}

/**
 * Repay the largest debt down to the target health factor: from the wallet when it holds enough, otherwise from the
 * collateral of the same token (Burrow repays from the account's own balance). The card carries the sizing so the
 * user can pick another amount; with neither source it is advice only (a different-token unwind needs a swap).
 */
function loanSafety(
  loan: NonNullable<RecommendationContext['loan']>,
  hf: number,
  debt: NonNullable<RecommendationContext['largestDebt']>,
  strategy: Strategy,
  swap: NonNullable<RecommendationContext['swapRepay']> | null,
): PortfolioRecommendation {
  const targetHf = strategy.targetHealthFactor;
  const model = {
    collateralAdjUsd: loan.collateralAdjUsd,
    debtAdjUsd: loan.debtAdjUsd,
    vr: debt.vr,
    usdPerToken: debt.usdPerToken,
  };
  const walletNeed = repayToReach(model, targetHf, 'wallet');
  const from: RepaySource | null =
    debt.wallet > 0 && debt.wallet >= walletNeed
      ? 'wallet'
      : debt.collateral > 0
        ? 'collateral'
        : debt.wallet > 0
          ? 'wallet'
          : null;
  const near = `A health factor of ${hf.toFixed(2)} is under the ${strategy.healthyAt.toFixed(2)} your ${strategy.label} strategy counts as safe (1.0 is liquidation)`;
  const card = {
    id: 'improve-loan-safety',
    kind: 'improve_loan_safety',
    agent: 'Liquidation Guardian',
    severity: hf < strategy.warningBelow ? 'warning' : 'info',
    title: `Your loan's health factor is ${hf.toFixed(2)}`,
  } as const;
  // The wallet cannot cover the repay and no collateral is the debt token: swap another collateral token instead.
  if (swap && from !== 'collateral' && !(from === 'wallet' && debt.wallet >= walletNeed)) {
    const swapCard = swapRepayCard(loan, hf, debt, strategy, swap);
    if (swapCard.intent || !from) return { ...card, ...swapCard, why: `${near}${swapCard.why}` };
  }
  const maxTokens = Math.min(from === 'wallet' ? debt.wallet : debt.collateral, debt.amount);
  const raw =
    from && rawOf(Math.min(repayToReach(model, targetHf, from), maxTokens), debt.decimals, true);
  if (!from || !raw)
    return {
      ...card,
      why: `${near}. Your wallet holds no ${debt.symbol} to repay with and none of your collateral is ${debt.symbol}; repaying it from another token needs a swap first.`,
      intent: null,
    };
  const safeTokens = Math.min(Number(raw) / 10 ** debt.decimals, maxTokens);
  const after = hfAfterRepay(model, safeTokens, from);
  const usd = safeTokens * debt.usdPerToken;
  // Repaying from collateral only helps while HF > vr²; below that (already liquidatable) it would lower the HF.
  if (after !== null && after <= hf)
    return {
      ...card,
      why: `${near}. Repaying from your ${debt.symbol} collateral would not raise it at this point; repaying from the wallet or adding collateral would.`,
      intent: null,
    };
  return {
    ...card,
    why: `${near}${from === 'collateral' ? `, and your wallet does not hold enough ${debt.symbol} to repay with` : ''}. Repaying ${tokenText(safeTokens)} ${debt.symbol} (about ${money0(usd)}) from your ${from === 'wallet' ? 'wallet' : `${debt.symbol} collateral on Burrow`} ${after === null ? 'repays the whole loan' : `raises it to ${after.toFixed(2)}`}.`,
    intent: {
      action: from === 'wallet' ? 'repay' : 'repay_from_collateral',
      token: debt.token,
      approxUsd: Math.max(0.01, approxUsdOf(usd)),
      amount: raw.toString(),
      sizing: {
        ...model,
        symbol: debt.symbol,
        decimals: debt.decimals,
        hfNow: hf,
        targetHf,
        safeTokens,
        maxTokens,
        wholeDebt: maxTokens >= debt.amount,
      },
    },
  };
}

const ORDINAL = ['', 'one', 'two', 'three'] as const;

/** The withdraw -> swap -> repay card (#69); its `why` continues the caller's first sentence. */
function swapRepayCard(
  loan: NonNullable<RecommendationContext['loan']>,
  hf: number,
  debt: NonNullable<RecommendationContext['largestDebt']>,
  strategy: Strategy,
  swap: NonNullable<RecommendationContext['swapRepay']>,
): Pick<PortfolioRecommendation, 'why' | 'intent'> {
  const plan = swapRepayPlan({
    model: { collateralAdjUsd: loan.collateralAdjUsd, debtAdjUsd: loan.debtAdjUsd },
    collateral: swap,
    debt: { usdPerToken: debt.usdPerToken, vr: debt.vr, amount: debt.amount, wallet: debt.wallet },
    outPerIn: swap.outPerIn,
    target: strategy.targetHealthFactor,
    // Sized a little above the floor prepare enforces, so a small price tick before the click does not refuse it.
    floor: SWAP_REPAY_FLOOR_HF + CARD_FLOOR_MARGIN,
  });
  const lacks = `, and your wallet does not hold enough ${debt.symbol} to repay with`;
  if (!plan.ok)
    return {
      why:
        lacks +
        (plan.reason === 'floor'
          ? `. Repaying it with your ${swap.symbol} collateral would first withdraw some, which would take the health factor under ${SWAP_REPAY_FLOOR_HF.toFixed(2)}; add collateral or ${debt.symbol} to the wallet instead.`
          : plan.reason === 'no_gain'
            ? `. Swapping your ${swap.symbol} collateral into ${debt.symbol} to repay would not raise it at today's swap price.`
            : `; none of your collateral can be swapped into ${debt.symbol} for it.`),
      intent: null,
    };
  const swapRaw = rawOf(plan.swapIn, swap.decimals, false);
  const withdrawRaw = plan.withdraw > 0 ? rawOf(plan.withdraw, swap.decimals, false) : null;
  if (!swapRaw || plan.repay * debt.usdPerToken < 0.01)
    return {
      why: `${lacks}; the ${swap.symbol} swap that could repay it is too small.`,
      intent: null,
    };
  const transactions = withdrawRaw ? 3 : 2;
  const hf1 = plan.hfAfterWithdraw ?? hf;
  const end =
    plan.hfAfterRepay === null
      ? 'repays the whole loan'
      : `brings it to ${plan.hfAfterRepay.toFixed(2)}`;
  const steps = [
    ...(withdrawRaw
      ? [
          `withdraw ${tokenText(plan.withdraw)} ${swap.symbol} from your Burrow collateral (health factor ${hf.toFixed(2)} → ${hf1.toFixed(2)})`,
        ]
      : []),
    `swap ${tokenText(plan.swapIn)} ${swap.symbol}${plan.fromWallet > 0 && withdrawRaw ? ` (${tokenText(plan.fromWallet)} of it already in your wallet)` : ''} for at least ${tokenText(plan.minOut)} ${debt.symbol} on Rhea`,
    `repay ${tokenText(plan.repay)} ${debt.symbol}, which ${end}`,
  ];
  return {
    why: `${lacks}. This repays it with your ${swap.symbol} in ${ORDINAL[transactions]} transactions, signed in order: ${steps.map((t, n) => `${n + 1}) ${t}`).join('; ')}. ${withdrawRaw ? `If you stop before the last one, the health factor stays at ${hf1.toFixed(2)}, never under ${SWAP_REPAY_FLOOR_HF.toFixed(2)}; prices can still move between the steps.` : `Nothing is withdrawn: if you stop after the swap, the health factor stays at ${hf.toFixed(2)}.`}`,
    intent: {
      action: 'repay_with_collateral',
      token: debt.token,
      collateralToken: swap.token,
      approxUsd: Math.max(0.01, approxUsdOf(plan.repay * debt.usdPerToken)),
      amount: swapRaw.toString(),
      ...(withdrawRaw && { withdraw: withdrawRaw.toString() }),
      maxSlippageBps: swap.slippageBps,
      plan: {
        hfNow: hf,
        hfAfterWithdraw: hf1,
        hfAfterRepay: plan.hfAfterRepay,
        floorHf: SWAP_REPAY_FLOOR_HF,
        transactions,
      },
    },
  };
}

function withdrawable(
  ctx: RecommendationContext,
  strategy: Strategy,
): PortfolioRecommendation | null {
  const targetHf = strategy.targetHealthFactor;
  const loan = ctx.loan?.hasDebt ? ctx.loan : null;
  // Below the target the money belongs against the loan (the repay card), not in the wallet.
  if (loan && !((loan.healthFactor ?? 0) >= targetHf)) return null;
  const best = ctx.burrowBalances
    .map((b) => {
      // a token with vr 0 cannot be collateral: its plain deposit leaves without touching the health factor
      const room =
        loan && b.collateral > 0 && b.vr > 0
          ? withdrawableToKeep(
              {
                collateralAdjUsd: loan.collateralAdjUsd,
                debtAdjUsd: loan.debtAdjUsd,
                vr: b.vr,
                usdPerToken: b.usdPerToken,
              },
              targetHf,
            )
          : Infinity;
      const tokens = b.deposited + Math.min(b.collateral, room);
      return { b, tokens, all: room >= b.collateral, usd: tokens * b.usdPerToken };
    })
    .filter((o) => o.usd >= MIN_ACTION_USD)
    .sort((x, y) => y.usd - x.usd)[0];
  // ponytail: the whole balance is asked with a 0.1% margin; prepare caps it at the exact balance it reads on-chain
  const raw =
    best && rawOf(best.all ? best.tokens * 1.001 : best.tokens, best.b.decimals, best.all);
  if (!best || !raw) return null;
  const { b } = best;
  const amount = `${tokenText(best.tokens)} ${b.symbol}`;
  const earns = b.aprPct
    ? ` Withdrawn, it stops earning about ${b.aprPct.toFixed(1)}% a year.`
    : '';
  return {
    id: `withdraw-${b.token}`,
    kind: 'withdraw_from_burrow',
    agent: 'Liquidation Guardian',
    severity: 'info',
    title: `Withdraw ${amount} from Burrow`,
    why:
      (loan
        ? `You can move ${amount} (about ${money0(best.usd)}) from Burrow to your wallet and keep the loan's health factor at ${targetHf.toFixed(2)} or above.`
        : `Nothing is borrowed, so the ${amount} (about ${money0(best.usd)}) you have on Burrow can move to your wallet, for example to rebalance.`) +
      earns,
    intent: {
      action: 'withdraw',
      token: b.token,
      approxUsd: Math.max(0.01, approxUsdOf(best.usd)),
      amount: raw.toString(),
    },
  };
}

/** The fields of the account view the analysis reuses; the rest of the body is passed through untyped. */
interface WalletBody {
  readonly holdings: readonly { readonly token: string; readonly verified: boolean }[];
  readonly actions: readonly PortfolioAction[];
  readonly [field: string]: unknown;
}
type AccountBody = WalletBody & { readonly recommendations: readonly PortfolioRecommendation[] };

const UNKNOWN_STRATEGY = `strategy must be one of: ${STRATEGY_IDS.join(', ')}`;

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
  events?: EventStore,
) {
  const record = eventRecorder(events, app.log);
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
      body: WalletBody;
      loan: Parameters<typeof loanHealth>[0];
      checks: { readonly user: RecommendationContext; readonly model: RecommendationContext };
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
  const OWNER_CHECK_FAILED = "Couldn't check your signature right now. Try again in a moment.";
  const isOwner = async (header: unknown, id: string, log: FastifyRequest['log']) => {
    if (typeof header !== 'string') return false;
    const key = `${id}:${header}`;
    const at = owners.get(key);
    if (at !== undefined && Date.now() - at < OWNER_CACHE_TTL_MS) return true;
    const ok = await verifyOwnership(proofFromHeader(header), id, ownership).catch(
      (err: unknown) => {
        log.warn({ account: id, err: errorMessage(err) }, 'ownership key read failed');
        return null;
      },
    );
    if (ok) {
      owners.set(key, Date.now());
      const at = new Date();
      // ponytail: check-then-insert; two first proofs in the same instant may both be stored.
      if (events && !(await events.hasSince(id, 'verified', utcDay(at)).catch(() => true)))
        await record({ at, kind: 'verified', accountId: id, source: 'server' });
    } else owners.delete(key);
    return ok;
  };

  /** The unsigned cascade with its id, or a 422 when the safety check blocked it (stored either way). */
  const seal = async (
    reply: FastifyReply,
    account: AccountId,
    intent: Record<string, unknown>,
    cascade: PreparedCascade,
    ctx: CascadeValidationContext,
    extra: Record<string, unknown>,
  ) => {
    const sealed = await sealCascade(record, account, intent, cascade, ctx);
    if (!sealed.ok)
      return reply
        .code(422)
        .send({ error: 'assembled cascade failed safety checks', reasons: sealed.reasons });
    return {
      account,
      intent,
      ...extra,
      cascadeId: sealed.cascadeId,
      transactions: sealed.transactions,
      preview: cascade.preview,
      signed: false,
      note: 'Unsigned. Review and sign in your own wallet; the server holds no key and sends nothing.',
    };
  };

  /** Confirmed prices of the latest snapshot: the median of the valid USD quotes per token. */
  const latestPrices = async () => {
    const snap = await store.latestSnapshot();
    if (!snap) return new Map<string, number>();
    const out = new Map<string, number>();
    for (const [asset, [point]] of snapshotPrices(await store.pricesForSnapshot(snap.id)))
      if (typeof point?.price === 'number') out.set(asset, point.price);
    const summary = (snap.summary ?? {}) as {
      prices?: { token: string; usd: string; quality: string }[];
    };
    for (const p of summary.prices ?? []) if (p.quality === 'OK') out.set(p.token, Number(p.usd));
    return out;
  };

  type CachedAccount = NonNullable<ReturnType<typeof cache.get>>;
  /** The cache holds the wallet read; the strategy's cards and loan label are recomputed on every request. */
  const withStrategy = (entry: CachedAccount, strategyId: StrategyId) => {
    const strategy = STRATEGIES[strategyId];
    const { recommendations, skipped } = portfolioAdvice(entry.checks.user, strategy);
    const keepLoan = keepsProfitableLoan(entry.checks.user, strategy);
    return {
      status: 200 as const,
      body: {
        ...entry.body,
        actions: keepLoan
          ? entry.body.actions.filter((a) => a.kind !== 'keep') // 'keep' is the repay-from-wallet action
          : entry.body.actions,
        strategy: strategyId,
        recommendations,
        skipped,
        health: loanHealth(entry.loan, strategy),
        strategyNote: strategyNote(entry.checks.user, entry.loan),
      },
      forModel: portfolioAdvice(entry.checks.model, strategy).recommendations,
      loanCarry: entry.checks.model.carry && carryLine(entry.checks.model.carry),
      concentration: entry.concentration,
    };
  };

  /**
   * The Burrow-listed token that could repay the largest debt through an allowlisted Rhea pool (#69): on Burrow or
   * already in the wallet (a run stopped after the withdraw continues from there), the largest one, with the swap
   * rate at its minimum output from a live quote sized near the debt. Only for a loan under the strictest preset's
   * safe line that the wallet cannot repay to the strictest target and that has no same-token collateral, so at
   * most one quote per account read. Not for a wNEAR debt: Rhea may pay wNEAR out as native NEAR.
   */
  const swapRepayCandidate = async (
    loan: NonNullable<RecommendationContext['loan']>,
    debt: RecommendationContext['largestDebt'],
    tokens: readonly (BurrowTokenFacts & {
      readonly deposited: number;
      readonly collateral: number;
    })[],
    walletOf: (token: string) => number,
  ): Promise<RecommendationContext['swapRepay']> => {
    const strictest = STRATEGY_IDS.map((id) => STRATEGIES[id]);
    const safeAt = Math.max(...strictest.map((st) => st.healthyAt));
    const target = Math.max(...strictest.map((st) => st.targetHealthFactor));
    if (
      !debt ||
      debt.token === WNEAR ||
      loan.healthFactor === null ||
      loan.healthFactor >= safeAt ||
      debt.collateral > 0
    )
      return null;
    const walletNeed = repayToReach(
      { ...loan, vr: debt.vr, usdPerToken: debt.usdPerToken },
      target,
      'wallet',
    );
    if (debt.wallet >= walletNeed) return null;
    const routed = (t: string) =>
      deps.pools.some(
        (p) =>
          (p.tokenA === t && p.tokenB === debt.token) ||
          (p.tokenB === t && p.tokenA === debt.token),
      );
    const best = tokens
      .filter((b) => b.token !== debt.token && routed(b.token) && b.usdPerToken > 0)
      .map((b) => ({ ...b, wallet: walletOf(b.token) }))
      .map((b) => ({ b, usd: (b.collateral + b.deposited + b.wallet) * b.usdPerToken }))
      .filter((x) => x.usd >= MIN_ACTION_USD)
      .sort((x, y) => y.usd - x.usd)[0]?.b;
    if (!best) return null;
    const tokensIn = Math.min(
      best.collateral + best.deposited + best.wallet,
      debt.usd / best.usdPerToken,
    );
    const amountIn = rawOf(tokensIn, best.decimals, false);
    const tokenIn = accountIdSchema.safeParse(best.token);
    const tokenOut = accountIdSchema.safeParse(debt.token);
    if (!amountIn || !tokenIn.success || !tokenOut.success) return null;
    const quote = await quoter
      .quote({ tokenIn: tokenIn.data, tokenOut: tokenOut.data, amountIn })
      .catch(() => null);
    if (!quote || quote.amountOut <= 0n) return null;
    const slippageBps = SWAP_REPAY_SLIPPAGE_BPS;
    const out = Number(quote.amountOut) / 10 ** debt.decimals;
    const inTokens = Number(amountIn) / 10 ** best.decimals;
    return { ...best, outPerIn: ((out / inTokens) * (10_000 - slippageBps)) / 10_000, slippageBps };
  };

  const readAccount = async (
    id: AccountId,
    log: FastifyRequest['log'],
    strategy: StrategyId,
    fresh = false,
  ): Promise<
    | {
        status: 200;
        body: AccountBody;
        forModel: readonly PortfolioRecommendation[];
        loanCarry: PortfolioRecommendation['carry'];
        concentration: Concentration;
      }
    | { status: 404 | 502; body: { error: string } }
  > => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ACCOUNT_CACHE_TTL_MS && !(fresh && mayReadFresh(id)))
      return withStrategy(hit, strategy);
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
    let loanMonthly = 0;
    let loanUsd = 0;
    let depositsMonthly = 0;
    const noRate: string[] = [];
    // a side with an unpriced or unrated position gets no figure on the loan card, never a too-small one
    const unknownOn = new Set<'borrowed' | 'supplied'>();
    for (const h of v.holdings) {
      if (h.where === 'wallet') continue;
      const borrowed = h.where === 'borrowed';
      const side = borrowed ? 'borrowed' : 'supplied';
      if (h.usd === null) {
        unknownOn.add(side);
        continue;
      }
      const r = rate(h.token, borrowed ? 'borrowApr' : 'netSupplyApr');
      if (r === null) {
        // dust (under $1) in dead markets would only block the figure; larger positions without a rate are named
        if (h.usd >= 1) {
          noRate.push(h.symbol);
          unknownOn.add(side);
        }
      } else if (borrowed) {
        loanMonthly += h.usd * r * H;
        loanUsd += h.usd;
      } else depositsMonthly += h.usd * r * H;
    }
    const monthly = depositsMonthly - loanMonthly;
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
    const top = concentratedToken(metrics.byToken, (t) => verified.has(t) && !trust(t).estimate);
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
        loop: market(h.token),
      }))
      .filter((a) => a.aprPct > 0)
      .sort((a, b) => b.usd - a.usd);
    const debts = v.holdings
      .filter((h) => h.where === 'borrowed' && h.usd !== null)
      .sort((a, b) => (b.usd as number) - (a.usd as number));
    const held = (where: Holding['where'], token: string) =>
      v.holdings
        .filter((h) => h.where === where && h.token === token)
        .reduce((s, h) => s + h.amount, 0);
    const burrowFacts = (token: string) => {
      const f = facts.get(token);
      return f && f.usd !== null && f.vr !== undefined
        ? { token, symbol: f.symbol, decimals: f.decimals, usdPerToken: f.usd, vr: f.vr }
        : null;
    };
    const debtFacts = debts[0] && burrowFacts(debts[0].token);
    const largestDebt =
      debts[0] && debtFacts && debtFacts.vr > 0
        ? {
            ...debtFacts,
            usd: debts[0].usd as number,
            amount: debts[0].amount,
            wallet: held('wallet', debts[0].token),
            collateral: held('collateral', debts[0].token),
          }
        : null;
    const burrowBalances = [
      ...new Set(
        v.holdings
          .filter((h) => h.where === 'deposited' || h.where === 'collateral')
          .map((h) => h.token),
      ),
    ].flatMap((token) => {
      const f = burrowFacts(token);
      const apr = rate(token, 'netSupplyApr');
      return f
        ? [
            {
              ...f,
              deposited: held('deposited', token),
              collateral: held('collateral', token),
              aprPct: apr === null ? null : apr * 100,
            },
          ]
        : [];
    });
    const outOfRange = (pair: (d: DclPositionView) => string) =>
      dclPositions
        .filter(
          (d) =>
            !d.inRange && [d.tokenX, d.tokenY].every((t) => verified.has(t) && !trust(t).estimate),
        )
        .map((d) => ({ lptId: d.lptId, poolId: d.poolId, pair: pair(d), usd: d.usd }))
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const loanKnown = !unknownOn.has('borrowed') && loanUsd > 0;
    const carry: LoanCarry = {
      borrowAprPct: loanKnown ? (loanMonthly / H / loanUsd) * 100 : null,
      loanMonthlyUsd: loanKnown ? loanMonthly : null,
      depositsMonthlyUsd: unknownOn.has('supplied') ? null : depositsMonthly,
    };
    const loan = {
      // any borrowed entry counts, priced or not: an unpriced loan must not read as "nothing borrowed"
      hasDebt: v.holdings.some((h) => h.where === 'borrowed'),
      healthFactor: v.loan.healthFactor,
      collateralAdjUsd: v.loan.collateralAdjUsd,
      debtAdjUsd: v.loan.debtAdjUsd,
    };
    // Burrow-listed tokens that sit only in the wallet can be swapped too (e.g. after a stopped withdraw).
    const walletOnly = [
      ...new Set(v.holdings.filter((h) => h.where === 'wallet' && h.verified).map((h) => h.token)),
    ]
      .filter((t) => !burrowBalances.some((b) => b.token === t))
      .flatMap((t) => {
        const f = burrowFacts(t);
        return f ? [{ ...f, deposited: 0, collateral: 0 }] : [];
      });
    const swapRepay = await swapRepayCandidate(
      loan,
      largestDebt,
      [...burrowBalances, ...walletOnly],
      (t) => held('wallet', t),
    );
    // A NEAR swap wraps native NEAR first, so NEAR and wNEAR in the wallet are one liquid amount.
    const nearLike = new Set<string>([NATIVE_HOLDING, WNEAR]);
    const sameAsset = (t: string) =>
      t === top?.token || (nearLike.has(t) && nearLike.has(top?.token ?? ''));
    const concentrationLiquidUsd = v.holdings
      .filter((h) => h.where === 'wallet' && sameAsset(h.token))
      .reduce((sum, h) => sum + (h.usd ?? 0), 0);
    const user: RecommendationContext = {
      metrics: actionable,
      concentrationLiquidUsd,
      loan,
      idleEarn,
      largestDebt,
      burrowBalances,
      carry,
      swapRepay,
      dclOutOfRange: outOfRange((d) => `${d.symbolX}/${d.symbolY}`),
    };
    // The same list as the model sees it: ft_metadata symbols are untrusted text, so only our own labels.
    const labelled = <T extends { token: string }>(x: T) => ({
      ...x,
      symbol: modelTokenLabel(x.token),
    });
    const model: RecommendationContext = {
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
      burrowBalances: burrowBalances.map(labelled),
      carry,
      swapRepay: swapRepay && labelled(swapRepay),
      dclOutOfRange: outOfRange((d) => `${modelTokenLabel(d.tokenX)}/${modelTokenLabel(d.tokenY)}`),
    };

    const body = {
      earnings: {
        monthlyNetUsd: hasPosition ? monthly : 0,
        sentence: earningsSentence(monthly, hasPosition, noRate),
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
      loan: v.loan,
      actions,
    };
    const concentration = actionable.concentration && {
      token: actionable.concentration.token,
      pct: actionable.concentration.pct,
    };
    const entry = { at: Date.now(), body, loan: v.loan, checks: { user, model }, concentration };
    cache.set(id, entry);
    return withStrategy(entry, strategy);
  };

  app.get('/v1/analytics/account/:id', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    // Verified per request, outside the cache: only the wallet's owner may unlock the LLM analysis.
    const strategy = strategySchema.safeParse((req.query as { strategy?: unknown }).strategy);
    if (!strategy.success) return reply.code(400).send({ error: UNKNOWN_STRATEGY });
    const owner = isOwner(req.headers[OWNERSHIP_HEADER], parsed.data, req.log);
    const fresh = freshQuery.safeParse(req.query).data?.fresh === '1';
    const out = await readAccount(parsed.data, req.log, strategy.data, fresh);
    if (out.status !== 200) return reply.code(out.status).send(out.body);
    const ownerVerified = await owner;
    return {
      ...out.body,
      ownerVerified: ownerVerified === true,
      ...(ownerVerified === null && { ownerCheckFailed: true }),
    };
  });

  /**
   * What the orchestrator agents see for this wallet: a fresh Burrow snapshot priced with the same confirmed collector
   * prices as the account view (so the agents' numbers match the portfolio table), today's Burrow supply rates as the
   * yield estimates, Burrow's own oracle as the second price source for Market Intelligence (empty when it has no
   * recent price), and each priced token's 24 h range from the collector's own stored prices (see range24hBps). The
   * context is as old as the collector snapshot it was priced from; so is the 24 h window.
   */
  const dclAllowed = new Set(deps.dclPools ?? []);
  /** The wallet's DCL positions as the LP Optimizer sees them; empty when DCL or the allowlist is off. */
  const readLp = async (
    id: AccountId,
    prices: ReadonlyMap<string, number>,
    decimals: (t: string) => number | undefined,
  ) => {
    if (!dcl || dclAllowed.size === 0) return null;
    const positions = await dcl.listPositions(id).catch(() => []);
    const poolIds = [...new Set(positions.map((p) => p.pool_id))].filter((p) => dclAllowed.has(p));
    if (poolIds.length === 0) return null;
    const [volumesUsd, reads] = await Promise.all([
      deps.discovery?.dclVolumes24hUsd() ?? null,
      Promise.all(
        poolIds.map(async (pid) => {
          const [pool, depth] = await Promise.all([
            dcl.getPool(pid).catch(() => null),
            dcl.getMarketDepth(pid).catch(() => null),
          ]);
          return { pid, pool, depth };
        }),
      ),
    ]);
    const pools = new Map<string, DclPool>();
    const depths = new Map<string, DclMarketDepth>();
    for (const r of reads) {
      if (r.pool) pools.set(r.pid, r.pool);
      if (r.depth) depths.set(r.pid, r.depth);
    }
    return lpObservation({
      positions,
      pools,
      depths,
      allowedPools: dclAllowed,
      volumesUsd,
      priceUsd: (t) => prices.get(t),
      decimals,
      label: modelTokenLabel,
    });
  };

  const observe = async (
    id: AccountId,
    held: readonly TokenId[],
    strategy: StrategyId,
    log: FastifyRequest['log'],
  ): Promise<WalletObservation> => {
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
    const config = walletAgentConfig(priced, strategy);
    const estimatedYieldWad = new Map<TokenId, bigint>();
    for (const token of priced) {
      const m = markets.find((x) => x.token === token)?.latest as
        (LoopMarket & { status?: string }) | undefined;
      const apr = m?.status === 'OK' ? parseDecimal(m.netSupplyApr ?? m.supplyApr ?? '') : null;
      if (apr && apr.mantissa > 0n) estimatedYieldWad.set(token, toWad(apr));
    }
    const since = new Date(pricedAt.getTime() - DAY_MS);
    const [reference, lp, ranges] = await Promise.all([
      burrowOracle.getPrices(priced).catch(() => ({ prices: new Map<TokenId, UnitPrice>() })),
      readLp(id, prices, decimalsOf),
      (async () => {
        if (priced.length === 0) return new Map<string, SnapshotPrice[]>();
        try {
          return snapshotPrices(await store.priceSeries(since, priced));
        } catch (err) {
          log.warn({ err }, 'price history read failed: no 24 h range');
          return new Map<string, SnapshotPrice[]>();
        }
      })(),
    ]);
    const volatility24hBps = new Map<TokenId, number>();
    for (const t of priced) {
      const bps = range24hBps(ranges.get(t) ?? []);
      if (bps !== null) volatility24hBps.set(t, bps);
    }
    return {
      now: clock.now(),
      accountId: id,
      snapshot,
      market: {
        asOf: pricedAt,
        estimatedYieldWad,
        referencePrices: reference.prices,
        volatility24hBps,
        lpPositions: lp?.views ?? [],
        ...(lp && lp.notes.length > 0 && { notes: { lp: lp.notes.join('; ') } }),
      },
      risk: assessRisk(snapshot, config),
      config,
      ...(lp && { lp: lp.meta }),
    };
  };

  const analysisInputs = async (
    id: AccountId,
    log: FastifyRequest['log'],
    strategy: StrategyId = DEFAULT_STRATEGY,
  ): Promise<Omit<AnalysisContext, 'ownerVerified'> | { status: 404 | 502; error: string }> => {
    const view = await readAccount(id, log, strategy);
    if (view.status !== 200) return { status: view.status, error: view.body.error };
    const { holdings } = view.body;
    return {
      accountId: id,
      observe: () =>
        observe(
          id,
          [
            ...new Set(
              holdings
                .filter((h) => h.token !== NATIVE_HOLDING && h.verified)
                .map((h) => accountIdSchema.parse(h.token)),
            ),
          ],
          strategy,
          log,
        ),
      heuristics: view.body.recommendations,
      checks: view.forModel,
      loanCarry: view.loanCarry,
      concentration: view.concentration,
      strategy,
    };
  };

  /** The account's timeline (#32). Public: RPC-confirmed transactions only; the owner's proof adds everything else. */
  app.get('/v1/analytics/account/:id/events', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    if (!events) return { owner: false, items: [] };
    const [owner, rows] = await Promise.all([
      isOwner(req.headers[OWNERSHIP_HEADER], parsed.data, req.log).then((ok) => ok === true),
      events.forAccount(parsed.data, 500),
    ]);
    return { owner, items: activityTimeline(rows, { owner }) };
  });

  /** Architecture C (see ai-analysis.ts): the central LLM ranks and explains; code computes every number. */
  app.post('/v1/analytics/account/:id/analysis', async (req, reply) => {
    const parsed = accountIdSchema.safeParse((req.params as { id?: string }).id ?? '');
    if (!parsed.success) return reply.code(400).send({ error: 'not a valid NEAR account id' });
    const body = z.object({ strategy: strategySchema }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: UNKNOWN_STRATEGY });
    const owner = isOwner(req.headers[OWNERSHIP_HEADER], parsed.data, req.log);
    const inputs = await analysisInputs(parsed.data, req.log, body.data.strategy);
    if ('error' in inputs) return reply.code(inputs.status).send({ error: inputs.error });
    const ownerVerified = await owner;
    if (ownerVerified === null) return reply.code(503).send({ error: OWNER_CHECK_FAILED });
    const run = async (onEvent?: (e: AnalysisEvent) => void) => {
      const analysis = await analyseAccount(
        deps.ai ?? null,
        { ...inputs, ownerVerified },
        (err) => req.log.warn({ err, account: parsed.data }, 'llm analysis fell back'),
        undefined,
        onEvent,
      );
      await record({
        at: new Date(),
        kind: 'analyse',
        accountId: parsed.data,
        source: 'server',
        detail: {
          source: analysis.source === 'llm' ? 'ai' : 'heuristic',
          strategy: body.data.strategy,
        },
      });
      return analysis;
    };
    if (!req.headers.accept?.includes('text/event-stream')) return run();
    // Live pipeline (#113): server-built lines only, never raw tool output; the last frame is the same JSON reply.
    const out = new PassThrough();
    // ponytail: a tool that returns after the deadline would write after `done`; the run is not aborted on disconnect.
    const send = (event: string, data: unknown) =>
      out.writable && out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    run(({ type, ...data }) => send(type, data))
      .then((analysis) => send('done', analysis))
      .catch((err: unknown) => {
        req.log.error({ err, account: parsed.data }, 'analysis stream failed');
        send('error', { error: 'analysis failed' });
      })
      .finally(() => out.end());
    return reply
      .header('content-type', 'text/event-stream')
      .header('cache-control', 'no-cache, no-transform')
      .header('x-accel-buffering', 'no')
      .send(out);
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
          // recentre_dcl: move a DCL position to a new range around the price (remove -> swap? -> add).
          z.object({
            action: z.literal('recentre_dcl'),
            lptId: z.string().min(1).max(300),
            leftPoint: z.number().int(),
            rightPoint: z.number().int(),
            maxSlippageBps: slip,
          }),
          // unwrap: wNEAR -> native NEAR.
          z.object({ action: z.literal('unwrap'), approxUsd: usd }),
          // Burrow borrow / withdraw / repay from collateral — priced by Burrow (execute_with_pyth).
          z.object({ action: z.literal('borrow'), token: accountIdSchema, approxUsd: usd }),
          z.object({
            action: z.literal('withdraw'),
            token: accountIdSchema,
            approxUsd: usd,
            amount,
          }),
          z.object({
            action: z.literal('repay_from_collateral'),
            token: accountIdSchema,
            approxUsd: usd,
            amount,
          }),
          // Repay a debt with another collateral token: withdraw -> swap -> repay (#69).
          z.object({
            action: z.literal('repay_with_collateral'),
            token: accountIdSchema,
            collateralToken: accountIdSchema,
            approxUsd: usd,
            amount: amount.unwrap(),
            withdraw: amount,
            maxSlippageBps: slip,
          }),
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
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([deps.rheaId, token0, token1]),
            allowedPools,
          },
          {
            amounts: [
              { raw: side0.rawAmount.toString(), human: side0.humanAmount, symbol: sym0 },
              { raw: side1.rawAmount.toString(), human: side1.humanAmount, symbol: sym1 },
            ],
          },
        );
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
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([dclId]),
          },
          {
            position: { lptId: pos.lpt_id, poolId: pos.pool_id },
            freed: [
              { raw: freed.x.toString(), human: Number(freed.x) / 10 ** decX, symbol: symX },
              { raw: freed.y.toString(), human: Number(freed.y) / 10 ** decY, symbol: symY },
            ],
          },
        );
      } catch (e) {
        return prepareFailure(req, reply, e);
      }
    }

    // recentre_dcl — the LP Optimizer found a range around the current price whose extra fees repay the move. The
    // position and pool are read fresh; the range must still hold the price, and the pool must be allowlisted.
    if (intent.action === 'recentre_dcl') {
      const dclId = deps.dclId;
      if (!dcl || !dclId) return reply.code(409).send({ error: 'DCL is not configured' });
      try {
        const pos = (await dcl.listPositions(account)).find((p) => p.lpt_id === intent.lptId);
        if (!pos)
          return reply
            .code(409)
            .send({ error: `${account} does not own DCL position ${intent.lptId}` });
        if (!dclAllowed.has(pos.pool_id))
          return reply.code(409).send({ error: `pool ${pos.pool_id} is not allowlisted` });
        if ((pos.v_liquidity ?? 0n) > 0n)
          return reply.code(409).send({
            error: `position ${intent.lptId} is staked in a farm; unstake it there before re-centring`,
          });
        if (pos.amount <= 0n)
          return reply.code(409).send({ error: `position ${intent.lptId} is already empty` });
        const pool = await dcl.getPool(pos.pool_id);
        if (!pool) return reply.code(409).send({ error: `pool ${pos.pool_id} not found` });
        const tokenX = accountIdSchema.parse(pool.token_x);
        const tokenY = accountIdSchema.parse(pool.token_y);
        // The withdraw and the swap pay out to the wallet: an unregistered token would stop the cascade halfway.
        const registered = await Promise.all(
          [tokenX, tokenY].map((t) => tokens.isStorageRegistered(t, account)),
        );
        if (registered.includes(false))
          return reply.code(409).send({
            error: `register ${account} with both pool tokens before re-centring`,
          });
        const built = await recentreSteps({
          dcl: dclId,
          position: pos,
          pool,
          leftPoint: intent.leftPoint,
          rightPoint: intent.rightPoint,
          maxSlippageBps: intent.maxSlippageBps,
          tokenX,
          tokenY,
          symbolX: modelTokenLabel(tokenX),
          symbolY: modelTokenLabel(tokenY),
          quote: async (inputToken, outputToken, inputAmount) =>
            (await dcl.quote({ poolIds: [pos.pool_id], inputToken, outputToken, inputAmount }))
              .amount,
        });
        const cascade = assembleCascade(account, built.steps);
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([dclId, tokenX, tokenY]),
            dcl: { contract: dclId, pools: dclAllowed },
          },
          {
            position: { lptId: pos.lpt_id, poolId: pos.pool_id },
            range: { leftPoint: intent.leftPoint, rightPoint: intent.rightPoint },
          },
        );
      } catch (e) {
        if (e instanceof RecentreRefused) return reply.code(409).send({ error: e.message });
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
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([WRAP]),
          },
          {
            amount: { raw: rawAmount.toString(), human: humanAmount, symbol: 'wNEAR' },
          },
        );
      } catch (e) {
        return prepareFailure(req, reply, e);
      }
    }

    if (intent.action === 'repay_with_collateral') {
      try {
        const [prices, meta, acct, deployment, assets] = await Promise.all([
          latestPrices(),
          store.tokenMetadata(),
          burrow.getAccount(account),
          burrowVerifier.verifyDeployment(),
          burrow.listAssets(),
        ]);
        if (!acct) return reply.code(409).send({ error: `${account} has no Burrow account` });
        const metaOf = (t: string) => meta.find((x) => x.token === t);
        const assetOf = (t: string) => assets.find((a) => a.tokenId === t);
        const facts = (t: string) => {
          const a = assetOf(t);
          const price = prices.get(t);
          return a && price !== undefined && price > 0
            ? {
                decimals: metaOf(t)?.decimals ?? (t === WNEAR ? 24 : 18),
                symbol: metaOf(t)?.symbol ?? t.slice(0, 10),
                usdPerToken: price,
                vr: a.volatilityRatioBps / 10_000,
                extraDecimals: a.extraDecimals,
                extra: 10n ** BigInt(a.extraDecimals),
              }
            : null;
        };
        // The health factor's two sides at the latest confirmed prices, as the account view computes them.
        const inPosition = [...acct.supplied, ...acct.collateral, ...acct.borrowed];
        const missing = inPosition.find((b) => !facts(b.tokenId));
        if (missing)
          return reply
            .code(409)
            .send({ error: `no confirmed price or risk data for ${missing.tokenId}` });
        const tokenFacts = new Map<string, TokenFacts>(
          inPosition.flatMap((b) => {
            const f = facts(b.tokenId);
            return f
              ? [
                  [
                    b.tokenId,
                    {
                      decimals: f.decimals,
                      symbol: f.symbol,
                      usd: f.usdPerToken,
                      extraDecimals: f.extraDecimals,
                      vr: f.vr,
                    },
                  ] as const,
                ]
              : [];
          }),
        );
        const side = (list: readonly { tokenId: string; inner: bigint }[]) =>
          list.map((b) => ({ token: b.tokenId as TokenId, inner: b.inner }));
        const { loan: fresh } = valueAccount(
          {
            accountId: account,
            nativeYocto: 0n,
            wallet: new Map(),
            burrow: {
              supplied: side(acct.supplied),
              collateral: side(acct.collateral),
              borrowed: side(acct.borrowed),
            },
          },
          tokenFacts,
        );
        if (fresh.riskDataMissing)
          return reply
            .code(409)
            .send({ error: 'the loan could not be valued: a price is missing' });
        const { collateralAdjUsd, debtAdjUsd } = fresh;
        const c = facts(intent.collateralToken);
        const d = facts(intent.token);
        if (!c || !d)
          return reply
            .code(409)
            .send({ error: 'no confirmed price for the collateral or the debt token' });
        const rawOn = (
          list: readonly { tokenId: string; inner: bigint }[],
          t: string,
          extra: bigint,
        ) => list.filter((b) => b.tokenId === t).reduce((sum, b) => sum + b.inner, 0n) / extra;
        const storageMin = async (t: AccountId) =>
          (await tokens.isStorageRegistered(t, account))
            ? null
            : BigInt(
                ((await viewer.view(t, 'storage_balance_bounds', {})) as { min?: string }).min ??
                  '1250000000000000000000',
              );
        const [vColl, vDebt, collWallet, debtWallet, collStorage, debtStorage] = await Promise.all([
          burrowVerifier.verifyToken(deployment, intent.collateralToken, 'withdraw'),
          burrowVerifier.verifyToken(deployment, intent.token, 'repay'),
          tokens.getBalance(intent.collateralToken, account).catch(() => 0n),
          tokens.getBalance(intent.token, account).catch(() => 0n),
          storageMin(intent.collateralToken),
          storageMin(intent.token),
        ]);
        const now = clock.now();
        const prepared = await prepareSwapRepay({
          account,
          rheaId: deps.rheaId,
          requested: {
            swapInRaw: BigInt(intent.amount),
            withdrawRaw: BigInt(intent.withdraw ?? '0'),
          },
          collateral: {
            token: intent.collateralToken,
            symbol: c.symbol,
            decimals: c.decimals,
            usdPerToken: c.usdPerToken,
            vr: c.vr,
            walletRaw: collWallet,
            suppliedRaw: rawOn(acct.supplied, intent.collateralToken, c.extra),
            collateralRaw: rawOn(acct.collateral, intent.collateralToken, c.extra),
            storageMin: collStorage,
          },
          debt: {
            token: intent.token,
            symbol: d.symbol,
            decimals: d.decimals,
            usdPerToken: d.usdPerToken,
            vr: d.vr,
            walletRaw: debtWallet,
            debtRaw: rawOn(acct.borrowed, intent.token, d.extra),
            storageMin: debtStorage,
          },
          model: { collateralAdjUsd, debtAdjUsd },
          slippageBps: intent.maxSlippageBps,
          floor: SWAP_REPAY_FLOOR_HF,
          quote: (amountIn) =>
            quoter.quote({ tokenIn: intent.collateralToken, tokenOut: intent.token, amountIn }),
          withdrawTx: (rawAmount, fromCollateralRaw) =>
            buildWithdraw({
              deployment,
              token: vColl,
              now,
              rawAmount,
              fromCollateralRaw,
            }),
          repayTx: (rawAmount) => buildRepay({ deployment, token: vDebt, now, rawAmount }),
        });
        if (!prepared.ok) return reply.code(409).send({ error: prepared.error });
        const cascade = assembleCascade(account, prepared.steps);
        const totalGas = cascade.transactions.reduce(
          (sum, t) => sum + t.actions.reduce((g, a) => g + a.gas, 0n),
          0n,
        );
        const { amounts } = prepared;
        const of = (raw: bigint, f: { decimals: number; symbol: string }) => ({
          raw: raw.toString(),
          human: Number(raw) / 10 ** f.decimals,
          symbol: f.symbol,
        });
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([
              deps.burrowId,
              deps.rheaId,
              intent.collateralToken,
              intent.token,
            ]),
          },
          {
            amount: of(amounts.repayRaw, d),
            cost: {
              networkFeeMaxNear:
                Number((totalGas * 100_000_000n) / 1_000_000_000_000_000_000n) / 1e6,
              swap: {
                slippageBps: intent.maxSlippageBps,
                estReceived: of(amounts.estOutRaw, d),
                minReceived: of(amounts.minOutRaw, d),
                priceImpactPct: null,
              },
            },
            healthFactor: prepared.hf,
          },
        );
      } catch (e) {
        return prepareFailure(req, reply, e);
      }
    }

    // borrow / withdraw / repay from collateral — priced Burrow actions (execute_with_pyth: Burrow fetches its own
    // prices). No wallet balance is needed (you borrow what you do not hold; you withdraw or repay from what
    // Burrow holds). Burrow re-checks, at fresh prices, that collateral still covers debt, or the call reverts on-chain.
    if (
      intent.action === 'borrow' ||
      intent.action === 'withdraw' ||
      intent.action === 'repay_from_collateral'
    ) {
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
        if (
          intent.action === 'repay_from_collateral' &&
          !acct.borrowed.some((b) => b.tokenId === intent.token)
        )
          return reply.code(409).send({ error: `you have no ${sym} debt on Burrow` });
        const verifiedToken = await burrowVerifier.verifyToken(
          deployment,
          intent.token,
          intent.action === 'repay_from_collateral' ? 'repay' : intent.action,
        );
        const requested =
          'amount' in intent && intent.amount !== undefined
            ? BigInt(intent.amount)
            : resolveIntentAmount(intent.approxUsd, price, decimals).rawAmount;
        // Withdraw and repay draw on this token's Burrow balance: plain supply first, then collateral released for it.
        const rawOfInner = (list: readonly { tokenId: string; inner: bigint }[]) =>
          list.filter((b) => b.tokenId === intent.token).reduce((s, b) => s + b.inner, 0n) /
          10n ** BigInt(verifiedToken.extraDecimals);
        const suppliedRaw = rawOfInner(acct.supplied);
        const available = suppliedRaw + rawOfInner(acct.collateral);
        if (intent.action !== 'borrow' && available <= 0n)
          return reply.code(409).send({ error: `you have no ${sym} on Burrow` });
        // Released collateral must not exceed the repayment, or it would weaken the loans in other tokens; the 0.1%
        // covers interest accrued since the read (Repay itself stops at the debt).
        const debtRaw = rawOfInner(acct.borrowed);
        const cap =
          intent.action === 'repay_from_collateral' && debtRaw + debtRaw / 1000n < available
            ? debtRaw + debtRaw / 1000n
            : available;
        const rawAmount = intent.action === 'borrow' || requested < cap ? requested : cap;
        if (rawAmount <= 0n) return reply.code(409).send({ error: 'the resolved amount is zero' });
        const fromCollateralRaw = rawAmount > suppliedRaw ? rawAmount - suppliedRaw : 0n;
        const humanAmount = Number(rawAmount) / 10 ** decimals;
        const human = humanAmount.toFixed(Math.min(6, decimals));

        const common = { deployment, token: verifiedToken, now: clock.now(), rawAmount };
        const steps: CascadeStep[] =
          intent.action === 'borrow'
            ? [
                {
                  intentId: 'borrow',
                  tx: buildBorrow(common),
                  preview: `Borrow ${human} ${sym} from Burrow against your collateral and send it to your wallet (Burrow caps this at what your collateral safely allows).`,
                },
              ]
            : intent.action === 'withdraw'
              ? [
                  {
                    intentId: 'withdraw',
                    tx: buildWithdraw({ ...common, fromCollateralRaw }),
                    preview: `Withdraw up to ${human} ${sym} from your Burrow balance to your wallet${fromCollateralRaw > 0n ? ', releasing collateral for it' : ''} (with a loan, Burrow refuses it only below its liquidation line, so check the health factor first).`,
                  },
                ]
              : [
                  {
                    intentId: 'repay-from-collateral',
                    tx: buildRepayFromCollateral({ ...common, fromCollateralRaw }),
                    preview: `Repay up to ${human} ${sym} of your Burrow loan from your ${sym} on Burrow (collateral and debt both fall by that amount; capped at the actual debt). Nothing leaves your wallet.`,
                  },
                ];

        const cascade = assembleCascade(account, steps);
        return seal(
          reply,
          account,
          intent,
          cascade,
          {
            signerId: account,
            allowedReceivers: new Set<string>([deps.burrowId]),
          },
          {
            amount: { raw: rawAmount.toString(), human: humanAmount, symbol: sym },
          },
        );
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
        swapActions.push(
          ...buildRheaSwap({
            contractId: deps.rheaId,
            poolId: quote.poolId,
            tokenIn: intent.token,
            tokenOut,
            amountIn: swapRawAmount,
            minAmountOut: minOut,
          }).actions,
        );
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
      // Upper-bound network fee: total prepaid gas × the minimum gas price (most of it is refunded in practice).
      const totalGas = cascade.transactions.reduce(
        (s, t) => s + t.actions.reduce((g, a) => g + a.gas, 0n),
        0n,
      );
      const networkFeeMaxNear =
        Number((totalGas * 100_000_000n) / 1_000_000_000_000_000_000n) / 1e6;
      return seal(
        reply,
        account,
        intent,
        cascade,
        {
          signerId: account,
          allowedReceivers: allowed,
        },
        {
          amount: { raw: rawAmount.toString(), human: humanAmount, symbol: sym },
          cost: { networkFeeMaxNear, swap: swapCost },
        },
      );
    } catch (e) {
      return prepareFailure(req, reply, e);
    }
  });
  return { analysisInputs };
}
