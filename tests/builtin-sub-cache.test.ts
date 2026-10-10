import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCachedBuiltinSub, setCachedBuiltinSub,
  builtinSubCacheKey, clearBuiltinSubCache,
} from '../src/lib/builtin-sub-cache.js';
import { SubtitleEntry } from '../src/lib/subtitle-parser.js';

const sampleEntries: SubtitleEntry[] = [
  { start: 0, end: 1, text: 'Hello' },
  { start: 1, end: 2, text: 'World' },
];

describe('builtinSubCacheKey', () => {
  it('produces 40-char hex sha1', () => {
    const k = builtinSubCacheKey('http://x.com/v.mkv', 2);
    expect(k).toMatch(/^[a-f0-9]{40}$/);
  });

  it('differs per streamIndex', () => {
    const a = builtinSubCacheKey('http://x.com/v.mkv', 1);
    const b = builtinSubCacheKey('http://x.com/v.mkv', 2);
    expect(a).not.toBe(b);
  });

  it('differs per videoUrl', () => {
    const a = builtinSubCacheKey('http://a.com/v.mkv', 0);
    const b = builtinSubCacheKey('http://b.com/v.mkv', 0);
    expect(a).not.toBe(b);
  });

  it('stable for same inputs', () => {
    const a = builtinSubCacheKey('http://x.com/v.mkv', 1);
    const b = builtinSubCacheKey('http://x.com/v.mkv', 1);
    expect(a).toBe(b);
  });
});

describe('getCachedBuiltinSub / setCachedBuiltinSub', () => {
  beforeEach(() => { clearBuiltinSubCache(); });
  afterEach(() => { clearBuiltinSubCache(); });

  it('returns undefined when not set', () => {
    expect(getCachedBuiltinSub('http://x.com/v.mkv', 0)).toBeUndefined();
  });

  it('round-trips a cached value', () => {
    setCachedBuiltinSub('http://x.com/v.mkv', 0, {
      entries: sampleEntries, format: 'srt', lang: 'eng', streamIndex: 0,
      extractedAt: 12345,
    });
    const hit = getCachedBuiltinSub('http://x.com/v.mkv', 0);
    expect(hit).toBeDefined();
    expect(hit?.entries).toEqual(sampleEntries);
    expect(hit?.lang).toBe('eng');
    expect(hit?.streamIndex).toBe(0);
    expect(hit?.extractedAt).toBe(12345);
  });

  it('keeps separate entries for different streamIndex of same video', () => {
    setCachedBuiltinSub('http://x.com/v.mkv', 0, {
      entries: sampleEntries, format: 'srt', lang: 'eng', streamIndex: 0,
      extractedAt: 1,
    });
    setCachedBuiltinSub('http://x.com/v.mkv', 1, {
      entries: [{ start: 0, end: 1, text: 'Hola' }],
      format: 'srt', lang: 'spa', streamIndex: 1, extractedAt: 2,
    });
    expect(getCachedBuiltinSub('http://x.com/v.mkv', 0)?.lang).toBe('eng');
    expect(getCachedBuiltinSub('http://x.com/v.mkv', 1)?.lang).toBe('spa');
  });

  it('expires after TTL (24h)', () => {
    vi.useFakeTimers();
    try {
      setCachedBuiltinSub('http://x.com/v.mkv', 0, {
        entries: sampleEntries, format: 'srt', lang: 'eng', streamIndex: 0,
        extractedAt: 0,
      });
      expect(getCachedBuiltinSub('http://x.com/v.mkv', 0)).toBeDefined();
      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      expect(getCachedBuiltinSub('http://x.com/v.mkv', 0)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
