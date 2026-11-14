import type {
  AccountId,
  ActionIntent,
  FunctionCallAction,
  PlannedTransaction,
  ProtocolPlanner,
  TokenReader,
} from '@near-autopilot/core';
import { PreconditionError, UnsupportedIntentError } from '@near-autopilot/core';

export interface RheaPlannerOptions {
  readonly contractId: AccountId;
  /** Gas for ft_transfer_call + the exchange's swap callbacks. Default 180 Tgas. */
  readonly swapGas?: bigint;
}

/** Gas the planner attaches to a Rhea swap (`ft_transfer_call` + exchange callbacks), 180 Tgas. */
export const DEFAULT_SWAP_GAS = 180_000_000_000_000n;

/**
 * One instant swap through one pool: `ft_transfer_call` on the input token with the swap-actions message addressed
 * to the exchange (1 yoctoNEAR). The caller registers the signer on `tokenOut` first, or the output stays on the
 * exchange.
 */
export function buildRheaSwap(args: {
  readonly contractId: string;
  readonly poolId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly gas?: bigint;
}): { readonly receiverId: AccountId; readonly actions: [FunctionCallAction] } {
  if (args.amountIn <= 0n) throw new RangeError('amountIn must be positive');
  if (args.minAmountOut < 0n) throw new RangeError('minAmountOut must not be negative');
  const msg = JSON.stringify({
    force: 0,
    actions: [
      {
        pool_id: args.poolId,
        token_in: args.tokenIn,
        token_out: args.tokenOut,
        amount_in: args.amountIn.toString(),
        min_amount_out: args.minAmountOut.toString(),
      },
    ],
  });
  return {
    receiverId: args.tokenIn as AccountId,
    actions: [
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer_call',
        args: { receiver_id: args.contractId, amount: args.amountIn.toString(), msg },
        gas: args.gas ?? DEFAULT_SWAP_GAS,
        deposit: 1n,
      },
    ],
  };
}

/**
 * Builds an instant swap as `ft_transfer_call` on the input token with a swap-actions message
 * addressed to the exchange (the documented Ref/Rhea instant-swap flow).
 */
export class RheaPlanner implements ProtocolPlanner {
  readonly protocol = 'rhea' as const;

  constructor(
    private readonly tokens: TokenReader,
    private readonly options: RheaPlannerOptions,
  ) {}

  supports(intent: ActionIntent): boolean {
    return intent.kind === 'swap';
  }

  async plan(intent: ActionIntent, signerId: AccountId): Promise<PlannedTransaction> {
    if (intent.kind !== 'swap') throw new UnsupportedIntentError(intent.kind);

    // If the output token cannot be received, the swap output would be stranded in the exchange.
    const registered = await this.tokens.isStorageRegistered(intent.tokenOut, signerId);
    if (!registered) {
      throw new PreconditionError(
        `${signerId} has no storage deposit on ${intent.tokenOut}; register it before swapping into it`,
      );
    }

    const swap = buildRheaSwap({
      contractId: this.options.contractId,
      poolId: intent.poolId,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: intent.amountIn,
      minAmountOut: intent.minAmountOut,
      ...(this.options.swapGas !== undefined && { gas: this.options.swapGas }),
    });
    return { intentId: intent.id, signerId, ...swap };
  }
}
