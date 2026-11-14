import { RpcError, UnexpectedResponseError } from '@near-autopilot/core';
import { z } from 'zod';
import type { NearRpcClient } from './rpc-client';

export interface TxReceipt {
  readonly executorId: string;
  readonly logs: readonly string[];
  /** The contract's error when this receipt failed, else null. */
  readonly failure: string | null;
}

export interface TxOutcome {
  readonly hash: string;
  readonly signerId: string;
  readonly receiverId: string;
  readonly methods: readonly string[];
  /** True only when the transaction and every one of its receipts succeeded. */
  readonly ok: boolean;
  readonly receipts: readonly TxReceipt[];
}

const statusSchema = z.union([
  z.object({ SuccessValue: z.string() }),
  z.object({ SuccessReceiptId: z.string() }),
  z.object({ Failure: z.unknown() }),
  z.literal('Unknown'),
  z.object({ Unknown: z.unknown() }),
]);

const txSchema = z.object({
  final_execution_status: z.string().optional(),
  status: statusSchema,
  transaction: z.object({
    hash: z.string(),
    signer_id: z.string(),
    receiver_id: z.string(),
    actions: z.array(z.unknown()),
  }),
  receipts_outcome: z.array(
    z.object({
      outcome: z.object({
        executor_id: z.string(),
        logs: z.array(z.string()),
        status: statusSchema,
      }),
    }),
  ),
});

type Status = z.infer<typeof statusSchema>;

function failureText(failure: unknown): string {
  const execution = (failure as { ActionError?: { kind?: { FunctionCallError?: unknown } } })
    ?.ActionError?.kind?.FunctionCallError as { ExecutionError?: unknown } | undefined;
  if (typeof execution?.ExecutionError === 'string') return execution.ExecutionError;
  return JSON.stringify(failure);
}

const failureOf = (s: Status): string | null =>
  typeof s === 'object' && 'Failure' in s ? failureText(s.Failure) : null;

const methodOf = (action: unknown): string => {
  const call = (action as { FunctionCall?: { method_name?: unknown } } | null)?.FunctionCall;
  return typeof call?.method_name === 'string' ? call.method_name : 'non-function-call';
};

const notThereYet = (e: unknown) =>
  e instanceof RpcError &&
  (e.kind === 'timeout' || /UNKNOWN_TRANSACTION|TIMEOUT_ERROR/.test(e.message));

/** Final status of a signed transaction, read by hash from NEAR RPC. */
export class NearTransactionStatusReader {
  constructor(private readonly rpc: NearRpcClient) {}

  /** Null while the network does not know the transaction or has not finalised it. */
  async status(hash: string, signerId: string): Promise<TxOutcome | null> {
    let raw: unknown;
    try {
      // ponytail: one attempt, no client-side retries: the caller asks again a few seconds later.
      raw = await this.rpc.call(
        'tx',
        { tx_hash: hash, sender_account_id: signerId, wait_until: 'FINAL' },
        { idempotent: false },
      );
    } catch (e) {
      if (notThereYet(e)) return null;
      throw e;
    }
    const parsed = txSchema.safeParse(raw);
    if (!parsed.success) throw new UnexpectedResponseError(`tx:${hash}`, 'malformed response');
    const { status, transaction, receipts_outcome } = parsed.data;
    if (status === 'Unknown' || (typeof status === 'object' && 'Unknown' in status)) return null;
    const receipts = receipts_outcome.map(({ outcome }) => ({
      executorId: outcome.executor_id,
      logs: outcome.logs,
      failure: failureOf(outcome.status),
    }));
    return {
      hash: transaction.hash,
      signerId: transaction.signer_id,
      receiverId: transaction.receiver_id,
      methods: transaction.actions.map(methodOf),
      ok: failureOf(status) === null && receipts.every((r) => r.failure === null),
      receipts,
    };
  }
}
