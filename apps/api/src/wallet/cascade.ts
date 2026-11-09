import type { AccountId, FunctionCallAction, PlannedTransaction } from '@near-autopilot/core';

/**
 * Phase 4 — assembles an intent into the exact, ordered cascade of transactions the user signs in their wallet.
 *
 * It is deliberately GENERIC and pure: the caller (the prepare endpoint) runs the protocol verifier and the vetted
 * builders — which only mint transactions from genuinely verified deployments/tokens — and hands the already-built
 * drafts here as ordered steps. This stays the shape-assembler: it orders the steps, stamps the signer, and produces
 * the pre-sign preview. The server never signs; every transaction is policy-checked before it is shown.
 */

/** The minimal tx shape every protocol builder produces: one receiver, one or more function-call actions. */
export interface TxDraft {
  readonly receiverId: AccountId;
  readonly actions: readonly FunctionCallAction[];
}

export interface CascadeStep {
  /** Stable id for this step within the cascade (e.g. 'register', 'supply', 'swap'). */
  readonly intentId: string;
  readonly tx: TxDraft;
  /** One human line describing exactly what this step does, for the pre-sign preview. */
  readonly preview: string;
}

export interface PreparedCascade {
  readonly transactions: readonly PlannedTransaction[];
  readonly preview: readonly string[];
}

/** Order the steps as given (registration before the action it enables), stamp the signer, and build the preview. */
export function assembleCascade(
  signerId: AccountId,
  steps: readonly CascadeStep[],
): PreparedCascade {
  if (steps.length === 0) throw new RangeError('a cascade needs at least one step');
  return {
    transactions: steps.map((s) => ({
      intentId: s.intentId,
      signerId,
      receiverId: s.tx.receiverId,
      actions: s.tx.actions,
    })),
    preview: steps.map((s) => s.preview),
  };
}

const YOCTO_PER_NEAR = 10n ** 24n;
/** yoctoNEAR -> a short NEAR string (floor to 4 dp), for the preview only. */
export function formatNear(yocto: bigint): string {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = ((yocto % YOCTO_PER_NEAR) * 10_000n) / YOCTO_PER_NEAR;
  return frac === 0n
    ? whole.toString()
    : `${whole}.${frac.toString().padStart(4, '0').replace(/0+$/, '')}`;
}
