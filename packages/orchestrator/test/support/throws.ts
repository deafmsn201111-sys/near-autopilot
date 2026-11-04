/** The offline vitest shim has no `.rejects`, so tests use this to assert that an async call throws. */
export async function throws(promise: Promise<unknown>): Promise<boolean> {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}
