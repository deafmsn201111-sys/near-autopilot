import type { AccountId } from '@near-autopilot/core';
import type { LiquiditySegment } from '@near-autopilot/financial-engine';
import type { AgentObservation, LpPositionView } from '@near-autopilot/orchestrator';
import {
  POINT_MAX,
  Q96,
  SQRT_RATE_X96,
  assertValidRange,
  buildAddLiquidity,
  buildDeposit,
  buildRemoveLiquidity,
  buildSwapExactIn,
  buildWithdrawAssets,
  computeLiquidity,
  dclPositionAmounts,
  parsePoolId,
  recentreSwap,
  requiredDepositForLiquidity,
  sqrtPriceX96,
  type DclMarketDepth,
  type DclPool,
  type DclPosition,
} from '@near-autopilot/rhea-dcl-adapter';
import type { CascadeStep } from '../wallet/cascade';

/**
 * ESTIMATE of the NEAR burnt by a re-centre: up to seven transactions (remove, withdraw, swap, two deposits, add),
 * priced at the gas they attach (~1 000 Tgas at 0.1 NEAR per 1 000 Tgas). The real burn is usually lower.
 */
export const RECENTRE_GAS_NEAR = 0.1;

/**
 * DCL liquidity counts token Y per point (a sum of sqrt(1.0001^i)); the CLMM formulas the agent uses count it per unit
 * of sqrt price. One DCL unit is 1 / (sqrt(1.0001) - 1) ≈ 20 000 CLMM units.
 */
export const dclToClmmLiquidity = (l: bigint) => (l * Q96) / (SQRT_RATE_X96 - Q96);

/** What the card and the prepare intent need about a position, beside the agent's view of it. */
export interface LpMeta {
  readonly poolId: string;
  readonly pair: string;
  readonly symbolX: string;
  readonly symbolY: string;
  readonly pointDelta: number;
  readonly currentPoint: number;
  readonly decimalsX: number;
  readonly decimalsY: number;
  /** USD per whole token Y (the agent's quote token). */
  readonly priceYUsd: number;
  readonly inRange: boolean;
}

/** The agents' observation of a wallet, plus the DCL facts the LP Optimizer tool turns into cards. */
export interface WalletObservation extends AgentObservation {
  readonly lp?: ReadonlyMap<string, LpMeta>;
}

/** USD in a token's base units; null when the price makes it meaningless (zero, missing, overflow). */
const usdToRaw = (
  usd: number | undefined,
  priceUsd: number | undefined,
  decimals: number | undefined,
) => {
  if (usd === undefined || !priceUsd || decimals === undefined) return null;
  const raw = Math.floor((usd / priceUsd) * 10 ** decimals);
  return Number.isFinite(raw) && raw >= 0 ? BigInt(raw) : null;
};

/** The pool's liquidity ranges as contiguous segments; gaps read as no liquidity, overlaps as bad data. */
export function depthSegments(depth: DclMarketDepth): LiquiditySegment[] {
  const ranges = Object.values(depth.liquidities)
    .filter((r) => r.amount_l > 0n && r.left_point < r.right_point)
    .sort((a, b) => a.left_point - b.left_point);
  const out: LiquiditySegment[] = [];
  let at = ranges[0]?.left_point;
  for (const r of ranges) {
    if (at === undefined || r.left_point < at) return [];
    if (r.left_point > at)
      out.push({
        sqrtLower: sqrtPriceX96(at),
        sqrtUpper: sqrtPriceX96(r.left_point),
        liquidity: 0n,
      });
    out.push({
      sqrtLower: sqrtPriceX96(r.left_point),
      sqrtUpper: sqrtPriceX96(r.right_point),
      liquidity: dclToClmmLiquidity(r.amount_l),
    });
    at = r.right_point;
  }
  return out;
}

/**
 * One `LpPositionView` per wallet DCL position in an allowlisted pool, with everything the LP Optimizer needs. A
 * position whose pool lacks a 24 h volume, a price or its depth is left out with a note: the agent then answers
 * `insufficient_data`, never a guessed number. Farm-staked positions are left out (they cannot be moved from here).
 */
