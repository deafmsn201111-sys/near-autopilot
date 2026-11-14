/** Prevent background route refreshes from unmounting the prepared cascade while its wallet prompts are in progress. */
const active = new Map<string, number>();

const keyOf = (account: string) => account.trim().toLowerCase();

export function beginCascadeSigning(account: string): () => void {
  const key = keyOf(account);
  active.set(key, (active.get(key) ?? 0) + 1);
  let ended = false;

  return () => {
    if (ended) return;
    ended = true;
    const count = active.get(key) ?? 0;
    if (count <= 1) active.delete(key);
    else active.set(key, count - 1);
  };
}

export const isCascadeSigning = (account: string) => active.has(keyOf(account));
export const isAnyCascadeSigning = () => active.size > 0;
