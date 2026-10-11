/**
 * LibreTranslate provider.
 *
 * Open-source self-hostable translation. Free public instances exist
 * (libretranslate.com, translate.argosopentech.com) but most are
 * rate-limited or down — self-hosting is recommended for production.
 *
 * Endpoint: POST /translate
 * Body: { q: string, source: "en", target: "vi", format: "text",
 *         api_key?: string }
 * Response: { translatedText: string, detectedLanguage?: { language, confidence } }
 *
 * LibreTranslate processes one text at a time. We fan out requests in
 * parallel; LibreTranslate handles ~5 concurrent fine.
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import { readJson, safeFetch } from './_helpers.js';

export const LIBRETRANSLATE_DEFAULT_BASE = 'https://libretranslate.com';

export const libretranslateProvider: TranslationProvider = {
  name: 'libretranslate',
  label: 'LibreTranslate (self-hostable)',
  requiresKey: false, // public instances don't need a key
  defaultBaseUrl: LIBRETRANSLATE_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? LIBRETRANSLATE_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/translate`;

    const results = await Promise.all(
      req.lines.map((entry) => safeFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: entry.text,
          source: req.sourceLanguage,
          target: req.targetLanguage,
          format: 'text',
          ...(opts.apiKey ? { api_key: opts.apiKey } : {}),
        }),
      }, opts)),
    );

    const map = new Map<number, string>();
    let lastError = '';
    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      if (!res) { lastError = 'network error'; continue; }
      if (!res.ok) {
        // Capture the actual error body — LibreTranslate returns useful
        // messages like {"error":"vi is not supported"} that tell the
        // user which language is missing or which key is invalid.
        const errBody = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${errBody.slice(0, 200)}`;
        continue;
      }
      const json = await readJson(res);
      if (!json || typeof json !== 'object') { lastError = 'invalid response'; continue; }
      const text = (json as { translatedText?: unknown }).translatedText;
      if (typeof text !== 'string' || text.length === 0) { lastError = 'no translatedText'; continue; }
      map.set(i + 1, text);
    }

    if (map.size === 0) {
      return { lines: new Map(), ok: false, reason: lastError || 'no translations' };
    }
    const characters = req.lines.reduce((sum, e) => sum + e.text.length, 0);
    return { lines: map, ok: true, usage: { characters } };
  },
};
