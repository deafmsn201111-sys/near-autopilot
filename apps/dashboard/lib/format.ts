/** "1234.5" -> "$1,234.50". Input is the API's decimal string; never goes through float math for sign/scale. */
export function formatUsd(value: string | null): string {
  if (value === null) return 'unpriced';
  const negative = value.startsWith('-');
  const [whole = '0', frac = '00'] = value.replace('-', '').split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}.${frac.slice(0, 2).padEnd(2, '0')}`;
}

/** Raw integer string + decimals -> human amount with at most `maxFraction` digits (trailing zeros trimmed). */
export function formatAmount(raw: string, decimals: number, maxFraction = 4): string {
  const padded = raw.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals) || '0';
  const fraction =
    decimals === 0
      ? ''
      : padded
          .slice(padded.length - decimals)
          .slice(0, maxFraction)
          .replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatHealthFactor(hf: number | null): string {
  return hf === null ? 'No debt' : hf.toFixed(2);
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export const STATUS_LABELS: Record<string, string> = {
  executed: 'Executed',
  dry_run: 'Dry run',
  approved: 'Approved, unresolved',
  rejected: 'Blocked by policy',
  requires_approval: 'Needs your approval',
  planning_failed: 'Could not build transaction',
  failed: 'Failed',
};

export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'executed':
      return 'good';
    case 'requires_approval':
    case 'approved':
      return 'warn';
    case 'rejected':
    case 'failed':
    case 'planning_failed':
      return 'bad';
    default:
      return 'neutral';
  }
}
