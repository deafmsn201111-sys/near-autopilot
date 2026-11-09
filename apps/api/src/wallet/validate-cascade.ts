import type { FunctionCallAction, PlannedTransaction } from '@near-autopilot/core';

/**
 * Independent safety re-check of an assembled cascade, run AFTER the builders and BEFORE the cascade is shown to
 * the user to sign. The builders already construct each action correctly (verified deployments, floored amounts,
 * on-chain registration deposits); this is defence-in-depth — a second, builder-independent gate that fails
 * closed. If anything here rejects, the server returns no cascade at all.
 *
 * It does NOT re-use the autopilot PolicyEngine: that gate is bound to the autopilot's own intent + portfolio
 * snapshot model, which this user-signs flow does not have. Fabricating a snapshot to satisfy it would weaken the
 * check, not strengthen it. The invariants below are exactly those that matter for assembly safety.
 */

/** NEAR's per-transaction gas ceiling: 300 Tgas. No single action may request more. */
export const MAX_ACTION_GAS = 300_000_000_000_000n;
/** Largest deposit a single action may attach, beyond the 1-yoctoNEAR confirmation deposit: 0.15 NEAR. The real
 *  registration deposits sit under this — Burrow `storage_balance_bounds().min` is 0.1 NEAR (checked on mainnet),
 *  NEP-141 tokens ~0.00125 NEAR, the Rhea exchange ~0.00102 NEAR, the add_liquidity storage buffer 0.01 NEAR —
 *  while whole-NEAR mistakes are still caught. */
export const MAX_ACTION_DEPOSIT = 150_000_000_000_000_000_000_000n; // 0.15 NEAR
/** Largest total NEAR a whole cascade may attach: 0.3 NEAR. Caps the worst case even if every step attaches storage. */
export const MAX_CASCADE_DEPOSIT = 300_000_000_000_000_000_000_000n; // 0.3 NEAR

/** The only methods a prepared cascade is ever allowed to call. */
export const ALLOWED_METHODS = new Set([
  'storage_deposit',
  'ft_transfer_call',
  'add_liquidity',
  'execute',
  // DCL (concentrated liquidity) reposition: exit an out-of-range position back to the wallet.
  'remove_liquidity',
  'withdraw_asset',
  'burn_v_liquidity',
  // unwrap wNEAR -> native NEAR.
  'near_withdraw',
]);

export interface CascadeValidationContext {
  /** The account that will sign — every transaction must be stamped with exactly this signer. */
  readonly signerId: string;
  /** Receivers this cascade is allowed to touch: the protocol contract(s) and the specific token(s) in play. */
  readonly allowedReceivers: ReadonlySet<string>;
}

export type CascadeValidation =
  { readonly ok: true } | { readonly ok: false; readonly reasons: string[] };

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

function checkAction(
  a: FunctionCallAction,
  receiverId: string,
  ctx: CascadeValidationContext,
  reasons: string[],
): bigint {
  const where = `${receiverId}#${a.methodName}`;
  if (!ALLOWED_METHODS.has(a.methodName)) reasons.push(`${where}: method is not allowlisted`);
  if (a.gas <= 0n || a.gas > MAX_ACTION_GAS) reasons.push(`${where}: gas ${a.gas} out of range`);
  if (a.deposit < 0n) reasons.push(`${where}: negative deposit`);
  if (a.deposit > 1n && a.deposit > MAX_ACTION_DEPOSIT)
    reasons.push(`${where}: deposit ${a.deposit} exceeds the per-action cap`);
  // ft_transfer_call carries the real value transfer; check its shape and that it is addressed to an allowed receiver.
  if (a.methodName === 'ft_transfer_call') {
    if (a.deposit !== 1n)
      reasons.push(`${where}: ft_transfer_call must attach exactly 1 yoctoNEAR`);
    if (!isDecimalString(a.args['amount']))
      reasons.push(`${where}: amount must be a non-negative integer string`);
    const to = a.args['receiver_id'];
    if (typeof to !== 'string' || !ctx.allowedReceivers.has(to))
      reasons.push(`${where}: transfers to an unexpected receiver ${String(to)}`);
    if (typeof a.args['msg'] !== 'string') reasons.push(`${where}: msg must be a string`);
  }
  return a.deposit;
}

/** Validate every transaction and action in a cascade. Returns ok, or every reason it failed. */
export function validateCascade(
  transactions: readonly PlannedTransaction[],
  ctx: CascadeValidationContext,
): CascadeValidation {
  const reasons: string[] = [];
  if (transactions.length === 0) reasons.push('empty cascade');
  let total = 0n;
  for (const tx of transactions) {
    if (tx.signerId !== ctx.signerId)
      reasons.push(`${tx.intentId}: signer ${tx.signerId} is not the connected account`);
    if (!ctx.allowedReceivers.has(tx.receiverId))
      reasons.push(`${tx.intentId}: receiver ${tx.receiverId} is not allowlisted`);
    if (tx.actions.length === 0) reasons.push(`${tx.intentId}: no actions`);
    for (const a of tx.actions) total += checkAction(a, tx.receiverId, ctx, reasons);
  }
  if (total > MAX_CASCADE_DEPOSIT)
    reasons.push(`total attached deposit ${total} exceeds the cascade cap`);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
