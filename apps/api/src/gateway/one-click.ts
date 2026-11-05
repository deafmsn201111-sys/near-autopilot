import { z } from 'zod';
import { MarketHttpError, type HttpJsonClient } from '../market-data/http';

/**
 * NEAR Intents 1Click API, DRY QUOTES ONLY. `dry: true` is a constant of this client, not a parameter: a dry quote
 * returns no deposit address, so nothing can be sent anywhere and no swap can start. A response that carries a deposit
 * address anyway is refused (and the address is never read). No JWT is sent: without one 1Click adds its own app fee,
 * which is part of `amountOut` and reported as `appFeeBps`.
 */
export interface OneClickDryQuoteRequest {
  /** NEP-141 token account ids on NEAR (sent as `nep141:<id>`). */
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly slippageBps: number;
  /** NEAR account the quote is FOR (recipient and refund address of a real swap; nothing is sent to it). */
  readonly account: string;
  readonly now: Date;
}

export interface OneClickDryQuote {
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
  readonly amountOutUsd: string;
  readonly timeEstimateSeconds: number;
  readonly appFeeBps: number;
  readonly correlationId: string;
  readonly signature: string;
  readonly quotedAt: Date;
}

const u128 = z.string().regex(/^\d{1,40}$/);
const response = z.object({
  correlationId: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  signature: z.string(),
  quoteRequest: z
    .object({
      dry: z.literal(true),
      appFees: z.array(z.object({ fee: z.number().int().min(0).max(10_000) })).optional(),
    })
    .passthrough(),
  quote: z
    .object({
      amountIn: u128,
      amountOut: u128,
      minAmountOut: u128,
      amountOutUsd: z.string(),
      timeEstimate: z.number(),
      depositAddress: z.undefined({
        invalid_type_error: 'a dry quote must not carry a deposit address',
      }),
    })
    .passthrough(),
});

export class OneClickClient {
  constructor(
    private readonly o: {
      readonly http: HttpJsonClient;
      /** e.g. https://1click.chaindefuser.com */
      readonly baseUrl: string;
    },
  ) {}

  async dryQuote(r: OneClickDryQuoteRequest): Promise<OneClickDryQuote> {
    const body = {
      dry: true as const,
      swapType: 'EXACT_INPUT',
      slippageTolerance: r.slippageBps,
      originAsset: `nep141:${r.tokenIn}`,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: `nep141:${r.tokenOut}`,
      amount: r.amountIn.toString(),
      refundTo: r.account,
      refundType: 'ORIGIN_CHAIN',
      recipient: r.account,
      recipientType: 'DESTINATION_CHAIN',
      // Required by the API; with dry=true no deposit address exists for it to apply to.
      deadline: new Date(r.now.getTime() + 10 * 60_000).toISOString(),
      // Wait up to 3 s for solvers to answer (0 often returns no quote at all).
      quoteWaitingTimeMs: 3_000,
    };
    const parsed = response.safeParse(
      await this.o.http.postJson(`${this.o.baseUrl}/v0/quote`, body),
    );
    if (!parsed.success)
      throw new MarketHttpError(
        'invalid_response',
        `unexpected 1Click quote: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim(),
        false,
      );
    const p = parsed.data;
    if (BigInt(p.quote.amountIn) !== r.amountIn)
      throw new MarketHttpError(
        'invalid_response',
        '1Click quoted a different input amount',
        false,
      );
    return {
      amountIn: BigInt(p.quote.amountIn),
      amountOut: BigInt(p.quote.amountOut),
      minAmountOut: BigInt(p.quote.minAmountOut),
      amountOutUsd: p.quote.amountOutUsd,
      timeEstimateSeconds: p.quote.timeEstimate,
      appFeeBps: (p.quoteRequest.appFees ?? []).reduce((s, f) => s + f.fee, 0),
      correlationId: p.correlationId,
      signature: p.signature,
      quotedAt: new Date(p.timestamp),
    };
  }
}
