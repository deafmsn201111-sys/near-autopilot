import type { AccountId } from '@near-autopilot/core';
import { buildRheaSwap } from '@near-autopilot/rhea-adapter';
import type { CascadeStep, TxDraft } from './cascade';
import { formatNear } from './cascade';

/**
 * Repay a Burrow debt with another collateral token (#69): withdraw it (only what the wallet lacks), swap it on Rhea,
 * repay with the swap's minimum output. Separate transactions signed in order; Burrow and Rhea each check their own
 * step. This is pure: the caller reads the chain, verifies the tokens, and supplies the quote and the vetted Burrow
 * builders. It clamps the card's amounts to the fresh balances, sizes the repay from the fresh quote, refuses a
 * withdrawal that would take the health factor under `floor`, and states the health factor after each step in the
 * preview. A wNEAR debt is refused: Rhea may pay a swap into wNEAR out as native NEAR, which the repay cannot send.
 */
export interface SwapRepayPrepareInput {
  readonly account: AccountId;
  readonly rheaId: string;
  /** From the card: collateral token to swap and to withdraw, base units. */
  readonly requested: { readonly swapInRaw: bigint; readonly withdrawRaw: bigint };
  readonly collateral: TokenSide & {
    /** Burrow plain supply (leaves first, no health factor effect) and collateral, base units. */
    readonly suppliedRaw: bigint;
    readonly collateralRaw: bigint;
  };
  readonly debt: TokenSide & { readonly debtRaw: bigint };
  /** The health factor's two sides from the same read: sum(collateral_usd x vr) and sum(debt_usd / vr). */
  readonly model: { readonly collateralAdjUsd: number; readonly debtAdjUsd: number };
  readonly slippageBps: number;
  readonly floor: number;
  readonly quote: (amountIn: bigint) => Promise<{ poolId: number; amountOut: bigint } | null>;
  readonly withdrawTx: (rawAmount: bigint, fromCollateralRaw: bigint) => TxDraft;
  readonly repayTx: (rawAmount: bigint) => TxDraft;
}

interface TokenSide {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly usdPerToken: number;
  readonly vr: number;
  readonly walletRaw: bigint;
  /** The token's `storage_balance_bounds().min` when the account must register first; null when registered. */
  readonly storageMin: bigint | null;
}

export type SwapRepayPrepared =
  | {
      readonly ok: true;
      readonly steps: CascadeStep[];
      readonly amounts: {
        readonly withdrawRaw: bigint;
        readonly swapInRaw: bigint;
        readonly estOutRaw: bigint;
        readonly minOutRaw: bigint;
        readonly repayRaw: bigint;
      };
      readonly hf: {
        readonly now: number | null;
        readonly afterWithdraw: number | null;
        readonly afterRepay: number | null;
      };
    }
  | { readonly ok: false; readonly error: string };

/** Rhea may unwrap a swap's wNEAR output to native NEAR; the repay step needs the fungible token. */
export const WRAP_NEAR = 'wrap.near';

const human = (raw: bigint, decimals: number) => {
  const scale = 10n ** BigInt(Math.max(0, decimals - 6));
  return Number(raw / scale) / 10 ** Math.min(6, decimals);
};
const text = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const hfText = (hf: number | null) => (hf === null ? 'no debt left' : hf.toFixed(2));

