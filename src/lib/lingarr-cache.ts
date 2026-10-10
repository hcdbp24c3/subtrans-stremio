/**
 * Translation result cache.
 *
 * Key: source sub URL + source language + target language. Same source sub can
 * produce N cached translations (one per target language), so all three must
 * participate in the key. SHA-1 hex is short and collision-resistant enough
 * for cache keys (not security).
 *
 * Value: parsed subtitle entries (preserving source timestamps) + the source
 * format (so the route can re-serialize for the client).
 *
 * TTL: 7 days. Translation is deterministic for a given (source, target,
 * provider) — refreshing before 7d wastes Lingarr quota.
 */

import { createHash } from 'crypto';
import { SubtitleEntry, SubtitleFormat } from './subtitle-parser.js';
import { createTtlStore } from './ttl-store.js';

export interface CachedTranslation {
  entries: SubtitleEntry[];
  format: SubtitleFormat;
  sourceLang: string;
  targetLang: string;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 500;

const cache = createTtlStore<CachedTranslation>(MAX_ENTRIES);

export function translationCacheKey(
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
): string {
  return createHash('sha1')
    .update(`${sourceLang}|${targetLang}|${sourceUrl}`)
    .digest('hex');
}

export function getCachedTranslation(
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
): CachedTranslation | undefined {
  return cache.get(translationCacheKey(sourceUrl, sourceLang, targetLang));
}

export function setCachedTranslation(
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
  value: CachedTranslation,
): void {
  cache.set(translationCacheKey(sourceUrl, sourceLang, targetLang), value, TTL_MS);
}

export function clearTranslationCache(): void {
  cache.clear();
}
