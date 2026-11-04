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
  completed: 'Check completed',
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

interface ProvenanceView {
  readonly dataSource: 'chain' | 'simulation';
  readonly network: 'mainnet' | 'testnet';
}

/**
 * Banner text for where the shown data comes from. Kept as plain text so it reads the same everywhere and can be
 * tested; the four cases must never be confused with each other.
 */
export function provenanceBanner(
  p: ProvenanceView & { readonly executionMode: 'dry-run' | 'live' },
): { readonly tone: 'sim' | 'test' | 'main'; readonly text: string } {
  if (p.dataSource === 'simulation') {
    return {
      tone: 'sim',
      text: 'SIMULATION: synthetic demo portfolio served by a mock RPC. Nothing is read from or sent to NEAR; no result here happened on-chain.',
    };
  }
  const sending =
    p.executionMode === 'dry-run'
      ? 'dry-run, nothing is sent'
      : 'live: approved actions are signed and sent';
  if (p.network === 'testnet') {
    return p.executionMode === 'dry-run'
      ? {
          tone: 'test',
          text: 'TESTNET · READ-ONLY · DRY-RUN: real NEAR testnet data read through RPC view calls (test tokens, no real value). Nothing is signed or sent.',
        }
      : { tone: 'test', text: `TESTNET data (test tokens, no real value); ${sending}.` };
  }
  return { tone: 'main', text: `MAINNET data, read-only (${sending}).` };
}

/** What a proposal's outcome is evidence of: simulated, planned only, or a real transaction on a named network. */
export function evidenceLabel(
  p: ProvenanceView & {
    readonly status: string;
    readonly executionMode: 'dry-run' | 'live' | null;
    readonly txHash: string | null;
  },
): string {
  if (p.dataSource === 'simulation') return 'Simulated: mock data, not sent';
  if (p.txHash !== null && p.executionMode === 'live') {
    return p.status === 'executed'
      ? `On-chain (${p.network}): transaction ${p.txHash} confirmed`
      : `Sent on ${p.network}, outcome not confirmed: check transaction ${p.txHash}`;
  }
  if (p.executionMode === 'dry-run') return `Dry run on ${p.network} data: not sent`;
  return `Not executed (${p.network} data)`;
}
