import type { TxOutcome } from '@near-autopilot/near-adapter';

/**
 * What a signed transaction actually did, in plain words, read from its receipts' logs: Burrow NEP-297 events, Rhea
 * "Swapped" lines and NEP-141 transfers (plus wrap.near's older "Transfer … from … to …" lines). Logs are untrusted
 * chain data: only these fixed shapes are read, amounts must be integer strings, and unknown tokens show their id.
 */
export interface OutcomeContext {
  readonly account: string;
  readonly burrowId: string;
  readonly tokens: ReadonlyMap<string, { readonly symbol: string; readonly decimals: number }>;
}

export interface OutcomeSummary {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly failure?: { readonly contract: string; readonly error: string };
  readonly funds?: string;
}

interface Transfer {
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

const INTEGER = /^\d{1,40}$/;
const BURROW_VERBS: Record<string, string> = {
  deposit: 'Supplied',
  repay: 'Repaid',
  borrow: 'Borrowed',
  withdraw_succeeded: 'Withdrew',
};

function eventOf(log: string): { standard?: unknown; event?: unknown; data?: unknown } | null {
  if (!log.startsWith('EVENT_JSON:')) return null;
  try {
    const parsed: unknown = JSON.parse(log.slice('EVENT_JSON:'.length));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const records = (data: unknown): Record<string, unknown>[] =>
  Array.isArray(data)
    ? data.filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
    : [];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function format(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const shown = Math.min(6, decimals);
  const frac = ((amount % base) * 10n ** BigInt(shown)) / base;
  const fracText = shown ? frac.toString().padStart(shown, '0').replace(/0+$/, '') : '';
  return fracText ? `${amount / base}.${fracText}` : `${amount / base}`;
}

function transfersOf(out: TxOutcome): Transfer[] {
  const found: Transfer[] = [];
  for (const r of out.receipts)
    for (const log of r.logs) {
      const legacy = /^(?:Transfer|Refund) (\d{1,40}) from (\S+) to (\S+)$/.exec(log);
      if (legacy)
        found.push({
          token: r.executorId,
          from: legacy[2]!,
          to: legacy[3]!,
          amount: BigInt(legacy[1]!),
        });
      const e = eventOf(log);
      if (e?.standard !== 'nep141' || e.event !== 'ft_transfer') continue;
      for (const d of records(e.data)) {
        const amount = str(d['amount']);
        if (INTEGER.test(amount))
          found.push({
            token: r.executorId,
            from: str(d['old_owner_id']),
            to: str(d['new_owner_id']),
            amount: BigInt(amount),
          });
      }
    }
  return found;
}

/** The contract's own words, without the runtime's "panicked at file:line" prefix. */
function plainError(failure: string): string {
  const text = failure
    .replace(/^Smart contract panicked: /, '')
    .replace(/^panicked at [^\n]*:\d+:\d+:\n/, '')
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

export function describeOutcome(out: TxOutcome, ctx: OutcomeContext): OutcomeSummary {
  const amount = (token: string, raw: bigint, decimals?: number) => {
    const meta = ctx.tokens.get(token);
    const symbol = meta?.symbol ?? (token.length > 20 ? `${token.slice(0, 8)}…` : token);
    return `${format(raw, decimals ?? meta?.decimals ?? 24)} ${symbol}`;
  };
  const transfers = transfersOf(out);
  const lines: string[] = [];

  const burrow: { verb: string; token: string; raw: bigint }[] = [];
  for (const r of out.receipts) {
    if (r.executorId !== ctx.burrowId) continue;
    for (const log of r.logs) {
      const e = eventOf(log);
      const verb = BURROW_VERBS[str(e?.event)];
      if (e?.standard !== 'burrow' || !verb) continue;
      for (const d of records(e.data)) {
        const raw = str(d['amount']);
        if (str(d['account_id']) === ctx.account && INTEGER.test(raw))
          burrow.push({ verb, token: str(d['token_id']), raw: BigInt(raw) });
      }
    }
  }
  // A repay paid from the wallet first lands as a deposit; the repay is the action, not a supply.
  const repaid = new Set(burrow.filter((b) => b.verb === 'Repaid').map((b) => b.token));
  for (const b of burrow) {
    if (b.verb === 'Supplied' && repaid.has(b.token)) continue;
    const decimals = ctx.tokens.get(b.token)?.decimals ?? 24;
    // ponytail: Burrow keeps balances with extra decimals up to 18 for every listed token; read it from the asset config if one is listed otherwise.
    const sent = transfers.find(
      (t) => t.token === b.token && t.from === ctx.account && t.to === ctx.burrowId,
    );
    const got = transfers.find(
      (t) => t.token === b.token && t.to === ctx.account && t.from === ctx.burrowId,
    );
    const raw = b.verb === 'Withdrew' || b.verb === 'Borrowed' ? got?.amount : sent?.amount;
    const where = b.verb === 'Withdrew' ? 'from Burrow' : 'on Burrow';
    lines.push(
      `${b.verb} ${raw === undefined ? amount(b.token, b.raw, Math.max(decimals, 18)) : amount(b.token, raw)} ${where}`,
    );
  }

  const swaps = out.receipts.flatMap((r) =>
    r.logs.flatMap((l) => {
      const m = /^Swapped (\d{1,40}) (\S+) for (\d{1,40}) (\S+?),/.exec(l);
      return m
        ? [{ inRaw: BigInt(m[1]!), inToken: m[2]!, outRaw: BigInt(m[3]!), outToken: m[4]! }]
        : [];
    }),
  );
  const first = swaps[0];
  const last = swaps.at(-1);
  if (first && last)
    lines.push(
      `Swapped ${amount(first.inToken, first.inRaw)} → ${amount(last.outToken, last.outRaw)} on Rhea`,
    );

  if (out.ok) return { ok: true, lines };

  const failed = out.receipts.find((r) => r.failure !== null);
  const left = transfers.filter((t) => t.from === ctx.account);
  const back = left.filter((t) =>
    transfers.some(
      (u) =>
        u.token === t.token && u.to === ctx.account && u.from === t.to && u.amount === t.amount,
    ),
  );
  const missing = left.filter((t) => !back.includes(t));
  const funds =
    left.length === 0
      ? 'No funds left your wallet.'
      : missing.length === 0
        ? `Refund confirmed: ${back.map((t) => amount(t.token, t.amount)).join(', ')} is back in your wallet.`
        : `${missing.map((t) => amount(t.token, t.amount)).join(', ')} left your wallet and did not come back yet: check the transaction.`;
  return {
    ok: false,
    lines,
    failure: {
      contract: failed?.executorId ?? out.receiverId,
      error: plainError(failed?.failure ?? 'the transaction failed'),
    },
    funds,
  };
}
