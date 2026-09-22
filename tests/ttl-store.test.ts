import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTtlStore } from '../src/lib/ttl-store.js';

describe('createTtlStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns value before TTL and undefined after TTL', () => {
    const store = createTtlStore<string>();
    store.set('k', 'v', 1000);
    expect(store.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(store.get('k')).toBeUndefined();
  });

  it('evicts oldest when over maxEntries', () => {
    const store = createTtlStore<number>(2);
    store.set('a', 1, 60_000);
    store.set('b', 2, 60_000);
    store.set('c', 3, 60_000);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBe(2);
    expect(store.get('c')).toBe(3);
    expect(store.size()).toBe(2);
  });

  it('clear empties the store', () => {
    const store = createTtlStore<string>();
    store.set('k', 'v', 1000);
    store.clear();
    expect(store.get('k')).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});
