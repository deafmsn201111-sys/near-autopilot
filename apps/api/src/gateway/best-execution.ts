import type { TokenId, UnitPrice } from '@near-autopilot/core';
import { oracleDeviationBps, valueUsd } from '@near-autopilot/financial-engine';

/**
 * BEST EXECUTION across venues, pure and deterministic. Each venue's quote already includes its own fee (the Rhea pool
 * fee inside `get_return`, the 1Click app fee inside `amountOut`); the comparison subtracts the NEAR gas the user would
 * attach (an UPPER bound: attached gas x gas price, refunds not counted) and ranks by net USD value received.
 *
 * A quote is excluded, never patched, when it failed, is older than the policy's price-age limit, or pays more than the
 * policy's oracle-deviation limit below the oracle-implied output (a manipulated or illiquid route). Without prices for
 * the input, the output and NEAR nothing can be valued and NO venue is chosen.
 */
export type VenueId = 'rhea' | 'near-intents-1click';

export const VENUE_LABEL: Readonly<Record<VenueId, string>> = {
  rhea: 'Rhea (Ref v2) on-chain pool',
  'near-intents-1click': 'NEAR Intents 1Click (dry quote)',
};

export interface VenueQuoteOk {
  readonly venue: VenueId;
  readonly ok: true;
  readonly quotedAt: Date;
  readonly amountOut: bigint;
  /** The venue's own minimum after slippage, when it states one. */
  readonly minAmountOut: bigint | null;
  /** Venue fee already deducted from `amountOut`, bps, when known. */
  readonly feeBps: number | null;
  /** Gas the user would attach to start the trade (yoctoNEAR). An upper bound. */
  readonly gasUpperBoundYocto: bigint;
  /** atomic: one transaction, all-or-nothing on chain. async: deposit, then a solver settles (or refunds). */
  readonly settlement: 'atomic' | 'async';
  /** Venue reference: pool id, or the 1Click correlation id. */
  readonly ref: string;
  readonly detail: string | null;
}

export interface VenueQuoteFailed {
  readonly venue: VenueId;
  readonly ok: false;
  readonly quotedAt: Date;
  readonly reason: string;
}

export type VenueQuote = VenueQuoteOk | VenueQuoteFailed;

export interface RouteRequest {
  readonly tokenIn: TokenId;
  readonly tokenOut: TokenId;
  readonly amountIn: bigint;
}

export interface RouteLimits {
  /** policy.maxPriceAgeSeconds */
  readonly maxQuoteAgeSeconds: number;
  /** policy.maxOracleDeviationBps */
  readonly maxOracleDeviationBps: number;
}

export interface RoutePrices {
  readonly in: UnitPrice | null;
  readonly out: UnitPrice | null;
  readonly near: UnitPrice | null;
}

export interface ScoredQuote {
  readonly quote: VenueQuote;
  readonly outUsdMicro: bigint | null;
  readonly gasUsdMicro: bigint | null;
  readonly netUsdMicro: bigint | null;
  readonly oracleDeviationBps: number | null;
  /** null when eligible. */
  readonly excluded: string | null;
}

export interface RouteDecision {
  readonly chosen: VenueId | null;
  readonly reason: string;
  readonly scored: readonly ScoredQuote[];
  /** Net advantage of the chosen venue over the next eligible one, bps of the runner-up's net (rounded down). */
  readonly advantageBps: number | null;
}

const ORDER: readonly VenueId[] = ['rhea', 'near-intents-1click'];

export function chooseRoute(
  request: RouteRequest,
  quotes: readonly VenueQuote[],
  prices: RoutePrices,
  limits: RouteLimits,
  now: Date,
): RouteDecision {
  const priced = prices.in !== null && prices.out !== null && prices.near !== null;
  const scored: ScoredQuote[] = quotes.map((q) => {
    if (!q.ok)
      return {
        quote: q,
        outUsdMicro: null,
        gasUsdMicro: null,
        netUsdMicro: null,
        oracleDeviationBps: null,
        excluded: q.reason,
      };
    const ageMs = now.getTime() - q.quotedAt.getTime();
    const outUsd = prices.out ? valueUsd(q.amountOut, prices.out) : null;
    const gasUsd = prices.near ? valueUsd(q.gasUpperBoundYocto, prices.near) : null;
    const deviation =
      prices.in && prices.out && valueUsd(request.amountIn, prices.in) > 0n
        ? oracleDeviationBps({
            amountIn: request.amountIn,
            priceIn: prices.in,
            amountOut: q.amountOut,
            priceOut: prices.out,
          })
        : null;
    const excluded =
      q.amountOut <= 0n
        ? 'quoted output is zero'
        : ageMs > limits.maxQuoteAgeSeconds * 1000
          ? `quote is ${Math.round(ageMs / 1000)}s old (limit ${limits.maxQuoteAgeSeconds}s)`
          : !priced
            ? 'input, output or NEAR price unavailable: cannot value the route'
            : deviation !== null && deviation > limits.maxOracleDeviationBps
              ? `pays ${deviation} bps below the oracle (limit ${limits.maxOracleDeviationBps} bps)`
              : null;
    return {
      quote: q,
      outUsdMicro: outUsd,
      gasUsdMicro: gasUsd,
      netUsdMicro: outUsd !== null && gasUsd !== null ? outUsd - gasUsd : null,
      oracleDeviationBps: deviation,
      excluded,
    };
  });

  const eligible = scored
    .filter((s): s is ScoredQuote & { quote: VenueQuoteOk; netUsdMicro: bigint } => {
      return s.excluded === null && s.quote.ok && s.netUsdMicro !== null;
    })
    .sort((a, b) =>
      a.netUsdMicro !== b.netUsdMicro
        ? a.netUsdMicro > b.netUsdMicro
          ? -1
          : 1
        : // A tie goes to the atomic venue (no deposit-then-settle risk), then to the fixed venue order.
          a.quote.settlement !== b.quote.settlement
          ? a.quote.settlement === 'atomic'
            ? -1
            : 1
          : ORDER.indexOf(a.quote.venue) - ORDER.indexOf(b.quote.venue),
    );
  const [best, second] = eligible;
  if (!best)
    return {
      chosen: null,
      reason:
        scored.length === 0
          ? 'no venue quoted this pair'
          : `no eligible venue: ${scored.map((s) => `${s.quote.venue}: ${s.excluded ?? 'not valued'}`).join('; ')}`,
      scored,
      advantageBps: null,
    };
  const advantageBps =
    second && second.netUsdMicro > 0n
      ? Number(((best.netUsdMicro - second.netUsdMicro) * 10_000n) / second.netUsdMicro)
      : null;
  return {
    chosen: best.quote.venue,
    reason: second
      ? `${best.quote.venue} nets ${advantageBps ?? 0} bps more than ${second.quote.venue} after fees and gas`
      : `${best.quote.venue} is the only eligible venue`,
    scored,
    advantageBps,
  };
}
