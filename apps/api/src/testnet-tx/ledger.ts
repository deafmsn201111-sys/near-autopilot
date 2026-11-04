import { accountIdSchema } from '@near-autopilot/core';
import { and, desc, eq, testnetTransactions, type Database } from '@near-autopilot/db';
import { z } from 'zod';
import type { TestnetTxLedger, TestnetTxRecord, TestnetTxStatus, TxPreview } from './model';

type Row = typeof testnetTransactions.$inferSelect;

const previewSchema: z.ZodType<TxPreview, z.ZodTypeDef, unknown> = z.object({
  network: z.literal('testnet'),
  chainId: z.string(),
  blockHeight: z.number(),
  operation: z.string(),
  signerId: z.string(),
  receiverId: z.string(),
  methodName: z.string(),
  args: z.record(z.unknown()),
  depositYocto: z.string(),
  gas: z.string(),
  gasPriceYocto: z.string(),
  maxFeeYocto: z.string(),
  maxCostYocto: z.string(),
  availableBeforeYocto: z.string(),
  budget: z.object({ spentYocto: z.string(), remainingAfterYocto: z.string() }),
  expectedResult: z.string(),
  risks: z.array(z.string()),
});

const fromRow = (r: Row): TestnetTxRecord => ({
  id: r.id,
  previewHash: r.previewHash,
  network: r.network,
  signerId: accountIdSchema.parse(r.signerId),
  operation: r.operation,
  receiverId: accountIdSchema.parse(r.receiverId === '' ? r.signerId : r.receiverId),
  methodName: r.methodName,
  preview: previewSchema.parse(r.preview),
  status: r.status,
  depositYocto: BigInt(r.depositYocto),
  maxCostYocto: BigInt(r.maxCostYocto),
  actualCostYocto: r.actualCostYocto === null ? null : BigInt(r.actualCostYocto),
  txHash: r.txHash,
  error: r.error,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  updatedAt: r.updatedAt,
});

export class DrizzleTestnetTxLedger implements TestnetTxLedger {
  constructor(private readonly db: Database) {}

  async insert(r: TestnetTxRecord): Promise<void> {
    await this.db.insert(testnetTransactions).values({
      ...r,
      depositYocto: r.depositYocto.toString(),
      maxCostYocto: r.maxCostYocto.toString(),
      actualCostYocto: r.actualCostYocto?.toString() ?? null,
    });
  }

  async byPreviewHash(hash: string): Promise<TestnetTxRecord | null> {
    const [r] = await this.db
      .select()
      .from(testnetTransactions)
      .where(eq(testnetTransactions.previewHash, hash));
    return r ? fromRow(r) : null;
  }

  async byTxHash(hash: string): Promise<TestnetTxRecord | null> {
    const [r] = await this.db
      .select()
      .from(testnetTransactions)
      .where(eq(testnetTransactions.txHash, hash));
    return r ? fromRow(r) : null;
  }

  async transition(
    id: string,
    from: TestnetTxStatus,
    patch: Parameters<TestnetTxLedger['transition']>[2],
  ): Promise<boolean> {
    const { actualCostYocto, ...rest } = patch;
    const updated = await this.db
      .update(testnetTransactions)
      .set({
        ...rest,
        ...(actualCostYocto === undefined
          ? {}
          : { actualCostYocto: actualCostYocto?.toString() ?? null }),
      })
      .where(and(eq(testnetTransactions.id, id), eq(testnetTransactions.status, from)))
      .returning({ id: testnetTransactions.id });
    return updated.length === 1;
  }

  async list(limit: number): Promise<TestnetTxRecord[]> {
    const rows = await this.db
      .select()
      .from(testnetTransactions)
      .orderBy(desc(testnetTransactions.createdAt))
      .limit(limit);
    return rows.map(fromRow);
  }
}

/** Same compare-and-set semantics, for tests. */
export class InMemoryTestnetTxLedger implements TestnetTxLedger {
  readonly rows = new Map<string, TestnetTxRecord>();

  async insert(r: TestnetTxRecord): Promise<void> {
    if ([...this.rows.values()].some((x) => x.previewHash === r.previewHash)) {
      throw new Error('duplicate preview hash');
    }
    this.rows.set(r.id, r);
  }
  async byPreviewHash(hash: string) {
    return [...this.rows.values()].find((r) => r.previewHash === hash) ?? null;
  }
  async byTxHash(hash: string) {
    return [...this.rows.values()].find((r) => r.txHash === hash) ?? null;
  }
  async transition(
    id: string,
    from: TestnetTxStatus,
    patch: Parameters<TestnetTxLedger['transition']>[2],
  ): Promise<boolean> {
    const r = this.rows.get(id);
    if (!r || r.status !== from) return false;
    this.rows.set(id, { ...r, ...patch });
    return true;
  }
  async list(limit: number) {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
