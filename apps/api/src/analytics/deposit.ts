import { randomUUID } from 'node:crypto';
import { accountIdSchema, BoundedMap, type ProvenanceTier } from '@near-autopilot/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DepositQuoteRefused,
  type OneClickDepositClient,
  type OneClickToken,
  type SwapStatus,
} from '../gateway/one-click-deposit';
import { incidentsFor, type ShieldClient, type ShieldIncident } from '../gateway/shield';
import {
  DEPOSIT_CHAINS,
  isNearImplicitAccount,
  isRefundAddress,
  type DepositChain,
} from '../gateway/refund-address';
import type { SolanaTransferFees } from '../gateway/solana-transfer-fee';
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
  /** Marks the quote's wallet transfer as handed out; false when it already was, unless `retry`. Atomic. */
  issueTransfer(id: string, at: Date, retry: boolean): Promise<boolean>;
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
  /** Solana mints with a transfer fee arrive short of the quote and are refunded, so they are never offered. */
  readonly solanaFees?: Pick<SolanaTransferFees, 'unsafe'>;
}

const CHAIN_NAMES: Record<DepositChain, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  btc: 'Bitcoin',
};
const BRIDGE_NAMES: Record<string, string> = { poa: 'The PoA bridge', hot: 'The HOT bridge' };
const MAX_INCIDENTS = 5;
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
// A wallet prompt can stay open a while: a transfer must land well before 1Click's deadline.
export const SEND_MARGIN_MS = 2 * 60_000;
const ALREADY_SEEN = 'A deposit to this address was already seen. Do not send again.';
const ALREADY_ISSUED =
  'This transfer was already sent to a wallet, maybe from another tab. Check your wallet and do not send to this address again; if it shows nothing, get a new quote.';
const MANUAL_ONLY = 'Send this deposit manually: your wallet cannot be asked for it here.';
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

