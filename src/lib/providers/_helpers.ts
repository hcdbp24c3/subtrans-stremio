/**
 * Shared helpers for translation providers.
 */

import { ProviderOptions, ProviderRequest, TranslateResult } from './types.js';

export const PROVIDER_TIMEOUT_DEFAULT = 30_000;

/** Compose Authorization header for the common "Bearer" scheme. */
export function bearerHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Fetch with timeout + abort signal. Returns the response or null on
 * any error (network, timeout, abort). Caller checks res.ok / res.status.
 * Logs the error class so the operator can tell ECONNREFUSED apart
 * from a timeout or DNS failure.
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  opts: Pick<ProviderOptions, 'timeoutMs' | 'signal'>,
): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? PROVIDER_TIMEOUT_DEFAULT),
    });
    return res;
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    const reason =
      err.cause?.code ?? err.code ?? err.name ?? 'unknown';
    console.log(`[provider] fetch failed: url=${url.slice(0, 80)} reason=${reason} msg=${(err.message || '').slice(0, 100)}`);
    return null;
  }
}

/**
 * Parse a JSON response body. Returns null on any error (non-JSON,
 * empty, network issue). Caller treats null as "no translation".
 */
export async function readJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Build a chat-completion prompt: translate each line independently,
 * preserve numbering. Works for any chat-style model.
 */
export function buildChatPrompt(req: ProviderRequest): {
  system: string;
  user: string;
} {
  return {
    system: [
      'You are a subtitle translator. Translate each numbered line from',
      `${req.sourceLanguage} to ${req.targetLanguage}.`,
      'Output exactly one translated line per input line, in the same order,',
      'each prefixed with the line number and a period, like "1. text".',
      'Do not add commentary, do not skip lines, do not reorder.',
      'Preserve on-screen text like sound effects if present, translate them too.',
    ].join(' '),
    user: req.lines
      .map((e, i) => `${i + 1}. ${e.text}`)
      .join('\n'),
  };
}

/**
 * Parse a chat-completion response: expects "1. text\n2. text\n..." shape.
 * Falls back to splitting by line and matching prefix. Returns null on
 * structural failure so the caller can log and skip.
 */
export function parseChatResponse(raw: unknown, expectedCount: number): Map<number, string> | null {
  if (typeof raw !== 'string') return null;
  const map = new Map<number, string>();
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s*[.)]\s*(.+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const text = m[2].trim();
    if (text.length > 0 && idx >= 1 && idx <= expectedCount) {
      map.set(idx, text);
    }
  }
  return map.size > 0 ? map : null;
}
