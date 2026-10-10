import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getCachedTranslation, setCachedTranslation,
  translationCacheKey, clearTranslationCache,
} from '../src/lib/lingarr-cache.js';
import { SubtitleEntry } from '../src/lib/subtitle-parser.js';

const sampleEntries: SubtitleEntry[] = [
  { start: 0, end: 1, text: 'Xin chào' },
  { start: 1, end: 2, text: 'Thế giới' },
];

describe('translationCacheKey', () => {
  it('produces 40-char hex sha1', () => {
    const k = translationCacheKey('http://x.com/sub.srt', 'en', 'vi');
    expect(k).toMatch(/^[a-f0-9]{40}$/);
  });

  it('differs per source URL', () => {
    const a = translationCacheKey('http://a.com/s1.srt', 'en', 'vi');
    const b = translationCacheKey('http://b.com/s1.srt', 'en', 'vi');
    expect(a).not.toBe(b);
  });

  it('differs per source language', () => {
    const a = translationCacheKey('http://x.com/s1.srt', 'en', 'vi');
    const b = translationCacheKey('http://x.com/s1.srt', 'eng', 'vi');
    expect(a).not.toBe(b);
  });

  it('differs per target language', () => {
    const a = translationCacheKey('http://x.com/s1.srt', 'en', 'vi');
    const b = translationCacheKey('http://x.com/s1.srt', 'en', 'ja');
    expect(a).not.toBe(b);
  });

  it('stable for same inputs', () => {
    const a = translationCacheKey('http://x.com/s1.srt', 'en', 'vi');
    const b = translationCacheKey('http://x.com/s1.srt', 'en', 'vi');
    expect(a).toBe(b);
  });
});

describe('getCachedTranslation / setCachedTranslation', () => {
  beforeEach(() => { clearTranslationCache(); });
  afterEach(() => { clearTranslationCache(); });

  it('returns undefined when not set', () => {
    expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'vi')).toBeUndefined();
  });

  it('round-trips a cached value', () => {
    setCachedTranslation('http://x.com/s1.srt', 'en', 'vi', {
      entries: sampleEntries,
      format: 'srt',
      sourceLang: 'en',
      targetLang: 'vi',
    });
    const hit = getCachedTranslation('http://x.com/s1.srt', 'en', 'vi');
    expect(hit).toBeDefined();
    expect(hit?.entries).toEqual(sampleEntries);
    expect(hit?.format).toBe('srt');
    expect(hit?.sourceLang).toBe('en');
    expect(hit?.targetLang).toBe('vi');
  });

  it('keeps separate entries for different (source, target) pairs', () => {
    setCachedTranslation('http://x.com/s1.srt', 'en', 'vi', {
      entries: sampleEntries, format: 'srt', sourceLang: 'en', targetLang: 'vi',
    });
    setCachedTranslation('http://x.com/s1.srt', 'en', 'ja', {
      entries: [{ start: 0, end: 1, text: 'こんにちは' }],
      format: 'srt', sourceLang: 'en', targetLang: 'ja',
    });
    expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'vi')?.entries[0].text)
      .toBe('Xin chào');
    expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'ja')?.entries[0].text)
      .toBe('こんにちは');
  });

  it('expires after TTL', () => {
    vi.useFakeTimers();
    try {
      setCachedTranslation('http://x.com/s1.srt', 'en', 'vi', {
        entries: sampleEntries, format: 'srt', sourceLang: 'en', targetLang: 'vi',
      });
      expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'vi')).toBeDefined();
      // 7 days + 1 ms
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 + 1);
      expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'vi')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear empties the cache', () => {
    setCachedTranslation('http://x.com/s1.srt', 'en', 'vi', {
      entries: sampleEntries, format: 'srt', sourceLang: 'en', targetLang: 'vi',
    });
    clearTranslationCache();
    expect(getCachedTranslation('http://x.com/s1.srt', 'en', 'vi')).toBeUndefined();
  });
});
