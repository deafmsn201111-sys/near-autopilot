import type { TestnetTxResponse } from '@near-autopilot/core';
import { formatNear, spentYocto, TESTNET_TX_LIMITS, type TestnetTxLedger } from './model';

/** Read-only ledger view for the HTTP API and dashboard. */
export function testnetTxView(ledger: TestnetTxLedger): {
  list(limit: number): Promise<TestnetTxResponse>;
} {
  return {
    async list(limit) {
      const all = await ledger.list(500);
      return {
        budgetNear: formatNear(TESTNET_TX_LIMITS.totalBudgetYocto),
        spentNear: formatNear(spentYocto(all)),
        transactions: all.slice(0, limit).map((r) => ({
          id: r.id,
          status: r.status,
          operation: r.operation,
          signerId: r.signerId,
          receiverId: r.receiverId,
          methodName: r.methodName,
          depositNear: formatNear(r.depositYocto),
          maxCostNear: formatNear(r.maxCostYocto),
          actualCostNear: r.actualCostYocto === null ? null : formatNear(r.actualCostYocto),
          txHash: r.txHash,
          error: r.error,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  };
}
