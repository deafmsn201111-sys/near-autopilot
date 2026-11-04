import type {
  AccountId,
  BroadcastResult,
  SignedTransaction,
  TransactionBroadcaster,
} from '@near-autopilot/core';
import { RpcError, UnexpectedResponseError } from '@near-autopilot/core';
import { z } from 'zod';
import type { NearRpcClient } from './rpc-client';

const outcomeStatus = z.union([
  z.object({ SuccessValue: z.string() }).passthrough(),
  z.object({ SuccessReceiptId: z.string() }).passthrough(),
  z.object({ Failure: z.unknown() }).passthrough(),
]);

const sendTxResult = z
  .object({
    final_execution_status: z.string().optional(),
    status: outcomeStatus.optional(),
    transaction: z.object({ hash: z.string() }).passthrough(),
    receipts_outcome: z
      .array(
        z
          .object({
            id: z.string().optional(),
            outcome: z.object({ status: outcomeStatus }).passthrough(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/**
 * Broadcasts a signed transaction and waits for FINAL execution. Because NEAR transactions fan
 * out into receipts, success requires *every* receipt to succeed, not just the first one.
 *
 * Known limit: a cross-contract call that completes but refunds (e.g. ft_transfer_call returning
 * unused tokens) is not a failure status; compare balances after execution if that matters.
 */
export class NearTransactionBroadcaster implements TransactionBroadcaster {
  constructor(private readonly rpc: NearRpcClient) {}

  async broadcast(signed: SignedTransaction, signerId: AccountId): Promise<BroadcastResult> {
    let raw: unknown;
    try {
      raw = await this.rpc.call(
        'send_tx',
        { signed_tx_base64: signed.payloadBase64, wait_until: 'FINAL' },
        { idempotent: false },
      );
    } catch (error) {
      if (error instanceof RpcError) {
        throw new RpcError(
          `${error.message} (tx ${signed.hash} from ${signerId} may or may not have landed; check its status before retrying)`,
          false,
          { cause: error },
        );
      }
      throw error;
    }

    const parsed = sendTxResult.safeParse(raw);
    if (!parsed.success)
      throw new UnexpectedResponseError(`send_tx:${signed.hash}`, 'malformed outcome');

    const failures: string[] = [];
    if (parsed.data.status && 'Failure' in parsed.data.status) {
      failures.push(`transaction: ${JSON.stringify(parsed.data.status.Failure)}`);
    }
    for (const receipt of parsed.data.receipts_outcome) {
      if ('Failure' in receipt.outcome.status) {
        failures.push(
          `receipt ${receipt.id ?? '?'}: ${JSON.stringify(receipt.outcome.status.Failure)}`,
        );
      }
    }
    return {
      txHash: parsed.data.transaction.hash,
      status: failures.length === 0 ? 'success' : 'failure',
      failureReason: failures.length === 0 ? null : failures.join('; '),
    };
  }
}
