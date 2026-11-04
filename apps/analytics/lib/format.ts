/** Formatting of decimal strings from the API. Display only: nothing here feeds a decision. */
export function pct(fraction: string | number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || fraction === '') return '—';
  const n = typeof fraction === 'number' ? fraction : Number(fraction);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)} %` : '—';
}

export function usd(v: string | number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export const usd2 = (v: string | number | null | undefined): string => usd(v, 2);

export function ts(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function age(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function shortToken(t: string): string {
  return t.length > 24 ? `${t.slice(0, 10)}…${t.slice(-6)}` : t;
}

export function tone(status: string | null | undefined): 'ok' | 'warn' | 'bad' | 'dim' {
  if (!status) return 'dim';
  if (
    /^(ok|success|valid|healthy|LP_SIMULATION_ELIGIBLE|ANALYTICS_ELIGIBLE|SUPPORTED|HIGH)$/i.test(
      status,
    )
  )
    return 'ok';
  if (/(unavailable|failed|invalid|DATA_INVALID)/i.test(status)) return 'bad';
  return 'warn';
}