export function lpObservation(input: {
  readonly positions: readonly DclPosition[];
  readonly pools: ReadonlyMap<string, DclPool>;
  readonly depths: ReadonlyMap<string, DclMarketDepth>;
  readonly allowedPools: ReadonlySet<string>;
  readonly volumesUsd: ReadonlyMap<string, number> | null;
  readonly priceUsd: (token: string) => number | undefined;
  readonly decimals: (token: string) => number | undefined;
  readonly label: (token: string) => string;
}): { views: LpPositionView[]; meta: Map<string, LpMeta>; notes: string[] } {
  const views: LpPositionView[] = [];
  const meta = new Map<string, LpMeta>();
  const notes: string[] = [];
  const nearUsd = input.priceUsd('wrap.near');
  for (const pos of input.positions) {
    if (pos.amount <= 0n || (pos.v_liquidity ?? 0n) > 0n) continue;
    const pool = input.pools.get(pos.pool_id);
    if (!input.allowedPools.has(pos.pool_id) || !pool) {
      const why = input.allowedPools.has(pos.pool_id)
        ? 'pool read failed'
        : 'pool is not allowlisted';
      notes.push(`position ${pos.lpt_id}: ${why}`);
      continue;
    }
    const volumeUsd = input.volumesUsd?.get(pos.pool_id);
    const priceY = input.priceUsd(pool.token_y);
    const decX = input.decimals(pool.token_x);
    const decY = input.decimals(pool.token_y);
    const depth = input.depths.get(pos.pool_id);
    const segments = depth ? depthSegments(depth) : [];
    const volumeQuote = usdToRaw(volumeUsd, priceY, decY);
    const gasQuote = usdToRaw(nearUsd && RECENTRE_GAS_NEAR * nearUsd, priceY, decY);
    const missing = [
      volumeUsd === undefined ? 'no 24 h volume' : null,
      volumeQuote === null || gasQuote === null || decX === undefined ? 'no price' : null,
      segments.length === 0 ? 'no market depth' : null,
      pool.liquidity === undefined ? 'no active liquidity' : null,
    ].filter((m) => m !== null);
    if (
      missing.length > 0 ||
      volumeQuote === null ||
      gasQuote === null ||
      !priceY ||
      decX === undefined ||
      decY === undefined
    ) {
      notes.push(`position ${pos.lpt_id}: ${missing.join(', ')}`);
      continue;
    }
    const cur = pool.current_point;
    const inRange = cur >= pos.left_point && cur < pos.right_point;
    views.push({
      id: pos.lpt_id,
      sqrtPrice: sqrtPriceX96(cur),
      range: {
        sqrtLower: sqrtPriceX96(pos.left_point),
        sqrtUpper: sqrtPriceX96(pos.right_point),
        liquidity: dclToClmmLiquidity(pos.amount),
      },
      activePoolLiquidity: dclToClmmLiquidity(pool.liquidity ?? 0n),
      activeIncludesPosition: inRange,
      volume24hQuote: volumeQuote,
      feePpm: pool.fee,
      segments,
      gasQuote,
    });
    const symbolX = input.label(pool.token_x);
    const symbolY = input.label(pool.token_y);
    meta.set(pos.lpt_id, {
      poolId: pos.pool_id,
      pair: `${symbolX}/${symbolY}`,
      symbolX,
      symbolY,
      pointDelta: pool.point_delta,
      currentPoint: cur,
      decimalsX: decX,
      decimalsY: decY,
      priceYUsd: priceY,
      inRange,
    });
  }
  return { views, meta, notes };
}

export class RecentreRefused extends Error {}

const LN_POINT = Math.log(1.0001);
/** A range wider than this (a price ratio of e^20) is never a re-centre; it guards the contract's range limit. */
const MAX_RANGE_POINTS = 200_000;

/**
 * Where our own swap leaves the pool, so the add's minimums allow for it. The quote's average price sits about halfway
 * between the old and the new marginal price, so the move is about twice the quote's distance from the spot (fees
 * count as move: the estimate only gets more cautious). A move past the slippage refuses the re-centre.
 */
function pointAfterSwap(cur: number, sell: 'x' | 'y', amountIn: bigint, quoted: bigint): number {
  const yPerX =
    sell === 'x' ? Number(quoted) / Number(amountIn) : Number(amountIn) / Number(quoted);
  const execPoint = Math.log(yPerX) / LN_POINT;
  const after = Math.round(cur + 2 * (execPoint - cur));
  if (!Number.isFinite(after)) throw new RecentreRefused('the rebalancing quote is unusable');
  return after;
}

/**
 * The re-centre cascade, from a FRESH position and pool: remove the liquidity -> withdraw both tokens -> swap the
 * surplus token to the new range's ratio (only when needed) -> deposit both -> add at `[leftPoint, rightPoint)`.
 * Every amount is sized from guaranteed minimums (the removal's minimums, the swap's min-out), never the expected
 * outcome, so each later step can always be funded; the add's minimums follow the same slippage. A user who stops
 * halfway holds the tokens in the wallet: the same state as the plain exit.
 */
