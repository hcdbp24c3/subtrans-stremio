/**
 * Cache for text sub tracks extracted from a video file.
 *
 * Key: sha1(videoUrl + streamIndex). The same upstream URL may have many
 * subtitle streams; we cache each one independently.
 *
 * Value: parsed SubtitleEntry[] + the codec metadata we got from ffprobe.
 * Translation pipeline uses this as the source when upstream sub addons
 * return nothing.
 *
 * TTL 24h: extraction is expensive (10-30s + bandwidth), so cache for the
 * duration of typical viewing sessions.
 */

import { createHash } from 'crypto';
import { SubtitleEntry } from './subtitle-parser.js';
import { createTtlStore } from './ttl-store.js';

export interface ExtractedBuiltinSub {
  entries: SubtitleEntry[];
  format: 'srt'; // ffmpeg always re-muxes to SRT for text subs
  lang: string;  // raw ffprobe lang tag (e.g. "eng", "vie", "und")
  streamIndex: number;
  /** When the extract was performed (ms epoch). Diagnostic only. */
  extractedAt: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50; // small: each entry is a full sub track

const cache = createTtlStore<ExtractedBuiltinSub>(MAX_ENTRIES);

export function builtinSubCacheKey(videoUrl: string, streamIndex: number): string {
  return createHash('sha1')
    .update(`${videoUrl}|${streamIndex}`)
    .digest('hex');
}

export function getCachedBuiltinSub(
  videoUrl: string,
  streamIndex: number,
): ExtractedBuiltinSub | undefined {
  return cache.get(builtinSubCacheKey(videoUrl, streamIndex));
}

export function setCachedBuiltinSub(
  videoUrl: string,
  streamIndex: number,
  value: ExtractedBuiltinSub,
): void {
  cache.set(builtinSubCacheKey(videoUrl, streamIndex), value, TTL_MS);
}

export function clearBuiltinSubCache(): void {
  cache.clear();
}
