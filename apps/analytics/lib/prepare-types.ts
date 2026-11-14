/**
 * Client-safe shapes for the one-click transaction pipeline. The dashboard asks the analytics API to ASSEMBLE an
 * unsigned transaction cascade for a recommendation's intent (`POST /v1/wallet/prepare`), shows the user exactly
 * what it would sign, and (only in local mode, behind a flag) hands the cascade to the connected wallet to sign.
 * The server never holds a key; `signed` is always false here.
 */

/** One function-call action, as the API serialises it (gas/deposit are decimal strings of integers). */
export interface PreparedAction {
  readonly methodName: string;
  readonly args: Record<string, unknown>;
  /** Gas in gas units (string). */
  readonly gas: string;
  /** Attached deposit in yoctoNEAR (string). */
  readonly deposit: string;
}

export interface PreparedTransaction {
  readonly intentId: string;
  readonly receiverId: string;
  readonly actions: readonly PreparedAction[];
}

/** One sized side of a transaction (e.g. each half of a balanced liquidity deposit). */
export interface PreparedAmount {
  readonly raw: string;
  readonly human: number;
  readonly symbol: string;
}

/** Honest swap economics for the preview — what you get, the price impact and the slippage cap. */
export interface SwapCost {
  readonly slippageBps: number;
  readonly estReceived: PreparedAmount;
  readonly minReceived: PreparedAmount;
  readonly priceImpactPct: number | null;
}

export interface PreparedCost {
  /** Upper bound on the network fee in NEAR (prepaid gas × min price; most is refunded). */
  readonly networkFeeMaxNear: number;
  readonly swap: SwapCost | null;
}

export interface PreparedCascade {
  readonly account: string;
  readonly intent: Record<string, unknown>;
  readonly amount?: PreparedAmount;
  readonly amounts?: readonly PreparedAmount[];
  readonly freed?: readonly PreparedAmount[];
  /** The server's id for this cascade; a signed step is confirmed against it. */
  readonly cascadeId?: string;
  readonly transactions: readonly PreparedTransaction[];
  /** Plain-language line per step — what the user is about to sign. */
  readonly preview: readonly string[];
  /** Honest cost breakdown (network fee, and for a swap: price impact / slippage / received). */
  readonly cost?: PreparedCost;
  readonly signed: false;
  readonly note: string;
}

export interface PrepareError {
  readonly error: string;
  readonly reasons?: readonly string[];
}

export type PrepareResult =
  | { readonly ok: true; readonly cascade: PreparedCascade }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly reasons?: readonly string[];
    };

/**
 * The prepare request intents the dashboard can build from a recommendation. Mirrors the analytics API's discriminated
 * union; a recommendation is mapped to exactly one of these before it is sent.
 */
export type PrepareRequestIntent =
  | {
      readonly action:
        'supply' | 'repay' | 'repay_from_collateral' | 'borrow' | 'withdraw' | 'unwrap';
      readonly token: string;
      readonly approxUsd: number;
      readonly amount?: string;
    }
  | { readonly action: 'unwrap'; readonly approxUsd: number }
  | {
      readonly action: 'swap';
      readonly token: string;
      readonly tokenOut: string;
      readonly approxUsd: number;
      readonly maxSlippageBps?: number;
    }
  | {
      readonly action: 'add_liquidity';
      readonly token: string;
      readonly tokenOut: string;
      readonly poolId: number;
      readonly approxUsd: number;
    }
  | { readonly action: 'reposition_dcl'; readonly lptId: string; readonly maxSlippageBps?: number };

export interface PrepareRequest {
  readonly account: string;
  readonly intent: PrepareRequestIntent;
}
