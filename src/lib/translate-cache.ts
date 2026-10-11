/**
 * Translation result cache.
 *
 * Key: provider + source sub URL + source lang + target lang. The provider
 * part avoids serving a "bad" translation from a different provider when
 * the user switches providers (e.g. from Google to OpenAI). Same source
 * can produce N cached translations (one per target, one per provider).
 * SHA-1 hex is short and collision-resistant enough for cache keys.
 *
 * Value: parsed subtitle entries (preserving source timestamps) + the
 * source format (so the route can re-serialize for the client).
 *
 * TTL: 7 days. Translation is deterministic for a given (source, target,
 * provider) — refreshing before 7d wastes provider quota.
 */

import { createHash } from 'crypto';
import { SubtitleEntry, SubtitleFormat } from './subtitle-parser.js';
import { createTtlStore } from './ttl-store.js';

export interface CachedTranslation {
  entries: SubtitleEntry[];
  format: SubtitleFormat;
  sourceLang: string;
  targetLang: string;
  /** Provider name (used to scope the cache key). */
  provider: string;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_ENTRIES = 500;

const cache = createTtlStore<CachedTranslation>(MAX_ENTRIES);

export function translationCacheKey(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
): string {
  return createHash('sha1')
    .update(`${provider}|${sourceLang}|${targetLang}|${sourceUrl}`)
    .digest('hex');
}

export function getCachedTranslation(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
): CachedTranslation | undefined {
  return cache.get(translationCacheKey(provider, sourceUrl, sourceLang, targetLang));
}

export function setCachedTranslation(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
  value: Omit<CachedTranslation, 'sourceLang' | 'targetLang'>,
): void {
  cache.set(
    translationCacheKey(provider, sourceUrl, sourceLang, targetLang),
    { ...value, sourceLang, targetLang },
    TTL_MS,
  );
}

export function clearTranslationCache(): void {
  cache.clear();
}
