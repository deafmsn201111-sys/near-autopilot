import type { AccountId } from '@near-autopilot/core';

/**
 * Hard limits for manually confirmed TESTNET transactions. Deliberately constants, not configuration: raising them is
 * a reviewed code change, never an env tweak. Every limit is checked against the worst-case cost of an operation
 * (attached deposit + attached gas at a padded gas price), before signing and again right before sending.
 */
export const YOCTO_PER_NEAR = 10n ** 24n;
export const TESTNET_TX_LIMITS = {
  /** 0.1 NEAR: the most one operation may cost, deposit and fees included. */
  maxPerOperationYocto: YOCTO_PER_NEAR / 10n,
  /** 1 NEAR: the most all operations together may cost (confirmed costs, plus the maximum of anything unresolved). */
  totalBudgetYocto: YOCTO_PER_NEAR,
  /** 0.5 NEAR always left available on the account, whatever the budget says. */
  reserveYocto: YOCTO_PER_NEAR / 2n,
  /** A preview older than this cannot be sent; prepare a new one. */
  previewTtlMs: 10 * 60_000,
} as const;

/** NEAR storage staking price: 10^19 yoctoNEAR per byte (0.00001 NEAR). */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
/** Margin over attached gas for the transaction's own conversion cost. */
export const TX_OVERHEAD_GAS = 5_000_000_000_000n;
export const TGAS = 1_000_000_000_000n;

export type TestnetTxStatus =
  | 'prepared'
  | 'approved'
  | 'submitted'
  | 'confirmed'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'unknown';

/** Statuses whose transaction may have reached (or may still reach) the chain: they block a new send. */
export const IN_FLIGHT: ReadonlySet<TestnetTxStatus> = new Set([
  'approved',
  'submitted',
  'unknown',
]);

export interface TestnetTxRecord {
  readonly id: string;
  readonly previewHash: string;
  readonly network: 'testnet';
  readonly signerId: AccountId;
  readonly operation: string;
  readonly receiverId: AccountId;
  readonly methodName: string;
  readonly preview: TxPreview;
  readonly status: TestnetTxStatus;
  readonly depositYocto: bigint;
  readonly maxCostYocto: bigint;
  readonly actualCostYocto: bigint | null;
  readonly txHash: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly updatedAt: Date;
}

/** Everything the user confirms. Amounts are yocto decimal strings, so the preview is exact and JSON-safe. */
export interface TxPreview {
  readonly network: 'testnet';
  readonly chainId: string;
  readonly blockHeight: number;
  readonly operation: string;
  readonly signerId: string;
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly depositYocto: string;
  readonly gas: string;
  readonly gasPriceYocto: string;
  readonly maxFeeYocto: string;
  readonly maxCostYocto: string;
  readonly availableBeforeYocto: string;
  readonly budget: { readonly spentYocto: string; readonly remainingAfterYocto: string };
  readonly expectedResult: string;
  readonly risks: readonly string[];
}

export interface TestnetTxLedger {
  insert(record: TestnetTxRecord): Promise<void>;
  byPreviewHash(hash: string): Promise<TestnetTxRecord | null>;
  byTxHash(hash: string): Promise<TestnetTxRecord | null>;
  /** Compare-and-set: changes the status only if it is currently `from`. Returns false if it was not. */
  transition(
    id: string,
    from: TestnetTxStatus,
    patch: Partial<Pick<TestnetTxRecord, 'status' | 'txHash' | 'error' | 'actualCostYocto'>> & {
      readonly status: TestnetTxStatus;
      readonly updatedAt: Date;
    },
  ): Promise<boolean>;
  list(limit: number): Promise<TestnetTxRecord[]>;
}

/** Budget consumed so far: actual cost when known, else the maximum, for anything that may have reached the chain. */
export function spentYocto(records: readonly TestnetTxRecord[]): bigint {
  let total = 0n;
  for (const r of records) {
    if (r.status === 'confirmed' || r.status === 'failed') {
      total += r.actualCostYocto ?? (r.txHash === null ? 0n : r.maxCostYocto);
    } else if (IN_FLIGHT.has(r.status)) {
      total += r.maxCostYocto;
    }
  }
  return total;
}

/** 1234500000000000000000000 -> "1.2345". Exact, no float. */
export function formatNear(yocto: bigint): string {
  const negative = yocto < 0n;
  const abs = negative ? -yocto : yocto;
  const whole = abs / YOCTO_PER_NEAR;
  const frac = (abs % YOCTO_PER_NEAR).toString().padStart(24, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** "0.01" -> 10^22. Rejects anything that is not a plain non-negative decimal with at most 24 places. */
export function parseNear(value: string): bigint {
  const m = /^(\d{1,9})(?:\.(\d{1,24}))?$/.exec(value.trim());
  if (!m) throw new Error(`not a NEAR amount: ${value}`);
  return BigInt(m[1] ?? '0') * YOCTO_PER_NEAR + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
}
