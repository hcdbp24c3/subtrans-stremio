interface Entry<T> {
  value: T;
  expires: number;
}

export function createTtlStore<T>(maxEntries = 100) {
  const map = new Map<string, Entry<T>>();

  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs: number): void {
      if (!map.has(key) && map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { value, expires: Date.now() + ttlMs });
    },
    clear(): void {
      map.clear();
    },
    size(): number {
      return map.size;
    },
  };
}
