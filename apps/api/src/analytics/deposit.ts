import { randomUUID } from 'node:crypto';
import { accountIdSchema, BoundedMap, type ProvenanceTier } from '@near-autopilot/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DepositQuoteRefused,
  type OneClickDepositClient,
  type OneClickToken,
  type SwapStatus,
} from '../gateway/one-click-deposit';
import { incidentsFor, type ShieldClient, type ShieldIncident } from '../gateway/shield';
import { DEPOSIT_CHAINS, isRefundAddress, type DepositChain } from '../gateway/refund-address';
import { eventRecorder, type EventStore } from './events';

/**
 * Fund the account from another chain through 1Click (D19): the user gets a verified deposit address on the origin
 * chain and sends to it from their own wallet there. No NEAR transaction is built, so nothing reaches validateCascade.
 */
export interface StoredDepositQuote {
  readonly id: string;
  readonly createdAt: Date;
  readonly accountId: string;
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly refundTo: string;
  readonly depositAddress: string;
  readonly deadline: Date;
  readonly correlationId: string;
  readonly signature: string;
  readonly feeBps: number | null;
}

export interface DepositQuoteStore {
  save(q: StoredDepositQuote): Promise<void>;
  find(id: string): Promise<(StoredDepositQuote & { readonly status: string | null }) | null>;
  /** The latest 1Click status and when we last checked it. */
  saveStatus(id: string, status: SwapStatus, at: Date): Promise<void>;
  /** Quotes with no final status, except unpaid ones whose deadline is before `since`. */
  unfinished(since: Date): Promise<UnfinishedQuote[]>;
  /** Deletes quotes older than 30 days. */
  purge(): Promise<void>;
}

export interface UnfinishedQuote {
  readonly id: string;
  readonly createdAt: Date;
  readonly statusAt: Date | null;
}

export interface DepositDeps {
  readonly oneClick: Pick<OneClickDepositClient, 'tokens' | 'quote' | 'status'>;
  readonly store: DepositQuoteStore;
  readonly events?: EventStore;
  /** NEP-141 account ids the user may receive (config/market.json): our own list, never user input. */
  readonly destinationTokens: readonly string[];
  readonly newId?: () => string;
  readonly icon?: (token: string) => Promise<string | null>;
  /** Re-check unfinished quotes in the background this often, so a closed deposit screen does not freeze a status. */
  readonly refreshEveryMs?: number;
  /** 1Click SHIELD incidents, shown as a warning. Absent (no SHIELD_JWT): never an incident. */
  readonly shield?: Pick<ShieldClient, 'incidents'>;
}

const CHAIN_NAMES: Record<DepositChain, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  btc: 'Bitcoin',
};
const BRIDGE_NAMES: Record<string, string> = { poa: 'the PoA bridge', hot: 'the HOT bridge' };
const POPULAR = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];
const SLIPPAGE_BPS = 100;
const NOT_VERIFIED =
  'The 1Click quote could not be verified, so no deposit address is shown. Try again.';
const NO_QUOTE =
  '1Click has no quote for this amount right now. Try a larger amount or another token.';
const STATUS_UNAVAILABLE =
  'The 1Click status is unavailable right now. It is checked again shortly.';
// Many tabs on one quote cost one 1Click call per this long; the map holds at most this many quotes.
export const STATUS_CACHE_MS = 5_000;
export const STATUS_CACHE_SIZE = 1_000;
// A deposit sent just before the deadline can take a confirmation to show up: an unpaid quote expires this much later.
export const EXPIRY_GRACE_MS = 30 * 60_000;
export const REFRESH_CAP = 20;
const MIN_RECHECK_MS = 60_000;
const MAX_RECHECK_MS = 10 * 60_000;
const UNAVAILABLE = 'Deposits from other chains are unavailable right now. Try again later.';

/** "1.5" with 6 decimals -> 1500000n. Null unless a positive plain decimal with at most `decimals` places. */
export function toBaseUnits(amount: string, decimals: number): bigint | null {
  const m = /^(\d{1,30})(?:\.(\d+))?$/.exec(amount);
  if (!m) return null;
  const [, whole = '', frac = ''] = m;
  if (frac.length > decimals) return null;
  const units = BigInt(whole + frac.padEnd(decimals, '0'));
  return units > 0n ? units : null;
}

