'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { poll, POLL_FOR_MS, tabHidden } from '../lib/polling';

/** Re-renders the page from stored data every `seconds` while the tab is visible, for 30 minutes after the user last came back to the tab. It never triggers a collection. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    return poll(() => router.refresh(), {
      everyMs: seconds * 1000,
      forMs: POLL_FOR_MS,
      hidden: tabHidden,
    });
  }, [router, seconds]);
  return null;
}
