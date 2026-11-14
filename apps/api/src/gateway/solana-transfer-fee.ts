import { z } from 'zod';
import type { HttpJsonClient } from '../market-data/http';
import { isRefundAddress } from './refund-address';

/**
 * Which Solana mints can be offered as a deposit origin. A Token-2022 extension can take a fee on every transfer
 * (`transferFeeConfig`; NEARKAT: 300 bps), block it (pause, frozen accounts, a transfer hook) or move it away
 * (permanent delegate): the 1Click deposit address then gets less than the EXACT_INPUT quote, or nothing, and the
 * deposit is refunded (#185). Read-only: one `getMultipleAccounts` call per 100 mints, every 10 minutes.
 */
const TTL_MS = 10 * 60_000;
const BATCH = 100;
// A down RPC is asked again after this long, so the token list does not wait on its timeout every time.
const RETRY_MS = 60_000;
// A last answer is kept through an RPC outage this long; a hook or fee can be switched on meanwhile.
const MAX_AGE_MS = 60 * 60_000;
// Extensions that never change what a transfer delivers; any other one, including ones added later, is not offered.
const HARMLESS = new Set([
  'metadataPointer',
  'tokenMetadata',
  'mintCloseAuthority',
  'groupPointer',
  'groupMemberPointer',
  'tokenGroup',
  'tokenGroupMember',
]);

const bps = z.object({ transferFeeBasisPoints: z.number().int().min(0) });
const extension = z.object({ extension: z.string(), state: z.unknown() });
const transferFee = z.object({ olderTransferFee: bps, newerTransferFee: bps });
const noHook = z.object({ programId: z.null() });
const mintAccount = z.object({
  data: z.object({
    parsed: z.object({
      type: z.literal('mint'),
      info: z.object({ extensions: z.array(extension).optional() }),
    }),
  }),
});
const response = z.object({ result: z.object({ value: z.array(z.unknown()) }) });

function harmless(e: z.infer<typeof extension>): boolean {
  if (HARMLESS.has(e.extension)) return true;
  if (e.extension === 'transferHook') return noHook.safeParse(e.state).success;
  if (e.extension !== 'transferFeeConfig') return false;
  // The older fee applies until the newer one's epoch: both must be zero.
  const f = transferFee.safeParse(e.state);
  return (
    f.success &&
    f.data.olderTransferFee.transferFeeBasisPoints === 0 &&
    f.data.newerTransferFee.transferFeeBasisPoints === 0
  );
}

// Unreadable counts as unsafe: a mint is offered only when its account shows nothing that changes a transfer.
function unsafeMint(account: unknown): boolean {
  const m = mintAccount.safeParse(account);
  return !m.success || !(m.data.data.parsed.info.extensions ?? []).every(harmless);
}

export class SolanaTransferFees {
  private readonly known = new Map<string, { at: number; unsafe: boolean }>();
  private reading: Promise<void> | null = null;
  private failedAt = -Infinity;

  constructor(
    private readonly o: {
      readonly http: Pick<HttpJsonClient, 'postJson'>;
      readonly url: string;
      readonly now?: () => number;
      readonly onError?: (err: unknown) => void;
    },
  ) {}

  /**
   * The mints that must not be offered: an unsafe extension, or never read. A read older than 10 minutes is answered
   * at once and refreshed in the background; only a mint never read waits for the RPC. A failed read keeps the last answer.
   */
  async unsafe(mints: readonly string[]): Promise<Set<string>> {
    // Concurrent callers share one read of the same token list.
    const reading = (this.reading ??= this.refresh(mints).finally(() => (this.reading = null)));
    if (mints.some((m) => !this.known.has(m))) await reading;
    const now = this.o.now?.() ?? Date.now();
    return new Set(
      mints.filter((m) => {
        const k = this.known.get(m);
        return !k || k.unsafe || now - k.at >= MAX_AGE_MS;
      }),
    );
  }

  private async refresh(mints: readonly string[]): Promise<void> {
    const now = this.o.now?.() ?? Date.now();
    if (now - this.failedAt < RETRY_MS) return;
    const stale = [...new Set(mints)].filter((m) => {
      // getMultipleAccounts fails the whole call on one malformed key; such a mint is simply never read.
      if (!isRefundAddress('sol', m)) return false;
      const k = this.known.get(m);
      return !k || now - k.at >= TTL_MS;
    });
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH);
      const accounts = await this.read(batch).catch((err: unknown) => {
        this.o.onError?.(err);
        this.failedAt = now;
        return null;
      });
      if (!accounts) return;
      batch.forEach((m, j) => this.known.set(m, { at: now, unsafe: unsafeMint(accounts[j]) }));
    }
  }

  private async read(mints: string[]): Promise<unknown[]> {
    const raw = await this.o.http.postJson(this.o.url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [mints, { encoding: 'jsonParsed' }],
    });
    const accounts = response.parse(raw).result.value;
    if (accounts.length !== mints.length)
      throw new Error('getMultipleAccounts: wrong number of accounts');
    return accounts;
  }
}
