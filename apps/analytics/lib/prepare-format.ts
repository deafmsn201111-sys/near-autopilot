/** Pure display helpers for the prepare preview. Display only — nothing here feeds a decision or a signature. */

/** yoctoNEAR (10^24) decimal string -> a short NEAR amount, e.g. "0.1", "0.00102", "1". Never scientific notation. */
export function yoctoToNear(yocto: string): string {
  if (!/^\d+$/.test(yocto)) return '0';
  const Y = 24;
  const padded = yocto.padStart(Y + 1, '0');
  const whole = padded.slice(0, padded.length - Y).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(padded.length - Y).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** gas units (10^12 = 1 Tgas) decimal string -> "N Tgas" with up to one decimal. */
export function gasToTgas(gas: string): string {
  if (!/^\d+$/.test(gas)) return '0 Tgas';
  const n = Number(BigInt(gas) / 1_000_000_000n) / 1000; // Tgas with 3 decimals of headroom
  return `${Number(n.toFixed(1))} Tgas`;
}

/** A compact, human receiver label: keep short account ids whole, shorten long/hex token ids. */
export function shortAccount(id: string): string {
  if (id.length <= 24) return id;
  return `${id.slice(0, 10)}…${id.slice(-8)}`;
}

/** Total NEAR a cascade attaches across every action (yoctoNEAR summed), as a NEAR string. */
export function totalDepositNear(
  transactions: readonly { readonly actions: readonly { readonly deposit: string }[] }[],
): string {
  let total = 0n;
  for (const t of transactions)
    for (const a of t.actions) if (/^\d+$/.test(a.deposit)) total += BigInt(a.deposit);
  return yoctoToNear(total.toString());
}
