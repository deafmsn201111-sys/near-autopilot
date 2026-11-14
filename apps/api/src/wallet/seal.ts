import { randomUUID } from 'node:crypto';
import type { AppEvent } from '../analytics/events';
import type { PreparedCascade } from './cascade';
import { validateCascade, type CascadeValidationContext } from './validate-cascade';

export type SealResult =
  | { readonly ok: true; readonly cascadeId: string; readonly transactions: SerializedTx[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

export interface SerializedTx {
  readonly intentId: string;
  readonly receiverId: string;
  readonly actions: {
    methodName: string;
    args: Record<string, unknown>;
    gas: string;
    deposit: string;
  }[];
}

/**
 * Every prepared cascade ends here: the safety check, then its verdict stored as a `prepare` (ALLOW) or
 * `prepare_blocked` (BLOCK) row with the per-rule checks and the steps a signed transaction must match.
 */
export async function sealCascade(
  record: (e: AppEvent) => Promise<void>,
  account: string,
  intent: Record<string, unknown>,
  cascade: PreparedCascade,
  ctx: CascadeValidationContext,
  now: Date = new Date(),
): Promise<SealResult> {
  const check = validateCascade(cascade.transactions, ctx);
  const cascadeId = randomUUID();
  await record({
    at: now,
    kind: check.ok ? 'prepare' : 'prepare_blocked',
    accountId: account,
    source: 'server',
    cascadeId,
    intent,
    verdict: check.ok ? 'ALLOW' : 'BLOCK',
    checks: check.checks,
    detail: {
      summary: check.summary,
      preview: cascade.preview,
      steps: cascade.transactions.map((t) => ({
        intentId: t.intentId,
        receiverId: t.receiverId,
        methods: t.actions.map((a) => a.methodName),
      })),
    },
  });
  if (!check.ok) return { ok: false, reasons: check.reasons };
  return {
    ok: true,
    cascadeId,
    transactions: cascade.transactions.map((t) => ({
      intentId: t.intentId,
      receiverId: t.receiverId,
      actions: t.actions.map((a) => ({
        methodName: a.methodName,
        args: a.args,
        gas: a.gas.toString(),
        deposit: a.deposit.toString(),
      })),
    })),
  };
}