export async function recentreSteps(input: {
  readonly dcl: AccountId;
  readonly position: DclPosition;
  readonly pool: DclPool;
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly maxSlippageBps: number;
  readonly tokenX: AccountId;
  readonly tokenY: AccountId;
  readonly symbolX: string;
  readonly symbolY: string;
  readonly quote: (tokenIn: AccountId, tokenOut: AccountId, amountIn: bigint) => Promise<bigint>;
}): Promise<{ steps: CascadeStep[]; amountX: bigint; amountY: bigint; liquidity: bigint }> {
  const { dcl, position: pos, pool, leftPoint, rightPoint, tokenX, tokenY } = input;
  const { tokenX: px, tokenY: py } = parsePoolId(pos.pool_id);
  if (px !== tokenX || py !== tokenY) throw new RecentreRefused('tokens do not match the pool');
  try {
    assertValidRange(leftPoint, rightPoint, pool.point_delta);
  } catch (e) {
    throw new RecentreRefused(e instanceof Error ? e.message : String(e));
  }
  if (rightPoint >= POINT_MAX || rightPoint - leftPoint > MAX_RANGE_POINTS)
    throw new RecentreRefused('the new range is outside what the pool accepts');
  if (pool.state !== 'Running') throw new RecentreRefused(`pool ${pos.pool_id} is not running`);
  const cur = pool.current_point;
  if (cur < leftPoint || cur >= rightPoint)
    throw new RecentreRefused('the price moved out of the new range; refresh the recommendation');
  if (cur >= pos.left_point && cur < pos.right_point)
    throw new RecentreRefused('the position is back in range; refresh the recommendation');
  const keep = BigInt(10_000 - input.maxSlippageBps);
  const atLeast = (v: bigint) => (v * keep) / 10_000n;
  const freed = dclPositionAmounts(pos, cur);
  const minX = atLeast(freed.x);
  const minY = atLeast(freed.y);
  const pct = `${(input.maxSlippageBps / 100).toFixed(2)}%`;
  const steps: CascadeStep[] = [
    {
      intentId: 'remove-liquidity',
      tx: buildRemoveLiquidity({
        dcl,
        lptId: pos.lpt_id,
        liquidity: pos.amount,
        minAmountX: minX,
        minAmountY: minY,
      }),
      preview: `Remove your out-of-range ${input.symbolX}/${input.symbolY} liquidity (at most ${pct} slippage).`,
    },
    {
      intentId: 'withdraw',
      tx: buildWithdrawAssets({ dcl, tokenIds: [tokenX, tokenY] }),
      preview: `Withdraw the freed ${input.symbolX} and ${input.symbolY} to your wallet. If you stop after this step, the tokens simply stay in your wallet.`,
    },
  ];
  let amountX = minX;
  let amountY = minY;
  let afterSwapPoint = cur;
  const swap = recentreSwap({ leftPoint, rightPoint, currentPoint: cur, amountX, amountY });
  if (swap) {
    const [tokenIn, tokenOut] = swap.sell === 'x' ? [tokenX, tokenY] : [tokenY, tokenX];
    const quoted = await input.quote(tokenIn, tokenOut, swap.amountIn);
    const minOut = atLeast(quoted);
    if (minOut <= 0n)
      throw new RecentreRefused('the pool has no liquidity for the rebalancing swap');
    steps.push({
      intentId: 'swap',
      tx: buildSwapExactIn({
        dcl,
        tokenIn,
        tokenOut,
        amountIn: swap.amountIn,
        minAmountOut: minOut,
        poolIds: [pos.pool_id],
      }),
      preview: `Swap part of the ${swap.sell === 'x' ? input.symbolX : input.symbolY} so both tokens match the new range (at least the quoted amount minus ${pct}).`,
    });
    if (swap.sell === 'x') {
      amountX -= swap.amountIn;
      amountY += minOut;
    } else {
      amountY -= swap.amountIn;
      amountX += minOut;
    }
    afterSwapPoint = pointAfterSwap(cur, swap.sell, swap.amountIn, quoted);
    if (Math.abs(afterSwapPoint - cur) > input.maxSlippageBps)
      throw new RecentreRefused(
        'the rebalancing swap would move the price by more than the slippage; the position is too large for this pool',
      );
    if (afterSwapPoint < leftPoint || afterSwapPoint >= rightPoint)
      throw new RecentreRefused('the rebalancing swap would push the price out of the new range');
  }
  const liquidity = computeLiquidity({
    leftPoint,
    rightPoint,
    currentPoint: cur,
    amountX,
    amountY,
  });
  if (liquidity <= 0n) throw new RecentreRefused('the position is too small to re-centre');
  const used = (point: number) =>
    requiredDepositForLiquidity({
      liquidity: computeLiquidity({ leftPoint, rightPoint, currentPoint: point, amountX, amountY }),
      leftPoint,
      rightPoint,
      currentPoint: point,
    });
  const [before, after] = [used(cur), used(afterSwapPoint)];
  const needed = {
    x: before.x < after.x ? before.x : after.x,
    y: before.y < after.y ? before.y : after.y,
  };
  for (const [token, amount, symbol] of [
    [tokenX, amountX, input.symbolX],
    [tokenY, amountY, input.symbolY],
  ] as const) {
    if (amount > 0n)
      steps.push({
        intentId: `deposit-${symbol}`,
        tx: buildDeposit({ dcl, token, amount }),
        preview: `Deposit ${symbol} into Rhea for the new position.`,
      });
  }
  steps.push({
    intentId: 'add-liquidity',
    tx: buildAddLiquidity({
      dcl,
      poolId: pos.pool_id,
      leftPoint,
      rightPoint,
      pointDelta: pool.point_delta,
      amountX,
      amountY,
      minAmountX: atLeast(needed.x),
      minAmountY: atLeast(needed.y),
    }),
    preview: `Add the liquidity back at the new range around the current price. Anything the range does not take stays in your Rhea balance.`,
  });
  return { steps, amountX, amountY, liquidity };
}
