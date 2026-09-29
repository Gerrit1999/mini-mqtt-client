export class FifoCache<K, V> {
  private readonly values = new Map<K, V>();

  constructor(private readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get(key: K): V | undefined {
    return this.values.get(key);
  }

  set(key: K, value: V): void {
    if (this.values.has(key)) {
      this.values.set(key, value);
      return;
    }

    if (this.values.size >= this.maxEntries) {
      const oldest = this.values.keys().next();
      if (!oldest.done) this.values.delete(oldest.value);
    }

    this.values.set(key, value);
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}
