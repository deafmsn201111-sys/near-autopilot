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
  // DCL (concentrated liquidity): exit an out-of-range position, or re-centre it (remove, then add_liquidity).
  'remove_liquidity',
  'withdraw_asset',
  'burn_v_liquidity',
  // wrap native NEAR -> wNEAR (before a swap), and unwrap wNEAR -> native NEAR.
  'near_deposit',
  'near_withdraw',
  // priced Burrow borrow / withdraw / repay from collateral: Burrow fetches its own prices (D29).
  'execute_with_pyth',
]);

export interface CascadeValidationContext {
  /** The account that will sign — every transaction must be stamped with exactly this signer. */
  readonly signerId: string;
  /** Receivers this cascade is allowed to touch: the protocol contract(s) and the specific token(s) in play. */
  readonly allowedReceivers: ReadonlySet<string>;
  /** Rhea v1 pools `add_liquidity` may target (config `rhea.pools`). Absent means no pool is allowed. */
  readonly allowedPools?: ReadonlySet<number> | undefined;
  /** The DCL contract and the DCL pools (string ids, config `rhea.dclPools`) its `add_liquidity` may target. */
  readonly dcl?: { readonly contract: string; readonly pools: ReadonlySet<string> } | undefined;
}

export const CASCADE_RULES = [
  'signer',
  'receivers',
  'methods',
  'gas',
  'deposit',
  'arguments',
] as const;
export type CascadeRule = (typeof CASCADE_RULES)[number];

export interface CascadeCheck {
  readonly rule: CascadeRule;
  readonly pass: boolean;
  readonly messages: readonly string[];
}

/** What the checks saw, stored with the verdict for the policy page. Amounts in base units. */
export interface CascadeSummary {
  readonly signer: string;
  readonly receivers: readonly string[];
  readonly methods: readonly string[];
  readonly gas: string;
  readonly deposit: string;
}

export interface CascadeValidation {
  readonly ok: boolean;
  /** Every failure message in the order found; empty when ok. */
  readonly reasons: readonly string[];
  readonly checks: readonly CascadeCheck[];
  readonly summary: CascadeSummary;
}

type Fail = (rule: CascadeRule, message: string) => void;

function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+$/.test(v);
}

function checkAction(
  a: FunctionCallAction,
  receiverId: string,
  ctx: CascadeValidationContext,
  fail: Fail,
): bigint {
  const where = `${receiverId}#${a.methodName}`;
  if (!ALLOWED_METHODS.has(a.methodName)) fail('methods', `${where}: method is not allowlisted`);
  if (a.gas <= 0n || a.gas > MAX_ACTION_GAS) fail('gas', `${where}: gas ${a.gas} out of range`);
  if (a.deposit < 0n) fail('deposit', `${where}: negative deposit`);
  // near_deposit WRAPS the signer's own NEAR into wNEAR 1:1 — the attached deposit IS the value being wrapped (not a
  // fee or a loss; it is recoverable by unwrapping), so it is deliberately exempt from the storage-sized deposit caps.
  // The receiver allowlist still confines it to the wrap contract, and the wallet shows the amount for approval.
  const isWrap = a.methodName === 'near_deposit';
  if (!isWrap && a.deposit > 1n && a.deposit > MAX_ACTION_DEPOSIT)
    fail('deposit', `${where}: deposit ${a.deposit} exceeds the per-action cap`);
  if (isWrap && a.deposit <= 0n)
    fail('deposit', `${where}: near_deposit must attach a positive amount`);
  // ft_transfer_call carries the real value transfer; check its shape and that it is addressed to an allowed receiver.
  if (a.methodName === 'ft_transfer_call') {
    if (a.deposit !== 1n)
      fail('deposit', `${where}: ft_transfer_call must attach exactly 1 yoctoNEAR`);
    if (!isDecimalString(a.args['amount']))
      fail('arguments', `${where}: amount must be a non-negative integer string`);
    const to = a.args['receiver_id'];
    if (typeof to !== 'string' || !ctx.allowedReceivers.has(to))
      fail('receivers', `${where}: transfers to an unexpected receiver ${String(to)}`);
    if (typeof a.args['msg'] !== 'string') fail('arguments', `${where}: msg must be a string`);
  }
  if (a.methodName === 'add_liquidity') {
    const pool = a.args['pool_id'];
    const allowed =
      receiverId === ctx.dcl?.contract
        ? typeof pool === 'string' && ctx.dcl.pools.has(pool)
        : typeof pool === 'number' && ctx.allowedPools?.has(pool) === true;
    if (!allowed) fail('arguments', `${where}: pool ${String(pool)} is not allowlisted`);
  }
  // A wrapping deposit is the user's own NEAR moving into their wNEAR balance; don't count it toward the cascade cap.
  return isWrap ? 0n : a.deposit;
}

/** Validate every transaction and action in a cascade: ok, every reason it failed, and the result per rule. */
export function validateCascade(
  transactions: readonly PlannedTransaction[],
  ctx: CascadeValidationContext,
): CascadeValidation {
  const reasons: string[] = [];
  const byRule = new Map<CascadeRule, string[]>(CASCADE_RULES.map((r) => [r, []]));
  const fail: Fail = (rule, message) => {
    reasons.push(message);
    byRule.get(rule)?.push(message);
  };
  if (transactions.length === 0) fail('arguments', 'empty cascade');
  let capped = 0n;
  let attached = 0n;
  let gas = 0n;
  for (const tx of transactions) {
    if (tx.signerId !== ctx.signerId)
      fail('signer', `${tx.intentId}: signer ${tx.signerId} is not the connected account`);
    if (!ctx.allowedReceivers.has(tx.receiverId))
      fail('receivers', `${tx.intentId}: receiver ${tx.receiverId} is not allowlisted`);
    if (tx.actions.length === 0) fail('arguments', `${tx.intentId}: no actions`);
    for (const a of tx.actions) {
      capped += checkAction(a, tx.receiverId, ctx, fail);
      attached += a.deposit;
      gas += a.gas;
    }
  }
  if (capped > MAX_CASCADE_DEPOSIT)
    fail('deposit', `total attached deposit ${capped} exceeds the cascade cap`);
  return {
    ok: reasons.length === 0,
    reasons,
    checks: CASCADE_RULES.map((rule) => {
      const messages = byRule.get(rule) ?? [];
      return { rule, pass: messages.length === 0, messages };
    }),
    summary: {
      signer: ctx.signerId,
      receivers: [...new Set(transactions.map((t) => t.receiverId))],
      methods: [...new Set(transactions.flatMap((t) => t.actions.map((a) => a.methodName)))],
      gas: gas.toString(),
      deposit: attached.toString(),
    },
  };
}
