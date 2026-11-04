import {
  canonicalJson,
  errorMessage,
  type AccountId,
  type Clock,
  type IdGenerator,
  type TransactionBroadcaster,
  type TransactionSigner,
} from '@near-autopilot/core';
import { sha256Hex } from '@near-autopilot/core/hash';
import type { TestnetChainReader } from './chain';
import {
  IN_FLIGHT,
  spentYocto,
  STORAGE_PRICE_PER_BYTE,
  TESTNET_TX_LIMITS,
  TX_OVERHEAD_GAS,
  formatNear,
  type TestnetTxLedger,
  type TestnetTxRecord,
  type TxPreview,
} from './model';
import {
  isOperationId,
  OperationRefused,
  planOperation,
  type OperationId,
  type PlannedOperation,
} from './operations';

export interface TestnetTxServiceDeps {
  /** The only account this tool acts for (TESTNET_ACCOUNT_ID). */
  readonly accountId: AccountId;
  readonly chain: TestnetChainReader;
  readonly ledger: TestnetTxLedger;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly limits?: typeof TESTNET_TX_LIMITS;
}

export class TestnetTxRefused extends Error {}

/** Gas price can rise between preview and inclusion; budget against a 20% higher price. */
const padGasPrice = (p: bigint) => (p * 12n) / 10n;

/**
 * Prepare -> (user confirms) -> send -> reconcile, for TESTNET only, within hard limits. Nothing here signs unless
 * `send` is called with the exact preview hash, a signer for this account, and every check passing again on fresh
 * chain state. A send is attempted at most once per preview; an errored broadcast is recorded as `unknown`, never
 * retried and never counted as success.
 */
export class TestnetTxService {
  private readonly limits: typeof TESTNET_TX_LIMITS;

  constructor(private readonly deps: TestnetTxServiceDeps) {
    this.limits = deps.limits ?? TESTNET_TX_LIMITS;
  }

  /** Builds and records a preview. Read-only: costs nothing. Refusals are recorded too (status `rejected`). */
  async prepare(op: OperationId, options: { amountYocto?: bigint } = {}): Promise<TestnetTxRecord> {
    const now = this.deps.clock.now();
    let built: { planned: PlannedOperation; preview: TxPreview };
    try {
      built = await this.build(op, options);
    } catch (error) {
      if (!(error instanceof OperationRefused || error instanceof TestnetTxRefused)) throw error;
      const record = this.record(op, now, null, 'rejected', errorMessage(error));
      await this.deps.ledger.insert(record);
      return record;
    }
    const record = this.record(op, now, built, 'prepared', null);
    await this.deps.ledger.insert(record);
    return record;
  }

