import { formatUnits } from '@near-autopilot/financial-engine';
import type { FastifyInstance } from 'fastify';
import type { OneClickToken } from '../gateway/one-click-deposit';
import { windowStart } from './admin';
import { EXPIRY_GRACE_MS } from './deposit';

const LIST_LIMIT = 100;

/** A stored 1Click quote with the latest status #29 saw; status null = never checked. */
export interface AdminDepositRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly accountId: string;
  readonly originAsset: string;
  readonly amountIn: string;
  readonly refundTo: string;
  readonly depositAddress: string;
  readonly deadline: Date;
  readonly feeBps: number | null;
  readonly status: string | null;
  readonly statusAt: Date | null;
}

export interface AdminDepositStore {
  /** Quotes created at or after `since`, newest first. */
  recent(since: Date): Promise<AdminDepositRow[]>;
}

export interface AdminDepositDeps {
  readonly store: AdminDepositStore;
  /** The cached 1Click token list, to name the chain and token and scale the amount. */
  readonly tokens: () => Promise<readonly OneClickToken[]>;
}

export const DEPOSIT_STATES = [
  'waiting',
  'processing',
  'success',
  'refunded',
  'failed',
  'expired',
] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];

/**
 * Unpaid after the deadline plus the grace is expired, as on the user's deposit screen; a never-checked quote too,
 * since its status is only stored while that screen is open.
 */
export function depositState(r: AdminDepositRow, now: Date): DepositState {
  switch (r.status) {
    case 'SUCCESS':
      return 'success';
    case 'REFUNDED':
      return 'refunded';
    case 'FAILED':
      return 'failed';
    case null:
    case 'PENDING_DEPOSIT':
      return now.getTime() >= r.deadline.getTime() + EXPIRY_GRACE_MS ? 'expired' : 'waiting';
    default:
      return 'processing';
  }
}

const scaled = (units: string, decimals: number) => {
  try {
    return formatUnits(BigInt(units), decimals);
  } catch {
    return units;
  }
};

const shorten = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

/** The 1Click screen: counts by state over the last 7 UTC days, and the newest quotes with addresses shortened. */
export function depositsSummary(
  rows: readonly AdminDepositRow[],
  tokens: readonly OneClickToken[],
  now: Date,
) {
  const start = windowStart(now);
  const recent = rows
    .filter((r) => r.createdAt >= start)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const counts = Object.fromEntries(DEPOSIT_STATES.map((s) => [s, 0])) as Record<
    DepositState,
    number
  >;
  for (const r of recent) counts[depositState(r, now)] += 1;

  const quotes = recent.slice(0, LIST_LIMIT).map((r) => {
    const token = tokens.find((t) => t.assetId === r.originAsset);
    return {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      accountId: r.accountId,
      chain: token?.blockchain ?? null,
      asset: token?.symbol ?? r.originAsset,
      amount: token ? scaled(r.amountIn, token.decimals) : r.amountIn,
      depositAddress: shorten(r.depositAddress),
      refundTo: shorten(r.refundTo),
      deadline: r.deadline.toISOString(),
      feeBps: r.feeBps,
      status: r.status,
      state: depositState(r, now),
      statusAt: r.statusAt?.toISOString() ?? null,
    };
  });
  return { counts, quotes };
}

/** GET /v1/admin/deposits; the admin token check is in the server's onRequest hook. */
export function registerAdminDeposits(
  app: FastifyInstance,
  deps: AdminDepositDeps,
  now: () => Date,
) {
  app.get('/v1/admin/deposits', async (req) => {
    const at = now();
    const [rows, tokens] = await Promise.all([
      deps.store.recent(windowStart(at)),
      deps.tokens().catch((err: unknown) => {
        req.log.warn({ err }, '1Click token list failed; admin shows raw asset ids');
        return [];
      }),
    ]);
    return depositsSummary(rows, tokens, at);
  });
}
