/**
 * Translation result cache.
 *
 * Two layers:
 *  1. Per-chunk cache: provider + source sub URL + source lang + target
 *     lang + chunk index. Lets long translations resume from where they
 *     left off when the request budget runs out — no re-translating
 *     cues that already succeeded.
 *  2. Final stitched cache: provider + source sub URL + source lang +
 *     target lang. The route layer reads this when the translation
 *     completes. TTL: 7 days.
 *
 * SHA-1 hex is short and collision-resistant enough for cache keys.
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
const CHUNK_TTL_MS = 24 * 60 * 60 * 1000; // 24h — chunks are intermediate state
const MAX_ENTRIES = 500;

const cache = createTtlStore<CachedTranslation>(MAX_ENTRIES);
const chunkCache = createTtlStore<{ pos: number; text: string }>(MAX_ENTRIES * 5);

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

function chunkCacheKey(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
  chunkIdx: number,
): string {
  return createHash('sha1')
    .update(`chunk|${provider}|${sourceLang}|${targetLang}|${sourceUrl}|${chunkIdx}`)
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

/** Save a single translated cue (chunkIndex * chunkSize + pos) for resume. */
export function setCachedChunkLine(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
  chunkIdx: number,
  pos: number,
  text: string,
): void {
  chunkCache.set(chunkCacheKey(provider, sourceUrl, sourceLang, targetLang, chunkIdx), { pos, text }, CHUNK_TTL_MS);
}

/** Read all cached chunk lines for a given translation. Returns a map of
 *  global 1-based position → translated text. */
export function getCachedChunkLines(
  provider: string,
  sourceUrl: string,
  sourceLang: string,
  targetLang: string,
): Map<number, string> {
  const out = new Map<number, string>();
  // We don't know how many chunks were created; iterate by trying indices
  // until we miss 3 in a row. (Cheap because chunkCache is just a Map.)
  for (let idx = 0; idx < 200; idx++) {
    const entry = chunkCache.get(chunkCacheKey(provider, sourceUrl, sourceLang, targetLang, idx));
    if (!entry) {
      // Small gap before final chunk — allow 2 misses
      let found = false;
      for (let lookahead = 1; lookahead <= 2; lookahead++) {
        if (chunkCache.get(chunkCacheKey(provider, sourceUrl, sourceLang, targetLang, idx + lookahead))) {
          found = true;
          break;
        }
      }
      if (!found) break;
      continue;
    }
    // Position stored is 1-based within the chunk
    out.set(entry.pos, entry.text);
  }
  return out;
}

export function clearTranslationCache(): void {
  cache.clear();
  chunkCache.clear();
}
