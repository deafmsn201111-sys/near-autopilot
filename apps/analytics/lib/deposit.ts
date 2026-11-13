import type { ProvenanceTier } from '@near-autopilot/core';

export interface DepositAsset {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
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
  readonly origin: DepositAsset;
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

export const loadDepositAssets = () => call<DepositAssets>('/api/deposit/assets');

export const requestDepositQuote = (form: DepositForm) =>
  call<DepositQuote>('/api/deposit/quote', {
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
