import { z } from 'zod';
import type { HttpJsonClient } from '../market-data/http';

/**
 * NEAR Intents 1Click API, REAL quotes for an inbound deposit (`dry: false`). Separate from the dry-quote client in
 * `one-click.ts` on purpose: a real quote returns a deposit address that receives real money, so the base URL is a
 * constant (never ONE_CLICK_URL), and every field the user will rely on is checked against what we asked for.
 * Nothing here builds or signs a NEAR transaction; the user sends the deposit from their own wallet on the origin chain.
 */
export const ONE_CLICK_BASE_URL = 'https://1click.chaindefuser.com';
const TOKENS_TTL_MS = 10 * 60_000;

/** A quote that failed verification or parsing. The message is ours (no upstream text, no JWT); it goes to the log. */
export class DepositQuoteRefused extends Error {
  override name = 'DepositQuoteRefused';
}

export interface OneClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly contractAddress?: string | undefined;
}

export interface DepositQuoteRequest {
  /** `assetId`s exactly as `/v0/tokens` lists them. */
  readonly originAsset: string;
  readonly destinationAsset: string;
  readonly amountIn: bigint;
  /** The user's own address on the origin chain, format-checked before this call. */
  readonly refundTo: string;
  /** The connected NEAR account. */
  readonly recipient: string;
  readonly slippageBps: number;
  readonly now: Date;
}

export interface DepositQuote {
  readonly depositAddress: string;
  readonly deadline: Date;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  /** 1Click's own USD estimate: display only, never used in logic. */
  readonly amountOutUsd: string;
  readonly timeEstimateSeconds: number;
  readonly correlationId: string;
  readonly signature: string;
}

const u128 = z.string().regex(/^\d{1,40}$/);
const token = z.object({
  assetId: z.string().min(1).max(200),
  decimals: z.number().int().min(0).max(36),
  blockchain: z.string().min(1).max(20),
  symbol: z.string().min(1).max(20),
  contractAddress: z.string().max(200).optional(),
});
const quoteResponse = z.object({
  correlationId: z.string().min(1).max(100),
  signature: z.string().min(1).max(500),
  quoteRequest: z
    .object({
      dry: z.literal(false),
      swapType: z.literal('EXACT_INPUT'),
      depositType: z.literal('ORIGIN_CHAIN'),
      refundType: z.literal('ORIGIN_CHAIN'),
      recipientType: z.literal('DESTINATION_CHAIN'),
      originAsset: z.string(),
      destinationAsset: z.string(),
      amount: u128,
      refundTo: z.string(),
      recipient: z.string(),
    })
    .passthrough(),
  quote: z
    .object({
      depositAddress: z.string().min(1).max(200),
      depositMemo: z.union([z.null(), z.literal('')]).optional(),
      amountIn: u128,
      amountOut: u128,
      minAmountOut: u128,
      amountOutUsd: z.string().max(40),
      deadline: z.string().datetime({ offset: true }),
      timeEstimate: z.number().nonnegative(),
    })
    .passthrough(),
});

type Http = Pick<HttpJsonClient, 'getJson' | 'postJson'>;

export class OneClickDepositClient {
  private cached: { at: number; tokens: OneClickToken[] } | null = null;

  constructor(
    private readonly o: {
      readonly http: Http;
      /** ONE_CLICK_JWT. Sent only to 1Click, as a bearer header; never logged, never returned. */
      readonly jwt?: string | undefined;
      readonly now?: () => number;
    },
  ) {}

  private headers(): Record<string, string> {
    return this.o.jwt ? { authorization: `Bearer ${this.o.jwt}` } : {};
  }

  /** `/v0/tokens`, malformed entries dropped, cached for 10 minutes. */
  async tokens(): Promise<OneClickToken[]> {
    const now = (this.o.now ?? Date.now)();
    if (this.cached && now - this.cached.at < TOKENS_TTL_MS) return this.cached.tokens;
    const raw = await this.o.http.getJson(`${ONE_CLICK_BASE_URL}/v0/tokens`, this.headers());
    if (!Array.isArray(raw)) throw new DepositQuoteRefused('1Click token list is not a list');
    const tokens = raw.flatMap((t) => {
      const p = token.safeParse(t);
      return p.success ? [p.data] : [];
    });
    this.cached = { at: now, tokens };
    return tokens;
  }

  async quote(r: DepositQuoteRequest): Promise<DepositQuote> {
    const body = {
      dry: false as const,
      swapType: 'EXACT_INPUT',
      slippageTolerance: r.slippageBps,
      originAsset: r.originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: r.destinationAsset,
      amount: r.amountIn.toString(),
      refundTo: r.refundTo,
      refundType: 'ORIGIN_CHAIN',
      recipient: r.recipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline: new Date(r.now.getTime() + 10 * 60_000).toISOString(),
      quoteWaitingTimeMs: 3_000,
    };
    const parsed = quoteResponse.safeParse(
      await this.o.http.postJson(`${ONE_CLICK_BASE_URL}/v0/quote`, body, this.headers()),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new DepositQuoteRefused(
        `unexpected 1Click quote at ${issue?.path.join('.') ?? '?'}: ${issue?.code ?? ''}`,
      );
    }
    const { quoteRequest: echo, quote: q, correlationId, signature } = parsed.data;
    const mismatch = [
      echo.originAsset !== r.originAsset && 'originAsset',
      echo.destinationAsset !== r.destinationAsset && 'destinationAsset',
      BigInt(echo.amount) !== r.amountIn && 'amount',
      BigInt(q.amountIn) !== r.amountIn && 'amountIn',
      echo.recipient !== r.recipient && 'recipient',
      echo.refundTo !== r.refundTo && 'refundTo',
    ].filter(Boolean);
    if (mismatch.length)
      throw new DepositQuoteRefused(`1Click quote differs: ${mismatch.join(', ')}`);
    const deadline = new Date(q.deadline);
    if (deadline.getTime() <= r.now.getTime())
      throw new DepositQuoteRefused('1Click quote deadline is not in the future');
    return {
      depositAddress: q.depositAddress,
      deadline,
      amountIn: BigInt(q.amountIn),
      amountOut: BigInt(q.amountOut),
      minAmountOut: BigInt(q.minAmountOut),
      amountOutUsd: q.amountOutUsd,
      timeEstimateSeconds: q.timeEstimate,
      correlationId,
      signature,
    };
  }
}
