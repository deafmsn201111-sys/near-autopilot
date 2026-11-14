import type { ProvenanceTier } from '@near-autopilot/core';
import { z } from 'zod';

export interface DepositAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly icon?: string | null;
}
export interface DepositOrigin extends DepositAsset {
  readonly chain: string;
  readonly chainName: string;
}
export interface DepositAssets {
  readonly origins: readonly DepositOrigin[];
  readonly destinations: readonly DepositAsset[];
}
export interface DepositQuote {
  readonly id: string;
  readonly chain: string;
  readonly chainName: string;
  /** Where the funds arrive: NEAR for a deposit, the target chain for a withdrawal. */
  readonly to: { readonly chain: string; readonly chainName: string };
  readonly origin: DepositAsset & { readonly payment: PaymentToken };
  readonly destination: DepositAsset;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly amountOutUsd: { readonly value: string; readonly provenance: ProvenanceTier };
  readonly fee: { readonly bps: number | null; readonly provenance: ProvenanceTier };
  readonly recipient: string;
  readonly refundTo: string;
  readonly depositAddress: string;
  readonly deadline: string;
  readonly expiresInSeconds: number;
  readonly timeEstimateSeconds: number;
}
/** What a payment link may ask the wallet to send, decided by the API from the quoted asset; null: address only. */
export type PaymentToken = { readonly native: true } | { readonly contract: string } | null;
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function call<T>(url: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store', ...init });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    if (res.ok) return { ok: true, data: body as T };
    return {
      ok: false,
      error: typeof body.error === 'string' ? body.error : `Request failed (HTTP ${res.status}).`,
    };
  } catch {
    return { ok: false, error: 'The site is unreachable. Check your connection and try again.' };
  }
}

export const loadDepositAssets = () => call<DepositAssets>('/api/deposit/assets');

export const requestQuote = <T>(url: string, form: object) =>
  call<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form),
  });

/** 1500000 with 6 decimals -> "1.5". Exact: integer string in, decimal string out. */
export function formatUnits(units: string, decimals: number): string {
  const digits = units.replace(/^0+(?=\d)/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export const DEPOSIT_CHAINS = [
  { id: 'eth', name: 'Ethereum', native: 'ETH' },
  { id: 'base', name: 'Base', native: 'ETH' },
  { id: 'arb', name: 'Arbitrum', native: 'ETH' },
  { id: 'sol', name: 'Solana', native: 'SOL' },
  { id: 'btc', name: 'Bitcoin', native: 'BTC' },
] as const;

/** The token to send by default on a chain: USDC, else the chain's native token, else the first listed there. */
export function defaultOrigin(
  origins: readonly DepositOrigin[],
  chain: string,
): DepositOrigin | undefined {
  const here = origins.filter((o) => o.chain === chain);
  const native = DEPOSIT_CHAINS.find((c) => c.id === chain)?.native;
  return here.find((o) => o.symbol === 'USDC') ?? here.find((o) => o.symbol === native) ?? here[0];
}

/** Tokens whose symbol contains the query (any case), those starting with it first; the order is kept otherwise. */
export function searchTokens<T extends DepositAsset>(list: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...list];
  const hits = list.filter((t) => t.symbol.toLowerCase().includes(q));
  return [
    ...hits.filter((t) => t.symbol.toLowerCase().startsWith(q)),
    ...hits.filter((t) => !t.symbol.toLowerCase().startsWith(q)),
  ];
}

const units = z
  .string()
  .regex(/^\d{1,40}$/)
  .nullable();
const depositStatus = z.object({
  status: z.enum([
    'PENDING_DEPOSIT',
    'KNOWN_DEPOSIT_TX',
    'PROCESSING',
    'INCOMPLETE_DEPOSIT',
    'SUCCESS',
    'REFUNDED',
    'FAILED',
    'UNKNOWN',
  ]),
  depositedAmount: units,
  amountOut: units,
  refundedAmount: units,
  refundReason: z.string().max(40).nullable(),
  nearTxHash: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/)
    .nullable(),
  deadlinePassed: z.boolean(),
});
/** `GET /api/deposit/status/:id`: 1Click's status, checked by the API. Amounts are base-unit strings. */
export type DepositStatus = z.infer<typeof depositStatus>;
type SwapStatus = DepositStatus['status'];

export async function loadDepositStatus(id: string): Promise<Result<DepositStatus>> {
  const r = await call<unknown>(`/api/deposit/status/${encodeURIComponent(id)}`);
  if (!r.ok) return r;
  const parsed = depositStatus.safeParse(r.data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: 'The deposit status could not be read. It is checked again shortly.' };
}

