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
export interface DepositForm {
  readonly account: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amount: string;
  readonly refundTo: string;
}

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

const incidents = z.object({
  incidents: z.array(z.object({ message: z.string().min(1).max(300) })).max(20),
});

/** 1Click's incident warnings on this route, as plain text. Any failure is no warning: the dialog works without it. */
export async function loadDepositIncidents(origin: string, destination: string): Promise<string[]> {
  const r = await call<unknown>(
    `/api/deposit/incidents?${new URLSearchParams({ origin, destination })}`,
  );
  const parsed = r.ok ? incidents.safeParse(r.data) : null;
  return parsed?.success ? parsed.data.incidents.map((i) => i.message) : [];
}

export const loadDepositAssets = () => call<DepositAssets>('/api/deposit/assets');

export const requestQuote = <T>(url: string, form: object) =>
  call<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form),
  });

export const requestDepositQuote = (form: DepositForm) =>
  requestQuote<DepositQuote>('/api/deposit/quote', form);

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

/** The token to receive by default: the same symbol when we list it, else USDC, else the first. */
export function defaultDestination(
  origin: DepositOrigin | undefined,
  destinations: readonly DepositAsset[],
): DepositAsset | undefined {
  return (
    destinations.find((d) => d.symbol === origin?.symbol) ??
    destinations.find((d) => d.symbol === 'USDC') ??
    destinations[0]
  );
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

const depositTransfer = z.object({
  quoteId: z.string(),
  chain: z.string(),
  receiver: z.string().min(1).max(100),
  amount: z.string().regex(/^[1-9]\d{0,39}$/),
  token: z.object({
    assetId: z.string(),
    blockchain: z.string(),
    symbol: z.string().max(40),
    decimals: z.number().int().min(0).max(36),
    contractAddress: z.string().min(1).max(100).nullable(),
  }),
});
/** `GET /api/deposit/transfer/:id`: what the origin wallet is asked to send, rebuilt by the API from the stored quote. */
export type DepositTransfer = z.infer<typeof depositTransfer>;

/**
 * The transfer the API built for this quote, refused unless it is exactly the quote on screen: chain, asset, decimals,
 * amount and deposit address. Only then may the user's origin wallet be asked to send it. The API hands a quote's
 * transfer out once; `retry` asks again after the wallet rejected the send.
 */
export async function loadDepositTransfer(
  q: DepositQuote,
  retry = false,
): Promise<Result<DepositTransfer>> {
  const r = await call<unknown>(
    `/api/deposit/transfer/${encodeURIComponent(q.id)}${retry ? '?retry=1' : ''}`,
  );
  if (!r.ok) return r;
  const parsed = depositTransfer.safeParse(r.data);
  const t = parsed.success ? parsed.data : null;
  const same =
    t?.quoteId === q.id &&
    t.chain === q.chain &&
    t.token.blockchain === q.chain &&
    t.receiver === q.depositAddress &&
    t.amount === q.amountIn &&
    t.token.assetId === q.origin.assetId &&
    t.token.decimals === q.origin.decimals;
  return t && same
    ? { ok: true, data: t }
    : {
        ok: false,
        error: 'The transfer does not match this quote, so it was not sent. Send it manually.',
      };
}

const WALLET_CHAIN: Record<string, 'evm' | 'solana'> = {
  eth: 'evm',
  base: 'evm',
  arb: 'evm',
  sol: 'solana',
};
/** Which connected wallet sends on a deposit chain; null: none (Bitcoin is sent manually). */
export const walletChainOf = (chain: string): 'evm' | 'solana' | null =>
  WALLET_CHAIN[chain] ?? null;

/** Why an origin-wallet send threw, as `sendFailure` (lib/hot-kit.ts) reads the wallet's error. */
export type SendFailure = 'declined' | 'no-gas' | 'no-token' | 'not-sent' | 'unknown';

/** What the user is told for a send that did not go out; `why` is the wallet's own text. */
export function walletSendError(
  kind: Exclude<SendFailure, 'unknown'>,
  q: DepositQuote,
  why: string,
): string {
  const again = 'Top it up and press the button again.';
  const fee = DEPOSIT_CHAINS.find((c) => c.id === q.chain)?.native ?? 'native coin';
  const amount = `${formatUnits(q.amountIn, q.origin.decimals)} ${q.origin.symbol}`;
  const native = q.origin.payment !== null && 'native' in q.origin.payment;
  if (kind === 'declined') return 'You declined in your wallet. Nothing was sent.';
  if (kind === 'not-sent') return `Nothing was sent: the network refused the transfer (${why}).`;
  if (native)
    return `Nothing was sent: your wallet needs ${amount} on ${q.chainName} plus a little more for the network fee. ${again}`;
  return kind === 'no-gas'
    ? `Nothing was sent: your wallet does not have enough ${fee} on ${q.chainName} to pay the network fee. Add a little ${fee} on ${q.chainName} (cents are enough) and press the button again.`
    : `Nothing was sent: your wallet on ${q.chainName} has less than ${amount}. ${again}`;
}

const EXPLORERS: Record<string, { url: string; hash: RegExp }> = {
  eth: { url: 'https://etherscan.io/tx/', hash: /^0x[0-9a-fA-F]{64}$/ },
  base: { url: 'https://basescan.org/tx/', hash: /^0x[0-9a-fA-F]{64}$/ },
  arb: { url: 'https://arbiscan.io/tx/', hash: /^0x[0-9a-fA-F]{64}$/ },
  sol: { url: 'https://solscan.io/tx/', hash: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/ },
};
/** The origin chain explorer page of a transaction the wallet returned; null for anything not shaped like its hash. */
export function explorerTxUrl(chain: string, hash: string): string | null {
  const e = EXPLORERS[chain];
  return e && e.hash.test(hash) ? `${e.url}${hash}` : null;
}

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