  /**
   * Signs and sends ONE prepared transaction. `confirmation` must be the full preview hash the user was shown.
   * @throws TestnetTxRefused when anything does not check out; nothing is signed in that case.
   */
  async send(
    previewHash: string,
    confirmation: string,
    signer: TransactionSigner,
    broadcaster: TransactionBroadcaster,
  ): Promise<TestnetTxRecord> {
    const { ledger, clock } = this.deps;
    if (confirmation !== previewHash) {
      throw new TestnetTxRefused(
        'confirmation does not match the preview hash: nothing was signed',
      );
    }
    const row = await ledger.byPreviewHash(previewHash);
    if (!row) throw new TestnetTxRefused(`no preview ${previewHash}`);
    if (row.status !== 'prepared') {
      throw new TestnetTxRefused(
        `preview is ${row.status}; only a prepared preview can be sent, once`,
      );
    }
    if (clock.now() >= row.expiresAt) {
      await ledger.transition(row.id, 'prepared', { status: 'expired', updatedAt: clock.now() });
      throw new TestnetTxRefused('preview expired: prepare a new one');
    }
    if (signer.accountId !== this.deps.accountId || row.signerId !== this.deps.accountId) {
      throw new TestnetTxRefused(`signer ${signer.accountId} is not ${this.deps.accountId}`);
    }
    const others = (await ledger.list(500)).filter(
      (r) => r.id !== row.id && IN_FLIGHT.has(r.status),
    );
    if (others.length > 0) {
      throw new TestnetTxRefused(
        `transaction ${others[0]?.txHash ?? others[0]?.id} is unresolved (${others[0]?.status}): run status first`,
      );
    }

    // Re-derive everything from fresh chain state; the confirmed content must not have changed.
    if (!isOperationId(row.operation))
      throw new TestnetTxRefused(`unknown operation ${row.operation}`);
    const fresh = await this.build(row.operation, {
      amountYocto: row.depositYocto,
      exclude: row.id,
    });
    const material = (p: TxPreview) =>
      canonicalJson({
        r: p.receiverId,
        m: p.methodName,
        a: p.args,
        d: p.depositYocto,
        g: p.gas,
        s: p.signerId,
      });
    if (material(fresh.preview) !== material(row.preview)) {
      throw new TestnetTxRefused(
        'the transaction would differ from the confirmed preview: prepare again',
      );
    }
    if (BigInt(fresh.preview.maxCostYocto) > row.maxCostYocto * 2n) {
      throw new TestnetTxRefused('fees rose sharply since the preview: prepare again');
    }

    const key = await this.deps.chain.accessKey(this.deps.accountId, signer.publicKey);
    if (!key)
      throw new TestnetTxRefused(
        `key ${signer.publicKey} is not registered on ${this.deps.accountId}`,
      );
    if (!key.fullAccess) {
      throw new TestnetTxRefused(
        'attached deposits need a full-access key; this key is function-call only',
      );
    }

    // Claim the preview atomically: a concurrent second `send` loses here and signs nothing.
    if (
      !(await ledger.transition(row.id, 'prepared', { status: 'approved', updatedAt: clock.now() }))
    ) {
      throw new TestnetTxRefused('preview was claimed by another send');
    }

    let signedHash: string | null = null;
    try {
      const signed = await signer.sign(
        {
          intentId: row.id,
          signerId: this.deps.accountId,
          receiverId: fresh.planned.receiverId,
          actions: [
            {
              type: 'FunctionCall',
              methodName: fresh.planned.methodName,
              args: fresh.planned.args,
              gas: fresh.planned.gas,
              deposit: fresh.planned.depositYocto,
            },
          ],
        },
        { nonce: key.nonce + 1n, blockHash: key.blockHash },
      );
      signedHash = signed.hash;
      // Persist the hash BEFORE broadcasting, so a crash mid-send leaves something to reconcile.
      await ledger.transition(row.id, 'approved', {
        status: 'submitted',
        txHash: signed.hash,
        updatedAt: clock.now(),
      });
      const result = await broadcaster.broadcast(signed, this.deps.accountId);
      return await this.settle(row.id, 'submitted', result.txHash, fresh.planned);
    } catch (error) {
      const message = errorMessage(error);
      if (signedHash === null) {
        await ledger.transition(row.id, 'approved', {
          status: 'failed',
          error: `not sent: ${message}`,
          updatedAt: clock.now(),
        });
      } else {
        await ledger.transition(row.id, 'submitted', {
          status: 'unknown',
          error: `outcome unknown, reconcile ${signedHash}: ${message}`,
          updatedAt: clock.now(),
        });
      }
      const after = await ledger.byPreviewHash(previewHash);
      if (!after) throw error;
      return after;
    }
  }

  /** Re-reads the final outcome of a submitted/unknown transaction (read-only; never re-sends). */
  async reconcile(txHash: string): Promise<TestnetTxRecord> {
    const row = await this.deps.ledger.byTxHash(txHash);
    if (!row) throw new TestnetTxRefused(`no recorded transaction ${txHash}`);
    if (row.status !== 'submitted' && row.status !== 'unknown') return row;
    // The effect check needs pre-send state, which is gone by now: report the outcome, not a re-derived effect.
    return this.settle(row.id, row.status, txHash, null);
  }

  async ledgerView(): Promise<{
    records: TestnetTxRecord[];
    spentYocto: bigint;
    remainingYocto: bigint;
  }> {
    const records = await this.deps.ledger.list(500);
    const spent = spentYocto(records);
    return { records, spentYocto: spent, remainingYocto: this.limits.totalBudgetYocto - spent };
  }

  private async settle(
    id: string,
    from: 'submitted' | 'unknown',
    txHash: string,
    planned: PlannedOperation | null,
  ): Promise<TestnetTxRecord> {
    const { ledger, clock, chain } = this.deps;
    const outcome = await chain.txOutcome(txHash, this.deps.accountId);
    const row = await ledger.byTxHash(txHash);
    if (!row) throw new TestnetTxRefused(`no recorded transaction ${txHash}`);
    if (outcome.kind !== 'final') {
      // Not final (or not visible yet): never assume success.
      if (from === 'submitted') {
        await ledger.transition(id, 'submitted', {
          status: 'unknown',
          error: `outcome not final yet (${outcome.kind}); run status ${txHash} later`,
          updatedAt: clock.now(),
        });
      }
      return (await ledger.byTxHash(txHash)) ?? row;
    }
    // A failed call refunds the attached deposit; only the burnt gas is spent.
    const actual = outcome.tokensBurntYocto + (outcome.success ? row.depositYocto : 0n);
    let note: string | null =
      outcome.failure ??
      (planned ? null : 'reconciled later: effect not re-verified, check balances');
    if (outcome.success && planned) {
      note = await planned
        .verify(chain)
        .catch((e: unknown) => `verification read failed: ${errorMessage(e)}`);
    }
    await ledger.transition(id, from, {
      status: outcome.success ? 'confirmed' : 'failed',
      actualCostYocto: actual,
      error: note,
      updatedAt: clock.now(),
    });
    return (await ledger.byTxHash(txHash)) ?? row;
  }