/** A quote is re-checked every fifth of its age, between 1 and 10 minutes; the longest unchecked go first. */
export function dueQuotes(rows: readonly UnfinishedQuote[], at: Date): string[] {
  const t = at.getTime();
  const lastChecked = (r: UnfinishedQuote) => r.statusAt?.getTime() ?? -Infinity;
  const recheckMs = (r: UnfinishedQuote) =>
    Math.min(MAX_RECHECK_MS, Math.max(MIN_RECHECK_MS, (t - r.createdAt.getTime()) / 5));
  return (
    rows
      // A check is stored a moment after its run started, so the next run would see it as just under a minute old.
      .filter((r) => t - lastChecked(r) >= recheckMs(r) - STATUS_CACHE_MS)
      .sort((a, b) => lastChecked(a) - lastChecked(b))
      .slice(0, REFRESH_CAP)
      .map((r) => r.id)
  );
}

const isDepositChain = (c: string): c is DepositChain =>
  (DEPOSIT_CHAINS as readonly string[]).includes(c);
const rank = (symbol: string) => {
  const i = POPULAR.indexOf(symbol);
  return i === -1 ? POPULAR.length : i;
};
const NEP141 = 'nep141:';
const asset = (t: OneClickToken) => ({
  assetId: t.assetId,
  symbol: t.symbol,
  decimals: t.decimals,
});

// The chain's own coin as 1Click lists it: no contract and exactly this asset id. Anything else is not native.
const NATIVE_ASSETS: Record<DepositChain, string> = {
  eth: 'nep141:eth.omft.near',
  base: 'nep141:base.omft.near',
  arb: 'nep141:arb.omft.near',
  sol: 'nep141:sol.omft.near',
  btc: 'nep141:btc.omft.near',
};

export type PaymentToken = { readonly native: true } | { readonly contract: string } | null;

/**
 * What a payment link (EIP-681, Solana Pay, BIP21) may ask the wallet to send, or null: then the QR holds the
 * address only. On EVM chains the quoted assetId names the contract, so a contract it does not name is refused;
 * Solana assetIds are hashes, so there the mint is the one 1Click lists for the asset.
 */
export function paymentToken(chain: DepositChain, t: OneClickToken): PaymentToken {
  const c = t.contractAddress;
  if (!c) return t.assetId === NATIVE_ASSETS[chain] ? { native: true } : null;
  if (chain === 'btc' || !isRefundAddress(chain, c)) return null;
  if (chain !== 'sol' && !t.assetId.toLowerCase().includes(c.toLowerCase())) return null;
  return { contract: c };
}

const quoteBody = z
  .object({
    account: accountIdSchema,
    originAsset: z.string().min(1).max(200),
    destinationAsset: z.string().min(1).max(200),
    amount: z.string().min(1).max(64),
    refundTo: z.string().min(1).max(200),
  })
  .strict();

class BadRequest extends Error {}
class NotFound extends Error {}

export interface DepositStatusView {
  readonly status: SwapStatus;
  readonly depositedAmount: string | null;
  readonly amountOut: string | null;
  readonly refundedAmount: string | null;
  readonly refundReason: string | null;
  readonly nearTxHash: string | null;
  /** Deadline plus the grace, from the server clock, so a wrong browser clock cannot end the wait early. */
  readonly deadlinePassed: boolean;
}

const quoteId = z.string().regex(/^[\w-]{1,64}$/);

