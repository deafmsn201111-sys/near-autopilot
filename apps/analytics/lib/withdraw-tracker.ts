'use client';
import { useSyncExternalStore } from 'react';
import {
  loadDepositStatus,
  statusDelayMs,
  stopReason,
  type DepositQuote,
  type DepositStatus,
} from './deposit';
import { poll, tabHidden } from './polling';

export interface Tracked {
  readonly quote: DepositQuote;
  readonly status: DepositStatus | null;
  readonly error: string | null;
  readonly stopped: boolean;
}

// ponytail: in memory for this page load, one withdrawal at a time; persist it if tracking must survive a reload.
let current: Tracked | null = null;
let stopRound: (() => void) | null = null;
const listeners = new Set<() => void>();

const STATUS_ERROR = 'The 1Click status could not be read right now. It is checked again shortly.';

const emit = () => listeners.forEach((l) => l());
function patch(id: string, next: Partial<Tracked>) {
  if (current?.quote.id !== id) return;
  current = { ...current, ...next };
  emit();
}

/** Checks at once, then on the backoff, until a final status, an unpaid deadline or the check limit. */
function round(id: string) {
  stopRound?.();
  let checks = 0;
  let sent = 0;
  let shown = 0;
  let last: DepositStatus | null = null;
  const tick = () => {
    checks++;
    const n = ++sent;
    void loadDepositStatus(id).then((r) => {
      // Responses can overlap on a slow network: only one newer than what is on screen may replace it.
      if (n < shown || current?.quote.id !== id) return;
      shown = n;
      if (r.ok) last = r.data;
      patch(id, r.ok ? { status: r.data, error: null } : { error: STATUS_ERROR });
      if (stopReason(last, checks)) {
        stop();
        patch(id, { stopped: true });
      }
    });
  };
  const stop = poll(tick, { everyMs: statusDelayMs, forMs: Infinity, hidden: tabHidden });
  stopRound = stop;
  tick();
}

/** Follows a signed withdrawal's 1Click status, whether or not its sheet is open. */
export function trackWithdrawal(quote: DepositQuote) {
  current = { quote, status: null, error: null, stopped: false };
  emit();
  round(quote.id);
}

export function checkAgain() {
  if (!current) return;
  patch(current.quote.id, { stopped: false });
  round(current.quote.id);
}

export function forgetWithdrawal() {
  stopRound?.();
  stopRound = null;
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useWithdrawal = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