  private async build(
    op: OperationId,
    options: { amountYocto?: bigint; exclude?: string },
  ): Promise<{ planned: PlannedOperation; preview: TxPreview }> {
    const { chain, accountId, ledger } = this.deps;
    const status = await chain.status();
    if (status.chainId !== 'testnet') {
      throw new TestnetTxRefused(`RPC serves "${status.chainId}", not testnet: refusing`);
    }
    const account = await chain.account(accountId);
    if (!account) throw new TestnetTxRefused(`${accountId} does not exist on testnet`);
    const planned = await planOperation(op, accountId, chain, options);

    const gasPrice = await chain.gasPrice();
    const maxFee = (planned.gas + TX_OVERHEAD_GAS) * padGasPrice(gasPrice);
    const maxCost = planned.depositYocto + maxFee;
    const available = account.amount - account.storageUsage * STORAGE_PRICE_PER_BYTE;
    const others = (await ledger.list(500)).filter((r) => r.id !== options.exclude);
    const spent = spentYocto(others);
    const L = this.limits;
    if (maxCost > L.maxPerOperationYocto) {
      throw new TestnetTxRefused(
        `worst-case cost ${formatNear(maxCost)} NEAR exceeds the per-operation limit ${formatNear(L.maxPerOperationYocto)} NEAR`,
      );
    }
    if (spent + maxCost > L.totalBudgetYocto) {
      throw new TestnetTxRefused(
        `budget: ${formatNear(spent)} NEAR used, this needs up to ${formatNear(maxCost)}, limit ${formatNear(L.totalBudgetYocto)} NEAR`,
      );
    }
    if (available - maxCost < L.reserveYocto) {
      throw new TestnetTxRefused(
        `balance: ${formatNear(available)} NEAR available; must keep ${formatNear(L.reserveYocto)} NEAR after a worst case of ${formatNear(maxCost)}`,
      );
    }
    const preview: TxPreview = {
      network: 'testnet',
      chainId: status.chainId,
      blockHeight: status.blockHeight,
      operation: op,
      signerId: accountId,
      receiverId: planned.receiverId,
      methodName: planned.methodName,
      args: planned.args,
      depositYocto: planned.depositYocto.toString(),
      gas: planned.gas.toString(),
      gasPriceYocto: gasPrice.toString(),
      maxFeeYocto: maxFee.toString(),
      maxCostYocto: maxCost.toString(),
      availableBeforeYocto: available.toString(),
      budget: {
        spentYocto: spent.toString(),
        remainingAfterYocto: (L.totalBudgetYocto - spent - maxCost).toString(),
      },
      expectedResult: planned.expectedResult,
      risks: planned.risks,
    };
    return { planned, preview };
  }

  private record(
    op: OperationId,
    now: Date,
    built: { planned: PlannedOperation; preview: TxPreview } | null,
    status: 'prepared' | 'rejected',
    error: string | null,
  ): TestnetTxRecord {
    const id = this.deps.ids.next();
    const preview: TxPreview = built?.preview ?? {
      network: 'testnet',
      chainId: 'unknown',
      blockHeight: 0,
      operation: op,
      signerId: this.deps.accountId,
      receiverId: '',
      methodName: '',
      args: {},
      depositYocto: '0',
      gas: '0',
      gasPriceYocto: '0',
      maxFeeYocto: '0',
      maxCostYocto: '0',
      availableBeforeYocto: '0',
      budget: { spentYocto: '0', remainingAfterYocto: '0' },
      expectedResult: '',
      risks: [],
    };
    return {
      id,
      // Binds the confirmation to this exact content (and this record, so two identical previews differ).
      previewHash: sha256Hex(canonicalJson({ id, preview })),
      network: 'testnet',
      signerId: this.deps.accountId,
      operation: op,
      receiverId: built?.planned.receiverId ?? this.deps.accountId,
      methodName: built?.planned.methodName ?? '',
      preview,
      status,
      depositYocto: built?.planned.depositYocto ?? 0n,
      maxCostYocto: BigInt(preview.maxCostYocto),
      actualCostYocto: null,
      txHash: null,
      error,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.limits.previewTtlMs),
      updatedAt: now,
    };
  }
}