export function registerDeposit(app: FastifyInstance, deps: DepositDeps, now: () => Date) {
  const newId = deps.newId ?? randomUUID;
  const record = eventRecorder(deps.events, app.log);

  const lists = async () => {
    const tokens = await deps.oneClick.tokens();
    const origins = tokens
      .filter((t) => isDepositChain(t.blockchain))
      .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
    const destinations = deps.destinationTokens.flatMap((id) => {
      const t = tokens.find((x) => x.blockchain === 'near' && x.contractAddress === id);
      return t ? [t] : [];
    });
    return { origins, destinations };
  };

  const incidentQuery = z.object({
    origin: z.string().min(1).max(200),
    destination: z.string().min(1).max(200),
  });

  const ownCopy = (i: ShieldIncident, tokens: readonly OneClickToken[]) => {
    const what =
      i.scopeType === 'chain'
        ? i.scopeValue === 'near'
          ? 'NEAR'
          : isDepositChain(i.scopeValue)
            ? CHAIN_NAMES[i.scopeValue]
            : 'a network on this route'
        : i.scopeType === 'bridge'
          ? (BRIDGE_NAMES[i.scopeValue] ?? 'a bridge on this route')
          : (tokens.find((t) => t.assetId === i.scopeValue)?.symbol ?? 'a token on this route');
    return `1Click reports a problem with ${what}. Your deposit may take longer than usual.`;
  };

  // Display only: anything that goes wrong here means no warning, never a broken dialog.
  app.get('/v1/deposit/incidents', async (req) => {
    const q = incidentQuery.safeParse(req.query);
    if (!deps.shield || !q.success) return { incidents: [] };
    try {
      const [incidents, tokens] = await Promise.all([
        deps.shield.incidents(),
        deps.oneClick.tokens(),
      ]);
      const origin = tokens.find((t) => t.assetId === q.data.origin);
      const destination = tokens.find((t) => t.assetId === q.data.destination);
      if (!origin || !destination) return { incidents: [] };
      const messages = incidentsFor(incidents, { origin, destination }).map(
        (i) => i.text ?? ownCopy(i, tokens),
      );
      return { incidents: [...new Set(messages)].map((message) => ({ message })) };
    } catch (err) {
      req.log.warn({ err }, 'deposit incidents unavailable');
      return { incidents: [] };
    }
  });

  app.get('/v1/deposit/assets', async (req, reply) => {
    try {
      const { origins, destinations } = await lists();
      const icon = async (t: OneClickToken) =>
        deps.icon && t.assetId.startsWith(NEP141)
          ? deps.icon(t.assetId.slice(NEP141.length))
          : null;
      return {
        origins: await Promise.all(
          origins.map(async (t) => ({
            ...asset(t),
            icon: await icon(t),
            chain: t.blockchain,
            chainName: CHAIN_NAMES[t.blockchain as DepositChain],
          })),
        ),
        destinations: await Promise.all(
          destinations.map(async (t) => ({ ...asset(t), icon: await icon(t) })),
        ),
      };
    } catch (err) {
      req.log.warn({ err }, '1Click token list failed');
      return reply.code(502).send({ error: UNAVAILABLE });
    }
  });

  const statuses = new BoundedMap<string, { at: number; view: Promise<DepositStatusView> }>(
    STATUS_CACHE_SIZE,
  );

  const fetchStatus = async (id: string, at: Date): Promise<DepositStatusView> => {
    const q = await deps.store.find(id);
    if (!q) throw new NotFound();
    const r = await deps.oneClick.status(q.depositAddress);
    // Best effort: a failed write must not hide a status 1Click did answer.
    await deps.store
      .saveStatus(id, r.status, at)
      .catch((err: unknown) => app.log.warn({ err }, 'deposit status not stored'));
    const units = (v: bigint | null) => (v === null ? null : v.toString());
    return {
      status: r.status,
      depositedAmount: units(r.depositedAmount),
      amountOut: units(r.amountOut),
      refundedAmount: units(r.refundedAmount),
      refundReason: r.refundReason,
      nearTxHash: r.nearTxHash,
      deadlinePassed: at.getTime() >= q.deadline.getTime() + EXPIRY_GRACE_MS,
    };
  };

  const cachedStatus = (id: string, at: Date): Promise<DepositStatusView> => {
    const cached = statuses.get(id);
    if (cached && at.getTime() - cached.at < STATUS_CACHE_MS) return cached.view;
    const entry = { at: at.getTime(), view: fetchStatus(id, at) };
    statuses.set(id, entry);
    entry.view.catch(() => {
      if (statuses.get(id) === entry) statuses.delete(id);
    });
    return entry.view;
  };

  if (deps.refreshEveryMs) {
    // A failed check stores no statusAt, so its time is kept here to back off like a stored one.
    const failedAt = new BoundedMap<string, Date>(STATUS_CACHE_SIZE);
    const refresh = async () => {
      const at = now();
      const rows = (await deps.store.unfinished(new Date(at.getTime() - EXPIRY_GRACE_MS))).map(
        (r) => {
          const failed = failedAt.get(r.id);
          return failed && (!r.statusAt || failed > r.statusAt) ? { ...r, statusAt: failed } : r;
        },
      );
      for (const id of dueQuotes(rows, at)) {
        const checkedAt = now();
        await cachedStatus(id, checkedAt).catch((err: unknown) => {
          failedAt.set(id, checkedAt);
          app.log.warn({ err, id }, 'deposit status refresh failed');
        });
      }
    };
    let running: Promise<void> | null = null;
    let timer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      timer = setInterval(() => {
        running ??= refresh()
          .catch((err: unknown) => app.log.warn({ err }, 'deposit status refresh skipped'))
          .finally(() => (running = null));
      }, deps.refreshEveryMs);
      timer.unref();
    });
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await running;
    });
  }

  app.get('/v1/deposit/status/:id', async (req, reply) => {
    const id = quoteId.safeParse((req.params as { id?: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: 'Bad quote id.' });
    try {
      return await cachedStatus(id.data, now());
    } catch (err) {
      if (err instanceof NotFound) return reply.code(404).send({ error: 'Unknown deposit.' });
      req.log.warn({ err }, '1Click status failed');
      return reply.code(502).send({ error: STATUS_UNAVAILABLE });
    }
  });

  app.post('/v1/deposit/quote', async (req, reply) => {
    const body = quoteBody.parse(req.body);
    let origin: OneClickToken & { blockchain: DepositChain };
    let destination: OneClickToken;
    let amountIn: bigint;
    try {
      const { origins, destinations } = await lists();
      const o = origins.find((t) => t.assetId === body.originAsset);
      const d = destinations.find((t) => t.assetId === body.destinationAsset);
      if (!o || !isDepositChain(o.blockchain)) throw new BadRequest('Unknown origin token.');
      if (!d) throw new BadRequest('Unknown token to receive.');
      const units = toBaseUnits(body.amount, o.decimals);
      if (units === null)
        throw new BadRequest(
          `The amount must be a positive number with at most ${o.decimals} decimals.`,
        );
      if (!isRefundAddress(o.blockchain, body.refundTo))
        throw new BadRequest(
          `The refund address is not a valid ${CHAIN_NAMES[o.blockchain]} address.`,
        );
      origin = { ...o, blockchain: o.blockchain };
      destination = d;
      amountIn = units;
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
      req.log.warn({ err }, '1Click token list failed');
      return reply.code(502).send({ error: UNAVAILABLE });
    }

    const at = now();
    let q;
    try {
      q = await deps.oneClick.quote({
        originAsset: origin.assetId,
        destinationAsset: destination.assetId,
        amountIn,
        refundTo: body.refundTo,
        recipient: body.account,
        slippageBps: SLIPPAGE_BPS,
        now: at,
      });
      if (!isRefundAddress(origin.blockchain, q.depositAddress))
        throw new DepositQuoteRefused('1Click deposit address is not of the origin chain');
    } catch (err) {
      req.log.warn({ err }, '1Click deposit quote refused');
      return reply
        .code(502)
        .send({ error: err instanceof DepositQuoteRefused ? NOT_VERIFIED : NO_QUOTE });
    }

    const feeBps = q.appFeeBps;
    const id = newId();
    try {
      await deps.store.save({
        id,
        createdAt: at,
        accountId: body.account,
        originAsset: origin.assetId,
        destinationAsset: destination.assetId,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        minAmountOut: q.minAmountOut.toString(),
        refundTo: body.refundTo,
        depositAddress: q.depositAddress,
        deadline: q.deadline,
        correlationId: q.correlationId,
        signature: q.signature,
        feeBps,
      });
    } catch (err) {
      // Not shown unless stored; the correlation id lets 1Click find the quote that was minted.
      req.log.error({ err, correlationId: q.correlationId }, 'deposit quote not stored');
      return reply.code(500).send({ error: 'internal error' });
    }
    await record({
      at,
      kind: 'oneclick_quote',
      accountId: body.account,
      source: 'server',
      detail: {
        quoteId: id,
        chain: origin.blockchain,
        from: origin.symbol,
        to: destination.symbol,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
      },
    });
    return {
      id,
      chain: origin.blockchain,
      chainName: CHAIN_NAMES[origin.blockchain],
      origin: { ...asset(origin), payment: paymentToken(origin.blockchain, origin) },
      destination: asset(destination),
      amountIn: q.amountIn.toString(),
      amountOut: q.amountOut.toString(),
      minAmountOut: q.minAmountOut.toString(),
      amountOutUsd: {
        value: q.amountOutUsd,
        provenance: 'protocol_reported' satisfies ProvenanceTier,
      },
      // As 1Click echoes it in the quote; it already comes off amountOut.
      fee: { bps: feeBps, provenance: 'protocol_reported' satisfies ProvenanceTier },
      recipient: body.account,
      refundTo: body.refundTo,
      depositAddress: q.depositAddress,
      deadline: q.deadline.toISOString(),
      // Counted down from the server clock, so a wrong browser clock cannot show time that is not there.
      expiresInSeconds: Math.floor((q.deadline.getTime() - at.getTime()) / 1000),
      timeEstimateSeconds: q.timeEstimateSeconds,
    };
  });
}
