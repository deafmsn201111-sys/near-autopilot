import { describe, expect, it } from 'vitest';
import {
  accountId,
  type BroadcastResult,
  type ChainContext,
  type PlannedTransaction,
  type SignedTransaction,
  type TransactionBroadcaster,
  type TransactionSigner,
} from '@near-autopilot/core';
import type { TestnetChainReader, TxOutcome } from '../src/testnet-tx/chain';
import { InMemoryTestnetTxLedger } from '../src/testnet-tx/ledger';
import { spentYocto, YOCTO_PER_NEAR } from '../src/testnet-tx/model';
import { TestnetTxRefused, TestnetTxService } from '../src/testnet-tx/service';

const ACCOUNT = accountId('sergetest.testnet');
const NEAR = YOCTO_PER_NEAR;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR, what wrap.testnet reports

/** Mock chain: test double for the network, holding state the tests mutate. */
class FakeChain implements TestnetChainReader {
  chainId = 'testnet';
  amount = 15n * NEAR;
  storageUsage = 182n;
  registered = false;
  storageMin = STORAGE_MIN;
  wnear = 0n;
  gasPriceYocto = 100_000_000n;
  key: { nonce: bigint; blockHash: string; fullAccess: boolean } | null = {
    nonce: 10n,
    blockHash: '11111111111111111111111111111111',
    fullAccess: true,
  };
  outcome: TxOutcome = {
    kind: 'final',
    success: true,
    failure: null,
    tokensBurntYocto: 300_000_000_000_000_000_000n,
  };
  reads: string[] = [];

  async status() {
    return { chainId: this.chainId, blockHeight: 276_000_000 };
  }
  async account() {
    return { amount: this.amount, locked: 0n, storageUsage: this.storageUsage };
  }
  async accessKey() {
    return this.key;
  }
  async view(_c: string, method: string) {
    this.reads.push(method);
    if (method === 'storage_balance_of')
      return this.registered ? { total: STORAGE_MIN.toString(), available: '0' } : null;
    if (method === 'storage_balance_bounds')
      return { min: this.storageMin.toString(), max: this.storageMin.toString() };
    if (method === 'ft_balance_of') return this.wnear.toString();
    throw new Error(`unexpected view ${method}`);
  }
  async exports() {
    return [
      'storage_deposit',
      'storage_balance_bounds',
      'storage_balance_of',
      'near_deposit',
      'ft_balance_of',
    ];
  }
  async gasPrice() {
    return this.gasPriceYocto;
  }
  async txOutcome() {
    return this.outcome;
  }
}

class FakeSigner implements TransactionSigner {
  readonly publicKey = 'ed25519:FakeKeyFakeKeyFakeKeyFakeKeyFakeKeyFakeKey';
  signed: PlannedTransaction[] = [];
  constructor(readonly accountId = ACCOUNT) {}
  async sign(tx: PlannedTransaction, ctx: ChainContext): Promise<SignedTransaction> {
    this.signed.push(tx);
    return { hash: `hash-${ctx.nonce}`, payloadBase64: 'AAAA' };
  }
}

class FakeBroadcaster implements TransactionBroadcaster {
  sent = 0;
  constructor(
    private readonly behaviour: 'ok' | 'throw' = 'ok',
    private readonly chain?: FakeChain,
  ) {}
  async broadcast(signed: SignedTransaction): Promise<BroadcastResult> {
    this.sent += 1;
    if (this.behaviour === 'throw') throw new Error('socket hang up');
    if (this.chain) this.chain.registered = true;
    return { txHash: signed.hash, status: 'success', failureReason: null };
  }
}

