/**
 * DeepL provider.
 *
 * Endpoint: POST /v2/translate
 * Auth: Authorization: DeepL-Auth-Key <KEY>
 * Free tier: api-free.deepl.com
 * Pro tier: api.deepl.com
 *
 * DeepL returns ONE translation per request (no batching). We fan out
 * requests in parallel — DeepL's free tier allows ~5 concurrent.
 *
 * Body: { text: string|string[], source_lang, target_lang }
 * Response: { translations: [{ text, detected_source_language }] }
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import { readJson, safeFetch } from './_helpers.js';

export const DEEPL_FREE_BASE = 'https://api-free.deepl.com';
export const DEEPL_PRO_BASE = 'https://api.deepl.com';

/** DeepL uses uppercase codes for some langs. Best-effort map. */
const DEEPL_LANG_MAP: Record<string, string> = {
  en: 'EN', vi: 'VI', ja: 'JA', ko: 'KO', zh: 'ZH',
  fr: 'FR', de: 'DE', es: 'ES', pt: 'PT', it: 'IT',
  ru: 'RU', ar: 'AR', hi: 'HI', tr: 'TR', th: 'TH',
  id: 'ID', ms: 'MS', nl: 'NL', pl: 'PL', sv: 'SV',
  da: 'DA', fi: 'FI', no: 'NB', cs: 'CS', el: 'EL',
  ro: 'RO', hu: 'HU', uk: 'UK', he: 'HE',
};
const deeplLang = (code: string): string => DEEPL_LANG_MAP[code.toLowerCase()] ?? code.toUpperCase();

export const deeplProvider: TranslationProvider = {
  name: 'deepl',
  label: 'DeepL',
  requiresKey: true,
  defaultBaseUrl: DEEPL_FREE_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    // DeepL Pro uses api.deepl.com, Free uses api-free.deepl.com.
    // Auto-pick by key suffix: keys ending in ":fx" are free tier.
    const isFree = opts.apiKey.endsWith(':fx');
    const baseUrl = opts.baseUrl ?? (isFree ? DEEPL_FREE_BASE : DEEPL_PRO_BASE);
    const url = `${baseUrl.replace(/\/+$/, '')}/v2/translate`;

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: req.lines.map((e) => e.text),
        source_lang: deeplLang(req.sourceLanguage),
        target_lang: deeplLang(req.targetLanguage),
      }),
    }, opts);
    if (!res) return { lines: new Map(), ok: false, reason: 'network error' };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { lines: new Map(), ok: false, reason: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
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
      if (typeof text !== 'string' || text.length === 0) return;
      map.set(i + 1, text);
    });
    if (map.size === 0) {
      return { lines: new Map(), ok: false, reason: 'empty translations' };
    }
    // Approx character count: 1 char ≈ 1 token for DeepL accounting.
    const characters = req.lines.reduce((sum, e) => sum + e.text.length, 0);
    return { lines: map, ok: true, usage: { characters } };
  },
};
