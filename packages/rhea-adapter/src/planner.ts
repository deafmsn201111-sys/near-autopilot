import type {
  AccountId,
  ActionIntent,
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

const DEFAULT_SWAP_GAS = 180_000_000_000_000n;

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

    const message = JSON.stringify({
      force: 0,
      actions: [
        {
          pool_id: intent.poolId,
          token_in: intent.tokenIn,
          token_out: intent.tokenOut,
          amount_in: intent.amountIn.toString(),
          min_amount_out: intent.minAmountOut.toString(),
        },
      ],
    });

    return {
      intentId: intent.id,
      signerId,
      receiverId: intent.tokenIn,
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: this.options.contractId,
            amount: intent.amountIn.toString(),
            msg: message,
          },
          gas: this.options.swapGas ?? DEFAULT_SWAP_GAS,
          deposit: 1n,
        },
      ],
    };
  }
}
