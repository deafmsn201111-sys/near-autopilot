/** Shape of `GET /v1/analytics/account/:id/events` items (apps/api/src/analytics/events.ts). */
export type TimelineItem =
  | {
      type: 'cascade';
      at: string;
      cascadeId: string;
      action: string;
      preview: string[];
      status: 'confirmed' | 'partial' | 'not_signed' | 'blocked';
      steps: number;
      signed: { at: string; hash: string; lines: string[] }[];
    }
  | { type: 'analyse'; at: string; source: string }
  | { type: 'connect' | 'verified'; at: string }
  | { type: 'oneclick_quote'; at: string; detail: Record<string, unknown> };

const ACTIONS: Record<string, string> = {
  supply: 'Supply on Burrow',
  repay: 'Repay a Burrow loan',
  repay_from_collateral: 'Repay a Burrow loan from collateral',
  borrow: 'Borrow on Burrow',
  withdraw: 'Withdraw from Burrow',
  swap: 'Swap on Rhea',
  add_liquidity: 'Add liquidity on Rhea',
  reposition_dcl: 'Exit an out-of-range Rhea position',
  unwrap: 'Unwrap wNEAR to NEAR',
};

export const actionName = (action: string) => ACTIONS[action] ?? action.replace(/_/g, ' ');

export const STATUS: Record<
  Extract<TimelineItem, { type: 'cascade' }>['status'],
  { label: string; tone: 'good' | 'warning' | 'neutral' }
> = {
  confirmed: { label: 'signed, confirmed on NEAR', tone: 'good' },
  partial: { label: 'partly signed', tone: 'warning' },
  not_signed: { label: 'not signed', tone: 'neutral' },
  blocked: { label: 'blocked by the safety check', tone: 'warning' },
};

/** The headline of a timeline item, in plain words. */
export function headline(item: TimelineItem): string {
  switch (item.type) {
    case 'cascade':
      return actionName(item.action);
    case 'analyse':
      return item.source === 'ai' ? 'Ran an AI analysis' : 'Ran a rule-based analysis';
    case 'connect':
      return 'Connected the wallet';
    case 'verified':
      return 'Proved ownership';
    case 'oneclick_quote': {
      const from = typeof item.detail['from'] === 'string' ? item.detail['from'] : '?';
      const to = typeof item.detail['to'] === 'string' ? item.detail['to'] : '?';
      return `Got a 1Click deposit quote (${from} → ${to})`;
    }
  }
}

/** What a signed step did, as the server stored it (the decoded result, or the prepared line when logs were silent). */
export const stepLines = (item: Extract<TimelineItem, { type: 'cascade' }>, index: number) =>
  item.signed[index]?.lines ?? [];

export const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