// The assetIds of Solana tokens whose mint takes a transfer fee or cannot be checked; native SOL has no mint.
async function solanaUnsafe(
  fees: Pick<SolanaTransferFees, 'unsafe'>,
  tokens: readonly OneClickToken[],
): Promise<Set<string>> {
  const spl = tokens.filter((t) => t.blockchain === 'sol' && t.assetId !== NATIVE_ASSETS.sol);
  const mints = spl.flatMap((t) => (t.contractAddress ? [t.contractAddress] : []));
  const charging = await fees.unsafe(mints);
  return new Set(
    spl.filter((t) => !t.contractAddress || charging.has(t.contractAddress)).map((t) => t.assetId),
  );
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

const withdrawBody = z
  .object({
    account: accountIdSchema,
    originAsset: z.string().min(1).max(200),
    destinationAsset: z.string().min(1).max(200),
    amount: z.string().min(1).max(64),
    recipient: z.string().min(1).max(200),
  })
  .strict();

/** Chains a withdrawal may go to: those HOT Kit connects (no Bitcoin, #171). */
const WITHDRAW_CHAINS: readonly DepositChain[] = ['eth', 'base', 'arb', 'sol'];

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

const seenBy1Click = (s: string | null) => s !== null && s !== 'PENDING_DEPOSIT';

/**
 * Why a stored quote may not be sent now, or null: within SEND_MARGIN_MS of its deadline, or a deposit 1Click has
 * seen, by the stored status and a fresh one (never cached), so a retry right after a send is refused once 1Click
 * sees it.
 */
async function sendRefusal(
  deps: Pick<DepositDeps, 'oneClick' | 'store'>,
  q: StoredDepositQuote & { readonly status: string | null },
  at: Date,
  log: (err: unknown) => void,
): Promise<{ readonly status: 409 | 502; readonly error: string } | null> {
  if (at.getTime() >= q.deadline.getTime() - SEND_MARGIN_MS)
    return { status: 409, error: 'This quote expires too soon to send. Get a new one.' };
  if (seenBy1Click(q.status)) return { status: 409, error: ALREADY_SEEN };
  try {
    const fresh = await deps.oneClick.status(q.depositAddress);
    await deps.store.saveStatus(q.id, fresh.status, at).catch(log);
    return seenBy1Click(fresh.status) ? { status: 409, error: ALREADY_SEEN } : null;
  } catch (err) {
    log(err);
    return { status: 502, error: STATUS_UNAVAILABLE };
  }
}

export function registerDeposit(app: FastifyInstance, deps: DepositDeps, now: () => Date) {
  const newId = deps.newId ?? randomUUID;
  const record = eventRecorder(deps.events, app.log);

  const lists = async () => {
    const tokens = await deps.oneClick.tokens();
    const unsafe = deps.solanaFees ? await solanaUnsafe(deps.solanaFees, tokens) : new Set();
    const origins = tokens
      .filter((t) => isDepositChain(t.blockchain) && !unsafe.has(t.assetId))
      .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
    const destinations = deps.destinationTokens.flatMap((id) => {
      const t = tokens.find((x) => x.blockchain === 'near' && x.contractAddress === id);
      return t ? [t] : [];
    });
    return { origins, destinations };
  };

  const transferQuery = z.object({ retry: z.literal('1').optional() }).catch({});

  const incidentQuery = z.object({
    origin: z.string().min(1).max(200),
    destination: z.string().min(1).max(200),
  });

  const ownCopy = (i: ShieldIncident, route: readonly OneClickToken[]) => {
    const what =
      i.scopeType === 'chain'
        ? i.scopeValue === 'near'
          ? 'NEAR'
          : (CHAIN_NAMES[i.scopeValue as DepositChain] ?? i.scopeValue)
        : i.scopeType === 'bridge'
          ? (BRIDGE_NAMES[i.scopeValue] ?? i.scopeValue)
          : (route.find((t) => t.assetId.toLowerCase() === i.scopeValue)?.symbol ?? i.scopeValue);
    return `${what} is affected, so your deposit may take longer than usual.`;
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
        (i) => i.text ?? ownCopy(i, [origin, destination]),
      );
      return {
        incidents: [...new Set(messages)].slice(0, MAX_INCIDENTS).map((message) => ({ message })),
      };
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

  // What the user's own wallet on the origin chain is asked to send: rebuilt from the stored quote, never the browser.
  app.get('/v1/deposit/transfer/:id', async (req, reply) => {
    const id = quoteId.safeParse((req.params as { id?: unknown }).id);
    if (!id.success) return reply.code(400).send({ error: 'Bad quote id.' });
    const at = now();
    let q;
    let origins;
    try {
      [q, { origins }] = await Promise.all([deps.store.find(id.data), lists()]);
    } catch (err) {
      req.log.warn({ err }, 'deposit transfer unavailable');
      return reply.code(502).send({ error: UNAVAILABLE });
    }
    if (!q) return reply.code(404).send({ error: 'Unknown deposit.' });
    const refused = await sendRefusal(deps, q, at, (err) =>
      req.log.warn({ err }, '1Click status failed before a wallet transfer'),
    );
    if (refused) return reply.code(refused.status).send({ error: refused.error });
    const origin = origins.find((t) => t.assetId === q.originAsset);
    const chain = origin?.blockchain ?? '';
    const payment =
      origin && isDepositChain(chain) && chain !== 'btc' ? paymentToken(chain, origin) : null;
    if (!origin || !payment || !isRefundAddress(chain as DepositChain, q.depositAddress))
      return reply.code(409).send({ error: MANUAL_ONLY });
    // Two tabs on one quote must not both prompt a wallet; only a send the wallet rejected may ask again.
    const retry = transferQuery.parse(req.query).retry === '1';
    try {
      if (!(await deps.store.issueTransfer(q.id, at, retry)))
        return reply.code(409).send({ error: ALREADY_ISSUED });
    } catch (err) {
      req.log.warn({ err }, 'deposit transfer not marked');
      return reply.code(502).send({ error: UNAVAILABLE });
    }
    return {
      quoteId: q.id,
      chain,
      receiver: q.depositAddress,
      amount: q.amountIn,
      token: {
        ...asset(origin),
        blockchain: chain,
        contractAddress: 'contract' in payment ? payment.contract : null,
      },
    };
  });

  type Leg = { readonly asset: OneClickToken; readonly chain: string; readonly chainName: string };

  /** A real 1Click quote, verified and stored before it is shown: the same path for a deposit and a withdrawal. */
  const mint = async (
    reply: FastifyReply,
    r: {
      readonly account: string;
      readonly from: Leg;
      readonly to: Leg;
      readonly amountIn: bigint;
      readonly refundTo: string;
      readonly recipient: string;
      readonly depositAddressOk: (address: string) => boolean;
    },
  ) => {
    const at = now();
    let q;
    try {
      q = await deps.oneClick.quote({
        originAsset: r.from.asset.assetId,
        destinationAsset: r.to.asset.assetId,
        amountIn: r.amountIn,
        refundTo: r.refundTo,
        recipient: r.recipient,
        slippageBps: SLIPPAGE_BPS,
        now: at,
      });
      if (!r.depositAddressOk(q.depositAddress))
        throw new DepositQuoteRefused('1Click deposit address is not of the origin chain');
    } catch (err) {
      reply.log.warn({ err }, '1Click quote refused');
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
        accountId: r.account,
        originAsset: r.from.asset.assetId,
        destinationAsset: r.to.asset.assetId,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
        minAmountOut: q.minAmountOut.toString(),
        refundTo: r.refundTo,
        depositAddress: q.depositAddress,
        deadline: q.deadline,
        correlationId: q.correlationId,
        signature: q.signature,
        feeBps,
      });
    } catch (err) {
      // Not shown unless stored; the correlation id lets 1Click find the quote that was minted.
      reply.log.error({ err, correlationId: q.correlationId }, 'deposit quote not stored');
      return reply.code(500).send({ error: 'internal error' });
    }
    await record({
      at,
      kind: 'oneclick_quote',
      accountId: r.account,
      source: 'server',
      detail: {
        quoteId: id,
        chain: r.from.chain,
        toChain: r.to.chain,
        from: r.from.asset.symbol,
        to: r.to.asset.symbol,
        recipient: r.recipient,
        amountIn: q.amountIn.toString(),
        amountOut: q.amountOut.toString(),
      },
    });
    return {
      id,
      chain: r.from.chain,
      chainName: r.from.chainName,
      to: { chain: r.to.chain, chainName: r.to.chainName },
      origin: {
        ...asset(r.from.asset),
        payment: isDepositChain(r.from.chain) ? paymentToken(r.from.chain, r.from.asset) : null,
      },
      destination: asset(r.to.asset),
      amountIn: q.amountIn.toString(),
      amountOut: q.amountOut.toString(),
      minAmountOut: q.minAmountOut.toString(),
      amountOutUsd: {
        value: q.amountOutUsd,
        provenance: 'protocol_reported' satisfies ProvenanceTier,
      },
      // As 1Click echoes it in the quote; it already comes off amountOut.
      fee: { bps: feeBps, provenance: 'protocol_reported' satisfies ProvenanceTier },
      recipient: r.recipient,
      refundTo: r.refundTo,
      depositAddress: q.depositAddress,
      deadline: q.deadline.toISOString(),
      // Counted down from the server clock, so a wrong browser clock cannot show time that is not there.
      expiresInSeconds: Math.floor((q.deadline.getTime() - at.getTime()) / 1000),
      timeEstimateSeconds: q.timeEstimateSeconds,
    };
  };

  const NEAR_LEG = { chain: 'near', chainName: 'NEAR' } as const;
  const units = (amount: string, decimals: number) => {
    const u = toBaseUnits(amount, decimals);
    if (u === null)
      throw new BadRequest(
        `The amount must be a positive number with at most ${decimals} decimals.`,
      );
    return u;
  };

  app.post('/v1/deposit/quote', async (req, reply) => {
    const body = quoteBody.parse(req.body);
    let leg;
    try {
      const { origins, destinations } = await lists();
      const o = origins.find((t) => t.assetId === body.originAsset);
      const d = destinations.find((t) => t.assetId === body.destinationAsset);
      if (!o || !isDepositChain(o.blockchain)) throw new BadRequest('Unknown origin token.');
      if (!d) throw new BadRequest('Unknown token to receive.');
      const amountIn = units(body.amount, o.decimals);
      if (!isRefundAddress(o.blockchain, body.refundTo))
        throw new BadRequest(
          `The refund address is not a valid ${CHAIN_NAMES[o.blockchain]} address.`,
        );
      leg = { o, chain: o.blockchain, d, amountIn };
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
      req.log.warn({ err }, '1Click token list failed');
      return reply.code(502).send({ error: UNAVAILABLE });
    }
    const { o, chain, d, amountIn } = leg;
    return mint(reply, {
      account: body.account,
      from: { asset: o, chain, chainName: CHAIN_NAMES[chain] },
      to: { asset: d, ...NEAR_LEG },
      amountIn,
      refundTo: body.refundTo,
      recipient: body.account,
      depositAddressOk: (a) => isRefundAddress(chain, a),
    });
  });

  // Withdraw (#171): the user's NEAR token to another chain. The NEAR transfer is built by /v1/wallet/prepare
  // (withdraw_1click) from the stored quote; a refund comes back to the NEAR account.
  app.post('/v1/withdraw/quote', async (req, reply) => {
    const body = withdrawBody.parse(req.body);
    let leg;
    try {
      const { origins, destinations } = await lists();
      const o = destinations.find((t) => t.assetId === body.originAsset);
      const d = origins.find((t) => t.assetId === body.destinationAsset);
      if (!o) throw new BadRequest('Unknown token to send.');
      const chain = d?.blockchain as DepositChain | undefined;
      if (!d || !chain || !WITHDRAW_CHAINS.includes(chain))
        throw new BadRequest('Unknown token to receive.');
      const amountIn = units(body.amount, o.decimals);
      if (!isRefundAddress(chain, body.recipient))
        throw new BadRequest(`The recipient is not a valid ${CHAIN_NAMES[chain]} address.`);
      leg = { o, d, chain, amountIn };
    } catch (err) {
      if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
      req.log.warn({ err }, '1Click token list failed');
      return reply.code(502).send({ error: UNAVAILABLE });
    }
    const { o, d, chain, amountIn } = leg;
    return mint(reply, {
      account: body.account,
      from: { asset: o, ...NEAR_LEG },
      to: { asset: d, chain, chainName: CHAIN_NAMES[chain] },
      amountIn,
      refundTo: body.account,
      recipient: body.recipient,
      depositAddressOk: isNearImplicitAccount,
    });
  });
}

