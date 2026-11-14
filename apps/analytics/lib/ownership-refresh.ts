/**
 * After the proof is saved: re-renders the page now and on every gap until the caller stops it (the page shows the
 * result) or `forMs` passes. One `router.refresh()` is not enough: in Next 15.5 a refresh sometimes never commits, so
 * a transition around it stays pending until some later render lands (#210).
 */
export function refreshUntilChecked(
  refresh: () => void,
  onGiveUp: () => void,
  { everyMs, forMs }: { everyMs: number; forMs: number },
): () => void {
  refresh();
  const retry = setInterval(refresh, everyMs);
  const giveUp = setTimeout(() => {
    clearInterval(retry);
    onGiveUp();
  }, forMs);
  return () => {
    clearInterval(retry);
    clearTimeout(giveUp);
  };
}
