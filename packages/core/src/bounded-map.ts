/** A Map that keeps at most `limit` keys: setting a key makes it the newest, and the oldest is dropped when full. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly limit: number) {
    super();
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('limit must be a positive integer');
  }

  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.limit) super.delete(this.keys().next().value as K);
    return this;
  }
}
