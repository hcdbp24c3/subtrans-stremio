/**
 * Yandex Translate provider.
 *
 * Endpoint: POST https://translate.api.cloud.yandex.net/translate/v2/translate
 * Auth: Authorization: Api-Key <key> (or Bearer IAM token)
 * Body: { sourceLanguageCode, targetLanguageCode, format: "PLAIN_TEXT", texts: [string] }
 * Response: { translations: [{ text: string, detectedLanguageCode?: string }] }
 *
 * Yandex deprecated the free tier in 2018; this provider is here for
 * users with a paid Yandex Cloud subscription. Cheaper than Google
 * for high-volume Russian-translation workloads.
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import { readJson, safeFetch } from './_helpers.js';

export const YANDEX_DEFAULT_BASE = 'https://translate.api.cloud.yandex.net';
// Yandex expects lower-case 2-letter codes (e.g. "en", "vi").
// The provider contract uses ISO 639-1 already so no transformation.

export const yandexProvider: TranslationProvider = {
  name: 'yandex',
  label: 'Yandex Translate',
  requiresKey: true,
  defaultBaseUrl: YANDEX_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? YANDEX_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/translate/v2/translate`;

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Api-Key ${opts.apiKey}`,
      },
      body: JSON.stringify({
        sourceLanguageCode: req.sourceLanguage,
        targetLanguageCode: req.targetLanguage,
        format: 'PLAIN_TEXT',
        texts: req.lines.map((e) => e.text),
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
    const translations = (json as { translations?: unknown }).translations;
    if (!Array.isArray(translations) || translations.length === 0) {
      return { lines: new Map(), ok: false, reason: 'no translations' };
    }
    const map = new Map<number, string>();
    translations.forEach((t, i) => {
      if (!t || typeof t !== 'object') return;
      const text = (t as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        map.set(i + 1, text);
      }
    });
    if (map.size === 0) {
      return { lines: new Map(), ok: false, reason: 'empty translations' };
    }
    const characters = req.lines.reduce((sum, e) => sum + e.text.length, 0);
    return { lines: map, ok: true, usage: { characters } };
  },
};
