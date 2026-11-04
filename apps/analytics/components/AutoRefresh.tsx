'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Re-renders the page from stored data every `seconds`. It never triggers a collection. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
