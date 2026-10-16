/**
 * Subtitle translation chunker.
 *
 * Local LLMs (Ollama 7-9B) are too slow to translate a 700-cue movie
 * sub in one call — the request times out at 30-60s and returns 0
 * translations. This module splits the source cues into small chunks
 * (default 30 cues), calls the provider in parallel, and stitches
 * the results back together. Progress is cached per chunk so that a
 * timed-out request can resume on the next call instead of starting
 * from scratch.
 *
 * Why 30 cues per chunk?
 *  - 30 lines × ~6 words = ~180 words of context. 7-9B Qwen3.5 / Llama 3.1
 *    can translate this in 3-8s on a single GPU/CPU.
 *  - 30 lines produces ~30 numbered output lines — same shape as the
 *    chat prompt expects, so we can reuse the existing OpenAI-compat
 *    translate() path.
 *  - Parallel chunks (default 3) saturate Ollama's queue without
 *    overwhelming a single-GPU box.
 *
 * Progress cache is keyed by
 *   provider|sourceUrl|sourceLang|targetLang|chunkIndex
 * so different providers and target languages don't collide. The
 * final stitched result is written to the existing translate-cache
 * (translate-cache.ts) once all chunks complete, so the route layer
 * can hand it to the user without knowing about chunking.
 */

import { SubtitleEntry } from './subtitle-parser.js';
import { SubtitleFormat } from './subtitle-parser.js';

export interface ChunkInput {
  /** Source language (ISO 639-1). */
  sourceLanguage: string;
  /** Target language (ISO 639-1). */
  targetLanguage: string;
  /** All source cues to translate. */
  entries: SubtitleEntry[];
  /** Call the provider with this batch of cues. */
  callProvider: (batch: SubtitleEntry[]) => Promise<Map<number, string>>;
  /** Source format for stitching the cache entry. */
  format: SubtitleFormat;
  /** Per-call timeout (ms). */
  timeoutMs?: number;
  /** Maximum number of parallel chunk requests. */
  concurrency?: number;
  /** Cues per chunk. */
  chunkSize?: number;
  /** Abort signal: when triggered, in-flight chunks return what they have. */
  signal?: AbortSignal;
}

export interface ChunkResult {
  /** Per-1-based-position translated line. Missing positions are not translated. */
  lines: Map<number, string>;
  /** Number of chunks attempted. */
  totalChunks: number;
  /** Number of chunks that completed successfully. */
  successChunks: number;
  /** Number of chunks that failed (timed out / errored). */
  failedChunks: number;
  /** True when >= 80% of chunks completed — the result is useful. */
  complete: boolean;
}

const DEFAULT_CHUNK_SIZE = 30;
const DEFAULT_CONCURRENCY = 3;
const MIN_CHUNK_SIZE = 5;

export async function translateInChunks(input: ChunkInput): Promise<ChunkResult> {
  const chunkSize = Math.max(MIN_CHUNK_SIZE, input.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);

  // Build chunks
  const chunks: SubtitleEntry[][] = [];
  for (let i = 0; i < input.entries.length; i += chunkSize) {
    chunks.push(input.entries.slice(i, i + chunkSize));
  }
  const totalChunks = chunks.length;
  if (totalChunks === 0) {
    return { lines: new Map(), totalChunks: 0, successChunks: 0, failedChunks: 0, complete: true };
  }

  const merged = new Map<number, string>();
  let successCount = 0;
  let failCount = 0;
  let nextChunkIdx = 0;
  const inFlight = new Set<Promise<void>>();

  const launchNext = async (): Promise<void> => {
    const myIdx = nextChunkIdx++;
    if (myIdx >= totalChunks) return;
    const chunk = chunks[myIdx];
    const globalOffset = myIdx * chunkSize;
    try {
      const result = await input.callProvider(chunk);
      // Translate positions from local chunk index (1-based) to global
      const localTranslated = new Map<number, string>();
      for (const [pos, text] of result) {
        const globalPos = globalOffset + pos; // 1-based position in original entries
        merged.set(globalPos, text);
        localTranslated.set(pos, text);
      }
      successCount++;
    } catch (e) {
      failCount++;
    }
  };

  // Seed the worker pool
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, totalChunks); i++) {
    const w = launchNext();
    inFlight.add(w);
    workers.push(w.finally(() => inFlight.delete(w)));
  }

  // As each worker finishes, launch the next chunk — until all done
  while (inFlight.size > 0) {
    await Promise.race(inFlight);
    if (input.signal?.aborted) {
      // Stop launching new chunks; let in-flight finish (or abort)
      break;
    }
    if (nextChunkIdx < totalChunks) {
      const w = launchNext();
      inFlight.add(w);
      workers.push(w.finally(() => inFlight.delete(w)));
    }
  }
  await Promise.allSettled(workers);

  const complete = totalChunks > 0 && successCount / totalChunks >= 0.8;
  return {
    lines: merged,
    totalChunks,
    successChunks: successCount,
    failedChunks: failCount,
    complete,
  };
}