const WALLET_CHAIN: Record<string, 'evm' | 'solana'> = {
  eth: 'evm',
  base: 'evm',
  arb: 'evm',
  sol: 'solana',
};
/** Which connected wallet's address a withdrawal to this chain may go to; null: none. */
export const walletChainOf = (chain: string): 'evm' | 'solana' | null =>
  WALLET_CHAIN[chain] ?? null;

export const STATUS_MAX_CHECKS = 120;
export const statusDelayMs = (checks: number) =>
  Math.round(Math.min(5_000 * 1.5 ** checks, 30_000));

const FINAL: readonly SwapStatus[] = ['SUCCESS', 'REFUNDED', 'FAILED'];

/** Why polling stops now, or null to keep going. A seen deposit may finish after the deadline, so only an unpaid quote expires. */
export function stopReason(
  s: DepositStatus | null,
  checks: number,
): 'final' | 'expired' | 'limit' | null {
  if (s && FINAL.includes(s.status)) return 'final';
  if (s?.status === 'PENDING_DEPOSIT' && s.deadlinePassed) return 'expired';
  return checks >= STATUS_MAX_CHECKS ? 'limit' : null;
}

export interface StatusScreen {
  readonly tone: 'wait' | 'ok' | 'warn';
  readonly title: string;
  readonly detail?: string;
  readonly txUrl?: string;
}

const REFUND_REASONS: Record<string, string> = {
  PARTIAL_DEPOSIT: 'the deposit was less than the quote',
};

export function describeStatus(s: DepositStatus | null, q: DepositQuote): StatusScreen {
  const sent = (units: string) => `${formatUnits(units, q.origin.decimals)} ${q.origin.symbol}`;
  const received = s?.depositedAmount
    ? `Received ${formatUnits(s.depositedAmount, q.origin.decimals)} of ${sent(q.amountIn)}`
    : null;
  const withReceived = (screen: StatusScreen): StatusScreen =>
    received ? { ...screen, detail: `${received}.` } : screen;
  switch (s?.status) {
    case undefined:
      return { tone: 'wait', title: 'Checking the deposit status…' };
    case 'PENDING_DEPOSIT':
      return s.deadlinePassed
        ? {
            tone: 'warn',
            title: 'Expired: no deposit seen by the deadline',
            detail: 'Do not send to this address; get a new one.',
          }
        : { tone: 'wait', title: 'Waiting for your deposit' };
    case 'KNOWN_DEPOSIT_TX':
      return withReceived({
        tone: 'wait',
        title: `Deposit seen on ${q.chainName}, waiting for confirmations`,
      });
    case 'PROCESSING':
      return withReceived({
        tone: 'wait',
        title: `Deposit received, swapping to ${q.destination.symbol}`,
      });
    case 'INCOMPLETE_DEPOSIT': {
      const detail = `Less than the quote arrived. 1Click refunds it to ${q.refundTo} after the deadline.`;
      if (!s.depositedAmount) return { tone: 'warn', title: 'Incomplete deposit', detail };
      const missing = BigInt(q.amountIn) - BigInt(s.depositedAmount);
      return {
        tone: 'warn',
        title: `${received}: ${sent((missing > 0n ? missing : 0n).toString())} missing`,
        detail,
      };
    }
    case 'SUCCESS': {
      const what = s.amountOut
        ? `${formatUnits(s.amountOut, q.destination.decimals)} ${q.destination.symbol}`
        : 'the swap';
      return {
        tone: 'ok',
        title: `Done: ${what} arrived in ${q.recipient}`,
        ...(s.nearTxHash ? { txUrl: `https://nearblocks.io/txns/${s.nearTxHash}` } : {}),
      };
    }
    case 'REFUNDED':
      return {
        tone: 'warn',
        title: s.refundedAmount
          ? `Refunded: ${sent(s.refundedAmount)} sent back to ${q.refundTo}`
          : `Refunded to ${q.refundTo}`,
        ...(s.refundReason
          ? { detail: `Reason: ${REFUND_REASONS[s.refundReason] ?? s.refundReason}.` }
          : {}),
      };
    case 'FAILED':
      return {
        tone: 'warn',
        title: 'The swap failed',
        detail: `1Click refunds a deposit to ${q.refundTo}.`,
      };
    default:
      return {
        tone: 'wait',
        title: 'Unknown status from 1Click',
        detail: 'Not trusted as done; checking again.',
      };
  }
}
