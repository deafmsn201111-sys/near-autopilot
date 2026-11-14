import { POINT_MAX, POINT_MIN } from './constants';
import { assertValidRange, depositPerUnitLiquidityX96, sqrtPriceX96 } from './math';

const Q192 = 1n << 192n;
/** A swap worth less than this share of the position (1/200 = 0.5 %) is skipped: the leftover stays in the wallet. */
const MIN_SWAP_SHARE = 200n;

/**
 * A range in log-1.0001 ticks (an agent's proposal) as DCL points: widened outward to multiples of the pool's point
 * delta and clamped to the contract's bounds. Throws unless the result holds `currentPoint`, so a re-centre always
 * lands in range.
 */
export function alignRange(
  tickLower: number,
  tickUpper: number,
  pointDelta: number,
  currentPoint: number,
): { readonly leftPoint: number; readonly rightPoint: number } {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper))
    throw new RangeError('ticks must be integers');
  const leftPoint = Math.max(POINT_MIN, Math.floor(tickLower / pointDelta) * pointDelta);
  const rightPoint = Math.min(POINT_MAX, Math.ceil(tickUpper / pointDelta) * pointDelta);
  assertValidRange(leftPoint, rightPoint, pointDelta);
  if (currentPoint < leftPoint || currentPoint >= rightPoint)
    throw new RangeError(`current point ${currentPoint} is outside [${leftPoint}, ${rightPoint})`);
  return { leftPoint, rightPoint };
}

/**
 * How much of which token to swap so `amountX` / `amountY` match the ratio `[leftPoint, rightPoint)` takes at
 * `currentPoint`. Sized at the spot price, before fees and price impact: the swap's min-out and the add's minimums
 * protect the user, and any remainder stays with them. Null when no swap is needed.
 */
export function recentreSwap(args: {
  readonly leftPoint: number;
  readonly rightPoint: number;
  readonly currentPoint: number;
  readonly amountX: bigint;
  readonly amountY: bigint;
}): { readonly sell: 'x' | 'y'; readonly amountIn: bigint } | null {
  const { amountX, amountY } = args;
  const per = depositPerUnitLiquidityX96(args.leftPoint, args.rightPoint, args.currentPoint);
  const sqrt = sqrtPriceX96(args.currentPoint);
  const priceNum = sqrt * sqrt;
  const valueYQ192 = amountX * priceNum + amountY * Q192;
  if (valueYQ192 === 0n) return null;
  const targetX = (valueYQ192 * per.x) / (per.x * priceNum + per.y * Q192);
  const swap =
    amountX > targetX
      ? {
          sell: 'x' as const,
          amountIn: amountX - targetX,
          valueQ192: (amountX - targetX) * priceNum,
        }
      : {
          sell: 'y' as const,
          amountIn: ((targetX - amountX) * priceNum) / Q192,
          valueQ192: (targetX - amountX) * priceNum,
        };
  if (swap.amountIn <= 0n || swap.valueQ192 * MIN_SWAP_SHARE < valueYQ192) return null;
  return { sell: swap.sell, amountIn: swap.amountIn };
}
