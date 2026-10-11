/**
 * Microsoft Bing Microsoft Translator provider.
 *
 * Endpoint: POST https://api.cognitive.microsofttranslator.com/translate
 * Auth: Ocp-Apim-Subscription-Key header (or use the free "Text Translation"
 *         endpoint at api.cognitive.microsoft.com with region header).
 * Body: [{ Text: string }]  (array, not object)
 * Response: [{ translations: [{ text: string, to: string }] }]
 *
 * Microsoft deprecated the free tier for new keys in 2024 but existing
 * keys (Azure subscription) still work. Multi-tenant endpoint requires
 * the Ocp-Apim-Subscription-Region header.
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import { readJson, safeFetch } from './_helpers.js';

export const BING_DEFAULT_BASE = 'https://api.cognitive.microsofttranslator.com';
// Azure resource region (e.g. "eastus"). Required for multi-region keys.
const REGION_ENV = 'BING_TRANSLATOR_REGION';

export const bingProvider: TranslationProvider = {
  name: 'bing',
  label: 'Microsoft Bing Translator',
  requiresKey: true,
  defaultBaseUrl: BING_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? BING_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/translate?api-version=3.0&from=${req.sourceLanguage}&to=${req.targetLanguage}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': opts.apiKey,
    };
    const region = process.env[REGION_ENV]?.trim();
    if (region) headers['Ocp-Apim-Subscription-Region'] = region;

    const res = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.lines.map((e) => ({ Text: e.text }))),
    }, opts);
    if (!res) return { lines: new Map(), ok: false, reason: 'network error' };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { lines: new Map(), ok: false, reason: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = await readJson(res);
    if (!Array.isArray(json) || json.length === 0) {
      return { lines: new Map(), ok: false, reason: 'invalid response' };
    }
    const map = new Map<number, string>();
    for (let i = 0; i < json.length && i < req.lines.length; i++) {
      const item = json[i] as { translations?: { text?: string }[] };
      const text = item?.translations?.[0]?.text;
      if (typeof text === 'string' && text.length > 0) {
        map.set(i + 1, text);
      }
    }
    if (map.size === 0) {
      return { lines: new Map(), ok: false, reason: 'no translations' };
    }
    const characters = req.lines.reduce((sum, e) => sum + e.text.length, 0);
    return { lines: map, ok: true, usage: { characters } };
  },
};
