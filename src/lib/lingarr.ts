/**
 * Lingarr client — translates subtitle lines via Lingarr's HTTP API.
 *
 * Endpoint: POST /api/translate/content (synchronous, returns translated lines)
 * Auth: X-Api-Key header (when Lingarr has authentication enabled).
 * Spec: https://github.com/lingarr-translate/lingarr — see Lingarr.Server/Models/FileSystem/TranslateAbleSubtitleContent.cs
 */

import { SubtitleEntry } from './subtitle-parser.js';

export type MediaType = 'Movie' | 'Show' | 'Season' | 'Episode';

export interface BatchSubtitleLine {
  position: number;
  line: string;
}

export interface BatchTranslatedLine {
  position: number;
  line: string;
}

export interface TranslateAbleSubtitleContent {
  arrMediaId: number;
  title?: string;
  sourceLanguage: string;
  targetLanguage: string;
  mediaType: MediaType;
  lines: BatchSubtitleLine[];
}

export interface LingarrOptions {
  baseUrl: string;
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Optional abort signal for caller-side cancellation (e.g. route budget). */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function buildHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  return headers;
}

/**
 * Convert SubtitleEntry[] → Lingarr's batch request body. Position is 1-based
 * (matches SRT cue indices, which is what Lingarr's batch model expects).
 * Skips empty text lines — Lingarr treats them as no-ops but wastes quota.
 */
export function buildTranslateRequest(
  entries: SubtitleEntry[],
  sourceLanguage: string,
  targetLanguage: string,
  mediaType: MediaType = 'Movie',
  title?: string,
): TranslateAbleSubtitleContent {
  return {
    arrMediaId: 0,
    title,
    sourceLanguage,
    targetLanguage,
    mediaType,
    lines: entries.map((e, i) => ({
      position: i + 1,
      line: e.text,
    })),
  };
}

/**
 * Parse the Lingarr response into a position→line map. Returns null on
 * any structural problem (caller treats as failure → skip this language).
 * Filters empty/null line entries so we never overwrite good text with blanks.
 */
export function parseTranslateResponse(
  raw: unknown,
): Map<number, string> | null {
  if (!Array.isArray(raw)) return null;
  const out = new Map<number, string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const pos = obj.position;
    const line = obj.line;
    if (typeof pos !== 'number' || typeof line !== 'string') continue;
    if (line.length === 0) continue;
    out.set(pos, line);
  }
  return out.size > 0 ? out : null;
}

export interface TranslateContentResult {
  /** position (1-based) → translated line. */
  lines: Map<number, string>;
  /** True when Lingarr returned at least one translation. */
  ok: boolean;
}

export async function translateContent(
  opts: LingarrOptions,
  request: TranslateAbleSubtitleContent,
): Promise<TranslateContentResult> {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/translate/content`;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(opts.apiKey),
      body: JSON.stringify(request),
      signal: opts.signal ?? AbortSignal.timeout(timeout),
    });
    if (!res.ok) {
      console.log(`[lingarr] translate: HTTP ${res.status}`);
      return { lines: new Map(), ok: false };
    }
    const json = await res.json();
    const lines = parseTranslateResponse(json);
    if (!lines) {
      console.log('[lingarr] translate: response had no usable translations');
      return { lines: new Map(), ok: false };
    }
    return { lines, ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[lingarr] translate: error: ${msg.substring(0, 200)}`);
    return { lines: new Map(), ok: false };
  }
}

/**
 * Lightweight availability probe — GET /api/version. Used at startup to decide
 * whether translation should be attempted. Cached result is held by caller
 * (the route module) so we don't ping Lingarr on every /subtitles request.
 */
export async function pingLingarr(
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/version`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(apiKey),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
