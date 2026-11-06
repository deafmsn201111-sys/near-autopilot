/** Formatting of decimal strings from the API. Display only: nothing here feeds a decision. */
export function pct(fraction: string | number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || fraction === '') return '—';
  const n = typeof fraction === 'number' ? fraction : Number(fraction);
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—';
}

export function usd(v: string | number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // A real minus sign before the currency: −$0.06, never $-0.06. A value that rounds to zero has no sign.
  return n < 0 && Number(s.replace(/,/g, '')) !== 0 ? `−$${s}` : `$${s}`;
}

/** Text class for a signed amount: green above zero, red below, neutral at zero or unknown. */
export const signed = (v: number | string | null | undefined): string => {
  const n = v === null || v === undefined || v === '' ? NaN : Number(v);
  return !Number.isFinite(n) || Math.abs(n) < 0.005 ? '' : n > 0 ? 'pos' : 'neg';
};

/**
 * Splits "head; agent: text (with; semicolons); agent: text" at top-level "; " only (not inside parentheses).
 */
export function splitOutcome(outcome: string | null): {
  head: string | null;
  parts: { agent: string; text: string }[];
} {
  if (!outcome) return { head: null, parts: [] };
  const chunks: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < outcome.length; i += 1) {
    const ch = outcome[i] ?? '';
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && ch === ';' && outcome[i + 1] === ' ') {
      chunks.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
  }
  chunks.push(cur);
  const [head, ...rest] = chunks;
  return {
    head: head ?? null,
    parts: rest.map((p) => {
      const i = p.indexOf(':');
      return i < 0 ? { agent: p, text: '' } : { agent: p.slice(0, i), text: p.slice(i + 1).trim() };
    }),
  };
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

/** v1:4512 -> "#4512"; dcl:a|b|100 -> "DCL 0.01%". The full key stays available as a tooltip. */
export function poolName(key: string): string {
  if (key.startsWith('v1:')) return `#${key.slice(3)}`;
  if (key.startsWith('dcl:')) {
    const fee = Number(key.split('|').pop());
    return Number.isFinite(fee) ? `DCL ${(fee / 10_000).toFixed(fee % 100 === 0 ? 2 : 3)}%` : 'DCL';
  }
  return key;
}

export type StatusKind = 'good' | 'warning' | 'serious' | 'critical' | 'neutral';

/** Status codes from the API to a kind (icon + status colour) and a readable label. */
export function statusOf(code: string | null | undefined): { kind: StatusKind; label: string } {
  if (!code) return { kind: 'neutral', label: 'unknown' };
  const label = code
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase())
    .replace(/\b(Lp|Dcl|Apr|Usd)\b/g, (w) => w.toUpperCase());
  if (
    /^(ok|success|valid|healthy|routed|completed|lp_simulation_eligible|analytics_eligible|supported|high|corroborated|allow|liquid|idle|pass|allowed|stopped)$/i.test(
      code,
    )
  )
    return { kind: 'good', label };
  if (/(unavailable|failed|invalid|block|critical|refused)/i.test(code))
    return { kind: 'critical', label };
  if (
    /(partial|degraded|low_confidence|single_source|warn|stale|medium|disputed|running)/i.test(code)
  )
    return { kind: 'warning', label };
  if (/(unpriced|low_liquidity|unsupported|insufficient|low)/i.test(code))
    return { kind: 'serious', label };
  return { kind: 'neutral', label };
}

/** Compact USD for tiles: $1.2M, $412K, $950. */
export function usdCompact(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

export const int = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString('en-US');

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
