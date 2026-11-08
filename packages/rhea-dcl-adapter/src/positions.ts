import { requiredDepositForLiquidity } from './math';
import type { DclPosition } from './schemas';

/**
 * The raw token X / Y a DCL (concentrated-liquidity) position currently holds, given the pool's current point.
 *
 * Reuses the vetted contract math (`compute_deposit_xy`): below the range the position is all token Y, above it all
 * token X, and in range a mix. For a PORTFOLIO VALUE this is within one raw unit of the exact withdraw amount — it is
 * for reading/valuing a position, never for building a withdraw transaction (that uses the contract method directly).
 */
export function dclPositionAmounts(
  position: Pick<DclPosition, 'left_point' | 'right_point' | 'amount'>,
  currentPoint: number,
): { readonly x: bigint; readonly y: bigint } {
  return requiredDepositForLiquidity({
    leftPoint: position.left_point,
    rightPoint: position.right_point,
    currentPoint,
    liquidity: position.amount,
  });
}