export async function prepareSwapRepay(i: SwapRepayPrepareInput): Promise<SwapRepayPrepared> {
  const { collateral: c, debt: d } = i;
  if (c.token === d.token)
    return { ok: false, error: 'the collateral to swap must be another token than the debt' };
  if (d.token === WRAP_NEAR)
    return {
      ok: false,
      error: 'repaying a wNEAR loan by swapping another collateral is not supported',
    };
  if (d.debtRaw <= 0n) return { ok: false, error: `you have no ${d.symbol} debt on Burrow` };
  const onBurrow = c.suppliedRaw + c.collateralRaw;
  const withdrawRaw = i.requested.withdrawRaw < onBurrow ? i.requested.withdrawRaw : onBurrow;
  const fromCollateralRaw = withdrawRaw > c.suppliedRaw ? withdrawRaw - c.suppliedRaw : 0n;
  const reachable = c.walletRaw + withdrawRaw;
  const swapInRaw = i.requested.swapInRaw < reachable ? i.requested.swapInRaw : reachable;
  if (swapInRaw <= 0n) return { ok: false, error: `you have no ${c.symbol} to swap` };

  const { collateralAdjUsd: C, debtAdjUsd: D } = i.model;
  const hfOf = (collateral: number, debt: number) =>
    debt > 1e-9 ? Math.max(0, collateral) / debt : null;
  const collateralAfter = C - human(fromCollateralRaw, c.decimals) * c.usdPerToken * c.vr;
  const hfNow = hfOf(C, D);
  const afterWithdraw = hfOf(collateralAfter, D);
  if (fromCollateralRaw > 0n && (afterWithdraw === null || afterWithdraw < i.floor))
    return {
      ok: false,
      error: `withdrawing ${text(human(withdrawRaw, c.decimals))} ${c.symbol} would take the health factor to ${hfText(afterWithdraw)}, under ${i.floor.toFixed(2)}`,
    };

  const quote = await i.quote(swapInRaw);
  if (!quote || quote.amountOut <= 0n)
    return { ok: false, error: `no route for ${c.symbol} -> ${d.symbol} in the allowlisted pools` };
  const minOutRaw = (quote.amountOut * BigInt(10_000 - i.slippageBps)) / 10_000n;
  // Repay stops at the debt; the 0.1% covers interest accrued since the read. Anything above stays as Burrow supply.
  const cap = d.debtRaw + d.debtRaw / 1000n;
  const available = minOutRaw + d.walletRaw;
  const repayRaw = available < cap ? available : cap;
  if (repayRaw <= 0n) return { ok: false, error: 'the resolved repay amount is zero' };
  const repaid = human(repayRaw < d.debtRaw ? repayRaw : d.debtRaw, d.decimals);
  const afterRepay = hfOf(collateralAfter, D - (repaid * d.usdPerToken) / d.vr);

  const register = (side: TokenSide, intentId: string): CascadeStep[] =>
    side.storageMin === null
      ? []
      : [
          {
            intentId,
            tx: {
              receiverId: side.token as AccountId,
              actions: [
                {
                  type: 'FunctionCall',
                  methodName: 'storage_deposit',
                  args: { account_id: i.account },
                  gas: 10_000_000_000_000n,
                  deposit: side.storageMin,
                },
              ],
            },
            preview: `register to receive ${side.symbol}: one-time, ${formatNear(side.storageMin)} NEAR, refundable. The health factor does not change.`,
          },
        ];
  const swapHuman = text(human(swapInRaw, c.decimals));
  const steps: CascadeStep[] = [
    ...(withdrawRaw > 0n
      ? [
          ...register(c, 'register-in'),
          {
            intentId: 'withdraw',
            tx: i.withdrawTx(withdrawRaw, fromCollateralRaw),
            preview: `withdraw ${text(human(withdrawRaw, c.decimals))} ${c.symbol} from Burrow to your wallet. Health factor after this step: ${hfText(afterWithdraw)} (now ${hfText(hfNow)}; Burrow refuses it below its liquidation line).`,
          },
        ]
      : []),
    ...register(d, 'register-out'),
    {
      intentId: 'swap',
      tx: buildRheaSwap({
        contractId: i.rheaId,
        poolId: quote.poolId,
        tokenIn: c.token,
        tokenOut: d.token,
        amountIn: swapInRaw,
        minAmountOut: minOutRaw,
      }),
      preview: `swap ${swapHuman} ${c.symbol} for at least ${text(human(minOutRaw, d.decimals))} ${d.symbol} on Rhea (max ${(i.slippageBps / 100).toFixed(2)}% slippage). The health factor stays at ${hfText(afterWithdraw)}.`,
    },
    {
      intentId: 'repay',
      tx: i.repayTx(repayRaw),
      preview: `repay up to ${text(human(repayRaw, d.decimals))} ${d.symbol} toward your Burrow loan (capped at the actual debt). Health factor after this step: ${hfText(afterRepay)}.`,
    },
  ];
  const n = steps.length;
  return {
    ok: true,
    steps: steps.map((s, k) => ({
      ...s,
      preview: `Transaction ${k + 1} of ${n}: ${s.preview.charAt(0).toUpperCase()}${s.preview.slice(1)}`,
    })),
    amounts: { withdrawRaw, swapInRaw, estOutRaw: quote.amountOut, minOutRaw, repayRaw },
    hf: { now: hfNow, afterWithdraw, afterRepay },
  };
}
