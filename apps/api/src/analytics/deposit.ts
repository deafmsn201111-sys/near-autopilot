import { randomUUID } from 'node:crypto';
import { accountIdSchema, type ProvenanceTier } from '@near-autopilot/core';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DepositQuoteRefused,
  type OneClickDepositClient,
  type OneClickToken,
} from '../gateway/one-click-deposit';
import { DEPOSIT_CHAINS, isRefundAddress, type DepositChain } from '../gateway/refund-address';

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
  /** Deletes quotes older than 30 days. */
  purge(): Promise<void>;
}

export interface DepositDeps {
  readonly oneClick: Pick<OneClickDepositClient, 'tokens' | 'quote'>;
  readonly store: DepositQuoteStore;
  /** NEP-141 account ids the user may receive (config/market.json): our own list, never user input. */
  readonly destinationTokens: readonly string[];
  readonly newId?: () => string;
  /** The logo of a NEAR token id (every 1Click asset is a `nep141:` NEAR token). Absent: no logos. */
  readonly icon?: (token: string) => Promise<string | null>;
}

const CHAIN_NAMES: Record<DepositChain, string> = {
  eth: 'Ethereum',
  base: 'Base',
  arb: 'Arbitrum',
  sol: 'Solana',
  btc: 'Bitcoin',
};
const POPULAR = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC'];
const SLIPPAGE_BPS = 100;
const NOT_VERIFIED =
  'The 1Click quote could not be verified, so no deposit address is shown. Try again.';
const NO_QUOTE =
  '1Click has no quote for this amount right now. Try a larger amount or another token.';
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

export function registerDeposit(app: FastifyInstance, deps: DepositDeps, now: () => Date) {
  const newId = deps.newId ?? randomUUID;

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
    return {
      id,
      chain: origin.blockchain,
      chainName: CHAIN_NAMES[origin.blockchain],
      origin: asset(origin),
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