const setup = () => {
  const chain = new FakeChain();
  const ledger = new InMemoryTestnetTxLedger();
  let now = new Date('2026-11-04T12:00:00Z');
  let n = 0;
  const service = new TestnetTxService({
    accountId: ACCOUNT,
    chain,
    ledger,
    clock: { now: () => now },
    ids: { next: () => `id-${++n}` },
  });
  return { chain, ledger, service, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
};

describe('testnet transactions: preview (read-only)', () => {
  it('prepares a storage_deposit preview with exact worst-case cost and signs nothing', async () => {
    const { service, chain } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    expect(r.status).toBe('prepared');
    expect(r.preview).toMatchObject({
      network: 'testnet',
      receiverId: 'wrap.testnet',
      methodName: 'storage_deposit',
      args: { account_id: ACCOUNT, registration_only: true },
      depositYocto: STORAGE_MIN.toString(),
      gas: '30000000000000',
    });
    // (30 + 5 Tgas) x 1e8 yocto/gas x 1.2 = 0.0042 NEAR, + 0.00125 deposit.
    expect(r.preview.maxFeeYocto).toBe('4200000000000000000000');
    expect(r.maxCostYocto).toBe(5_450_000_000_000_000_000_000n);
    expect(chain.reads).not.toContain('send_tx');
  });

  it('refuses (and records) an unnecessary registration', async () => {
    const { service, chain } = setup();
    chain.registered = true;
    const r = await service.prepare('wrap.storage_deposit');
    expect(r.status).toBe('rejected');
    expect(r.error).toContain('already registered');
  });

  it.each([
    ['a non-testnet RPC', (c: FakeChain) => (c.chainId = 'mainnet'), 'not testnet'],
    [
      'the per-operation limit',
      (c: FakeChain) => (c.gasPriceYocto = 10n ** 12n),
      'per-operation limit',
    ],
    ['the balance reserve', (c: FakeChain) => (c.amount = NEAR / 2n), 'must keep 0.5 NEAR'],
    [
      'the 14 NEAR balance floor',
      (c: FakeChain) => (c.amount = 14n * NEAR + NEAR / 1000n),
      'would go below 14 NEAR',
    ],
    [
      'an odd storage deposit',
      (c: FakeChain) => (c.storageMin = NEAR),
      'outside the expected range',
    ],
  ])('refuses on %s', async (_label, mutate, message) => {
    const { service, chain } = setup();
    mutate(chain);
    const r = await service.prepare('wrap.storage_deposit');
    expect(r.status).toBe('rejected');
    expect(r.error).toContain(message);
  });

  it('refuses once the total budget would be exceeded', async () => {
    const { service, ledger } = setup();
    const first = await service.prepare('wrap.storage_deposit');
    // Pretend earlier operations already cost 0.999 NEAR.
    ledger.rows.set(first.id, {
      ...first,
      status: 'confirmed',
      txHash: 'h0',
      actualCostYocto: 999n * 10n ** 21n,
    });
    const r = await service.prepare('wrap.storage_deposit');
    expect(r.status).toBe('rejected');
    expect(r.error).toContain('budget');
  });

  it('bounds near_deposit and requires registration first', async () => {
    const { service, chain } = setup();
    expect(
      (await service.prepare('wrap.near_deposit', { amountYocto: NEAR / 100n })).error,
    ).toContain('storage_deposit first');
    chain.registered = true;
    expect(
      (await service.prepare('wrap.near_deposit', { amountYocto: NEAR / 10n })).error,
    ).toContain('between 0.001 and 0.05');
    const ok = await service.prepare('wrap.near_deposit', { amountYocto: NEAR / 100n });
    expect(ok).toMatchObject({
      status: 'prepared',
      preview: { methodName: 'near_deposit', args: {} },
    });
  });
});

describe('testnet transactions: send needs an explicit confirmation and happens at most once', () => {
  it('refuses without the exact preview hash, and signs nothing', async () => {
    const { service } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    const signer = new FakeSigner();
    const b = new FakeBroadcaster();
    await expect(service.send(r.previewHash, 'yes', signer, b)).rejects.toThrow(TestnetTxRefused);
    await expect(
      service.send(r.previewHash, r.previewHash.slice(0, 20), signer, b),
    ).rejects.toThrow('confirmation');
    expect(signer.signed).toHaveLength(0);
    expect(b.sent).toBe(0);
  });

  it('refuses an expired preview', async () => {
    const { service, ledger, advance } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    advance(11 * 60_000);
    await expect(
      service.send(r.previewHash, r.previewHash, new FakeSigner(), new FakeBroadcaster()),
    ).rejects.toThrow('expired');
    expect((await ledger.byPreviewHash(r.previewHash))?.status).toBe('expired');
  });

  it('refuses a signer for another account and a function-call-only key', async () => {
    const { service, chain } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    await expect(
      service.send(
        r.previewHash,
        r.previewHash,
        new FakeSigner(accountId('other.testnet')),
        new FakeBroadcaster(),
      ),
    ).rejects.toThrow('is not sergetest.testnet');
    chain.key = { nonce: 1n, blockHash: '11111111111111111111111111111111', fullAccess: false };
    await expect(
      service.send(r.previewHash, r.previewHash, new FakeSigner(), new FakeBroadcaster()),
    ).rejects.toThrow('full-access');
    chain.key = null;
    await expect(
      service.send(r.previewHash, r.previewHash, new FakeSigner(), new FakeBroadcaster()),
    ).rejects.toThrow('not registered');
  });

  it('refuses when the transaction would differ from the confirmed preview', async () => {
    const { service, chain } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    chain.storageMin = STORAGE_MIN * 2n;
    const signer = new FakeSigner();
    await expect(
      service.send(r.previewHash, r.previewHash, signer, new FakeBroadcaster()),
    ).rejects.toThrow('differ');
    expect(signer.signed).toHaveLength(0);
  });

  it('sends once, records confirmed with the real cost and the verified effect, and never again', async () => {
    const { service, chain, ledger } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    const signer = new FakeSigner();
    const b = new FakeBroadcaster('ok', chain);
    const done = await service.send(r.previewHash, r.previewHash, signer, b);
    expect(done).toMatchObject({ status: 'confirmed', txHash: 'hash-11' });
    expect(done.actualCostYocto).toBe(300_000_000_000_000_000_000n + STORAGE_MIN);
    expect(done.error).toContain('registered');
    expect(signer.signed).toHaveLength(1);
    expect(signer.signed[0]).toMatchObject({
      receiverId: 'wrap.testnet',
      actions: [{ methodName: 'storage_deposit', deposit: STORAGE_MIN }],
    });
    await expect(service.send(r.previewHash, r.previewHash, signer, b)).rejects.toThrow(
      'only a prepared preview',
    );
    expect(b.sent).toBe(1);
    expect(spentYocto(await ledger.list(10))).toBe(done.actualCostYocto);
  });

  it('records an errored broadcast as unknown WITH its hash, never retries, and blocks new sends until reconciled', async () => {
    const { service, chain, ledger } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    const b = new FakeBroadcaster('throw');
    const after = await service.send(r.previewHash, r.previewHash, new FakeSigner(), b);
    expect(after).toMatchObject({ status: 'unknown', txHash: 'hash-11' });
    expect(after.error).toContain('reconcile hash-11');
    expect(b.sent).toBe(1);
    // Counted at its maximum while unresolved.
    expect(spentYocto(await ledger.list(10))).toBe(r.maxCostYocto);

    const next = await service.prepare('wrap.storage_deposit');
    await expect(
      service.send(next.previewHash, next.previewHash, new FakeSigner(), new FakeBroadcaster()),
    ).rejects.toThrow('unresolved');

    chain.outcome = { kind: 'pending' };
    expect((await service.reconcile('hash-11')).status).toBe('unknown');
    chain.outcome = { kind: 'final', success: true, failure: null, tokensBurntYocto: 1n };
    const settled = await service.reconcile('hash-11');
    expect(settled).toMatchObject({ status: 'confirmed', actualCostYocto: 1n + STORAGE_MIN });
    expect(settled.error).toContain('not re-verified');
  });

  it('a failed transaction is failed, not success, and only its burnt gas is counted', async () => {
    const { service, chain } = setup();
    chain.outcome = {
      kind: 'final',
      success: false,
      failure: '{"ActionError":{}}',
      tokensBurntYocto: 5n,
    };
    const r = await service.prepare('wrap.storage_deposit');
    const done = await service.send(
      r.previewHash,
      r.previewHash,
      new FakeSigner(),
      new FakeBroadcaster(),
    );
    expect(done).toMatchObject({ status: 'failed', actualCostYocto: 5n });
    expect(done.error).toContain('ActionError');
  });

  it('two concurrent sends of one preview sign at most once', async () => {
    const { service } = setup();
    const r = await service.prepare('wrap.storage_deposit');
    const signer = new FakeSigner();
    const results = await Promise.allSettled([
      service.send(r.previewHash, r.previewHash, signer, new FakeBroadcaster()),
      service.send(r.previewHash, r.previewHash, signer, new FakeBroadcaster()),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(signer.signed).toHaveLength(1);
  });
});