/** What the NEAR wallet sends for a stored withdrawal quote, all from our row. */
export interface WithdrawTransfer {
  readonly quoteId: string;
  /** The NEP-141 contract: one of our own tokens (`destinationTokens`). */
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /** The quote's deposit address, a NEAR implicit account. */
  readonly receiver: string;
  readonly amount: bigint;
  /**
   * Marks the quote's transfer as handed out (#214), once all checks passed: false when it already was. One EXACT_INPUT
   * quote built twice could be paid twice before 1Click sees the first transfer.
   */
  readonly claim: () => Promise<boolean>;
}
export type WithdrawLookup = (
  quoteId: string,
  account: string,
) => Promise<WithdrawTransfer | { readonly status: 404 | 409 | 502; readonly error: string }>;

/**
 * The withdrawal a NEAR transfer may be built for: a stored quote of this account, from one of our tokens to a NEAR
 * implicit deposit address and sendable now (`sendRefusal`); the caller claims it once its own checks pass.
 */
export function withdrawLookup(deps: DepositDeps, now: () => Date): WithdrawLookup {
  return async (quoteId, account) => {
    const at = now();
    let q;
    let tokens;
    try {
      [q, tokens] = await Promise.all([deps.store.find(quoteId), deps.oneClick.tokens()]);
    } catch {
      return { status: 502, error: UNAVAILABLE };
    }
    if (!q || q.accountId !== account) return { status: 404, error: 'Unknown withdrawal.' };
    const token = q.originAsset.startsWith(NEP141) ? q.originAsset.slice(NEP141.length) : '';
    const listed = tokens.find((t) => t.blockchain === 'near' && t.assetId === q.originAsset);
    if (
      !listed ||
      !deps.destinationTokens.includes(token) ||
      !isNearImplicitAccount(q.depositAddress)
    )
      return { status: 409, error: 'This quote is not a withdrawal from NEAR.' };
    const refused = await sendRefusal(deps, q, at, () => undefined);
    if (refused) return refused;
    return {
      quoteId: q.id,
      token,
      symbol: listed.symbol,
      decimals: listed.decimals,
      receiver: q.depositAddress,
      amount: BigInt(q.amountIn),
      claim: () => deps.store.issueTransfer(q.id, now(), false),
    };
  };
}
