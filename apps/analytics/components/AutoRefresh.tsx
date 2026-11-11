'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/** The account view is re-rendered by AccountWatcher on a new transaction; a timer there would spend its rate limit. */
export const autoRefreshes = (portfolio: string | null): boolean => portfolio !== 'account';

/** Re-renders the page from stored data every `seconds`. It never triggers a collection. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  const on = autoRefreshes(useSearchParams().get('p'));
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds, on]);
  return null;
}
