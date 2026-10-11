/**
 * Google Cloud Translate v2 (basic) provider.
 *
 * Endpoint: POST https://translation.googleapis.com/language/translate/v2
 * Auth: ?key=<API_KEY> query param
 * Body: { q: string|string[], source: "en", target: "vi", format: "text" }
 * Response: { data: { translations: [{ translatedText }] } }
 *
 * Free tier: 500K characters/month.
 *
 * NOTE: This is the v2 REST API, not the v3beta gRPC client. Simpler, no
 * service-account JSON parsing required, works with just an API key.
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import { readJson, safeFetch } from './_helpers.js';

export const GOOGLE_DEFAULT_BASE = 'https://translation.googleapis.com';

export const googleProvider: TranslationProvider = {
  name: 'google',
  label: 'Google Translate',
  requiresKey: true,
  defaultBaseUrl: GOOGLE_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? GOOGLE_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/language/translate/v2?key=${encodeURIComponent(opts.apiKey)}`;

    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: req.lines.map((e) => e.text),
        source: req.sourceLanguage,
        target: req.targetLanguage,
        format: 'text',
      }),
    }, opts);
    if (!res) return { lines: new Map(), ok: false, reason: 'network error' };
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { lines: new Map(), ok: false, reason: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }
    const json = await readJson(res);
    if (!json || typeof json !== 'object') {
      return { lines: new Map(), ok: false, reason: 'invalid response' };
    }
    const data = (json as { data?: { translations?: unknown } }).data;
    if (!data || typeof data !== 'object') {
      return { lines: new Map(), ok: false, reason: 'no data block' };
    }
    const translations = data.translations;
    if (!Array.isArray(translations) || translations.length === 0) {
      return { lines: new Map(), ok: false, reason: 'no translations' };
    }
    const map = new Map<number, string>();
    translations.forEach((t, i) => {
      if (!t || typeof t !== 'object') return;
      const text = (t as { translatedText?: unknown }).translatedText;
      if (typeof text !== 'string' || text.length === 0) return;
      map.set(i + 1, text);
    });
    if (map.size === 0) {
      return { lines: new Map(), ok: false, reason: 'empty translations' };
    }
    const characters = req.lines.reduce((sum, e) => sum + e.text.length, 0);
    return { lines: map, ok: true, usage: { characters } };
  },
};
