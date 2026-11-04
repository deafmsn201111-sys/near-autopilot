/** Recursively converts bigint -> decimal string and Date -> ISO string so values are JSON-safe. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map)
    return Object.fromEntries([...value].map(([k, v]) => [String(k), toJsonSafe(v)]));
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value;
}

/** Deterministic JSON: object keys sorted, bigint/Date normalised. Safe to hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(toJsonSafe(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}
