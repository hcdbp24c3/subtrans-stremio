/**
 * Translation pipeline.
 *
 * Given the upstream sub list (or a pre-extracted built-in sub), fills missing
 * target languages by translating the best source sub via the configured
 * provider (OpenAI / Anthropic / DeepL / Google). Caches results so the same
 * source + target pair never translates twice within 7 days. Serves the
 * translated body through the existing /alignedsub/:token.:ext endpoint
 * (same mechanism as the offset-aligned sub cache).
 *
 * Pure orchestration: no Express, no res object. The route module wires it
 * in and handles the response side.
 *
 * Exported function name `runLingarrPipeline` is kept for backward
 * compatibility with the previous Lingarr-based pipeline.
 */

import { fetchText } from './proxy.js';
import { resolveRealUrl } from './proxy-resolve.js';
import { parseSubtitle, SubtitleEntry, SubtitleFormat } from './subtitle-parser.js';
import {
  resolveTranslateProvider, resolveTranslateKey,
  resolveTranslateBaseUrl, resolveTranslateModel, AddonConfig,
} from '../config.js';
import {
  getProvider, TranslationProvider,
} from './providers/index.js';
import {
  type ProviderRequest, type TranslateResult, stitchEntries,
} from './providers/types.js';
import {
  getCachedTranslation, setCachedTranslation, CachedTranslation,
  getCachedChunkLines, setCachedChunkLine,
} from './translate-cache.js';
import { translateInChunks } from './translate-chunker.js';

export interface LingarrPipelineInput {
  /** Upstream sub list (after dedupe + format detect). The pipeline
   *  picks the best-language sub (English first) from this list and
   *  translates it into each requested target language. */
  subs: LingarrSourceSub[];
  /** Effective config (already-decoded from manifest URL). */
  config: AddonConfig;
  /**
   * Remaining time budget for the request (ms). Translation is skipped when
   * the budget is too low to finish one round-trip.
   */
  budgetMs: number;
  /** Hard cap per translation call (ms). */
  perCallTimeoutMs?: number;
  /**
   * Injectable for tests. Defaults to the configured provider's translate().
   */
  translate?: (req: ProviderRequest) => Promise<TranslateResult>;
}

export interface LingarrSourceSub {
  id: string;
  url: string;
  lang?: string;
  format?: SubtitleFormat;
  /** Normalized ISO 639-1 language code (already run through normalizeLang). */
  normLang?: string;
  /**
   * Pre-built subtitle entries. When present (translation pipeline output),
   * the route serializes them directly instead of re-fetching `url`. Used to
   * expose translated sub bodies without serving a `lingarr://` URL.
   */
  entries?: SubtitleEntry[];
}

export interface LingarrPipelineOutput {
  /** Sub list with translated subs inserted (id, url, lang, format). */
  subs: LingarrSourceSub[];
  /** True when at least one translation succeeded. */
  translated: boolean;
  /** Per-target-language status, for logging. */
  log: LingarrLogEntry[];
}

export interface LingarrLogEntry {
  target: string;
  source: string;
  status: 'cache-hit' | 'translated' | 'no-source' | 'failed' | 'unavailable' | 'no-provider' | 'no-key';
  detail?: string;
  provider?: string;
}

const PER_CALL_TIMEOUT_DEFAULT = 60_000; // local LLMs (Ollama) need more time for 7-9B models
/** Skip translation when the request budget has less than this much left. */
const MIN_BUDGET_MS = 4_000;
/** Per-language hard cap on translation round-trips for a single request. */
const MAX_LANGS_PER_REQUEST = 5;

/** Map a raw ffprobe lang tag (e.g. "eng", "vie") to ISO 639-1 ("en", "vi"). */
function normalizeLangForPipeline(code: string): string {
  const c = code.trim().toLowerCase();
  if (c.length <= 2) return c;
  // Common 639-2/B → 639-1 (kept in sync with subtitle.ts ISO639_2_TO_1).
  const m: Record<string, string> = {
    eng: 'en', vie: 'vi', jpn: 'ja', kor: 'ko', zho: 'zh', tha: 'th',
    ind: 'id', msa: 'ms', fra: 'fr', deu: 'de', spa: 'es', por: 'pt',
    ita: 'it', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl',
  };
  return m[c] ?? c;
}

/**
 * Prefer English for translation source; fall back to the first sub in the
 * upstream list. Translated subs will be skipped (we don't translate X→X).
 */
function pickBestSource(subs: LingarrSourceSub[]): LingarrSourceSub | null {
  if (subs.length === 0) return null;
  // Use the (already normalized) normLang when available; fall back to
  // the raw `lang` field, then to the first sub with any lang set.
  // normalizeLangForPipeline() at the call site handles any 3-letter
  // ISO 639-2/B variant (eng, vie, jpn, etc.).
  const eng = subs.find((s) => {
    const lang = (s.normLang ?? s.lang ?? '').toLowerCase();
    return lang === 'en' || lang === 'eng';
  });
  if (eng) return eng;
  const anyLang = subs.find((s) => (s.lang ?? '').trim().length > 0);
  return anyLang ?? subs[0];
}

function buildSyntheticSub(
  source: LingarrSourceSub,
  targetLang: string,
  cached: CachedTranslation,
): LingarrSourceSub {
  return {
    id: `${source.id}-lingarr-${targetLang}`,
    url: `lingarr://${source.url}#${targetLang}`,
    lang: targetLang,
    format: cached.format,
    normLang: targetLang,
    entries: cached.entries,
  };
}

export async function runLingarrPipeline(
  input: LingarrPipelineInput,
): Promise<LingarrPipelineOutput> {
  const log: LingarrLogEntry[] = [];
  const providerName = resolveTranslateProvider(input.config);

  if (!providerName) {
    console.log('[translate] pipeline skip: no translateProvider configured (set tp=openai|anthropic|deepl|google)');
    return { subs: input.subs, translated: false, log };
  }

  const provider: TranslationProvider | null = getProvider(providerName);
  if (!provider) {
    console.log(`[translate] pipeline skip: unknown provider '${providerName}'`);
    for (const t of (input.config.translateTargets ?? []).slice(0, MAX_LANGS_PER_REQUEST)) {
      log.push({ target: t.toLowerCase(), source: '', status: 'no-provider', provider: providerName });
    }
    return { subs: input.subs, translated: false, log };
  }

  const apiKey = resolveTranslateKey(input.config, providerName);
  if (provider.requiresKey && !apiKey) {
    console.log(`[translate] pipeline skip: provider '${providerName}' requires an API key`);
    for (const t of (input.config.translateTargets ?? []).slice(0, MAX_LANGS_PER_REQUEST)) {
      log.push({ target: t.toLowerCase(), source: '', status: 'no-key', provider: providerName });
    }
    return { subs: input.subs, translated: false, log };
  }

  if (input.budgetMs < MIN_BUDGET_MS) {
    console.log(`[translate] pipeline skip: budget low (${input.budgetMs}ms < ${MIN_BUDGET_MS}ms)`);
    return { subs: input.subs, translated: false, log };
  }

  const rawTargets = (input.config.translateTargets ?? [])
    .map((c) => normalizeLangForPipeline(c.trim()))
    .filter(Boolean);
  const targets = Array.from(new Set(rawTargets)).slice(0, MAX_LANGS_PER_REQUEST);
  if (targets.length === 0) {
    console.log('[translate] pipeline skip: no targets after normalization');
    return { subs: input.subs, translated: false, log };
  }

  const baseUrl = resolveTranslateBaseUrl(input.config);
  const model = resolveTranslateModel(input.config);
  const translate = input.translate ?? ((req) => provider.translate(
    { apiKey: apiKey ?? '', baseUrl, model, timeoutMs: input.perCallTimeoutMs ?? PER_CALL_TIMEOUT_DEFAULT },
    req,
  ));

  console.log(`[translate] using provider: ${providerName}`);

  const presentLangs = new Set(
    input.subs
      .map((s) => (s.normLang ?? '').toLowerCase())
      .filter(Boolean),
  );
  const missingTargets = targets.filter((t) => !presentLangs.has(t));
  if (missingTargets.length === 0) {
    return { subs: input.subs, translated: false, log };
  }

  // Pick the best upstream sub as translation source. Prefer English,
  // fall back to first available.
  const sourceSub = pickBestSource(input.subs);
  if (!sourceSub) {
    for (const t of missingTargets) {
      log.push({ target: t, source: '', status: 'no-source' });
    }
    return { subs: input.subs, translated: false, log };
  }
  const sourceLang = normalizeLangForPipeline(
    (sourceSub.normLang ?? sourceSub.lang ?? '').trim(),
  );
  const sourceCacheKey = resolveRealUrl(sourceSub.url);
  if (!sourceLang || !sourceCacheKey) {
    for (const t of missingTargets) {
      log.push({ target: t, source: sourceLang, status: 'no-source' });
    }
    return { subs: input.subs, translated: false, log };
  }

  const newSubs: LingarrSourceSub[] = [];
  let translatedAny = false;
  for (const target of missingTargets) {
    if (target === sourceLang) continue;

    // 1. Cache lookup
    const cached = getCachedTranslation(providerName, sourceCacheKey, sourceLang, target);
    if (cached) {
      log.push({ target, source: sourceLang, status: 'cache-hit' });
      newSubs.push(buildSyntheticSub(sourceSub, target, cached));
      translatedAny = true;
      continue;
    }

    // 2. Download + parse the source sub (upstream URL).
    const subContent = await fetchText(sourceCacheKey);
    if (!subContent) {
      console.log(`[translate] source fetch failed: ${sourceSub.id} url=${sourceCacheKey.slice(0, 120)} (raw=${(sourceSub.url || '').slice(0, 60)})`);
      log.push({ target, source: sourceLang, status: 'failed', detail: 'source fetch failed' });
      continue;
    }
    const fmt: SubtitleFormat = sourceSub.format ?? 'srt';
    const parsed = parseSubtitle(subContent, fmt);
    if (parsed.length === 0) {
      log.push({ target, source: sourceLang, status: 'failed', detail: 'source parse empty' });
      continue;
    }

    // 3. Translate in chunks. Cloud LLMs (Gemini/DeepL/OpenAI) handle
    //    100 cues per call in 1-3s; local LLMs (Ollama 7-9B) need 30.
    //    Per-chunk cache lets a timed-out request resume from where it
    //    left off instead of re-translating the whole sub.
    const perCallTimeout = input.perCallTimeoutMs ?? PER_CALL_TIMEOUT_DEFAULT;
    const isLocalLlm = providerName === 'ollama' || /\bollama\b|\blocalai\b|\blm[ _-]?studio\b/i.test(model ?? '') || /\bollama\b|\blocalai\b/i.test(baseUrl ?? '');
    const chunkSize = isLocalLlm ? 30 : 100;
    const concurrency = isLocalLlm ? 5 : 3;

    // Load any previously-translated lines for resume
    const cachedLines = getCachedChunkLines(providerName, sourceCacheKey, sourceLang, target);
    const skipPositions = new Set<number>(cachedLines.keys());

    const chunked = await translateInChunks({
      sourceLanguage: sourceLang,
      targetLanguage: target,
      entries: parsed,
      callProvider: async (batch) => {
        const req: ProviderRequest = {
          sourceLanguage: sourceLang,
          targetLanguage: target,
          lines: batch,
        };
        const result = await translate(req);
        return result.ok ? result.lines : new Map();
      },
      onLineTranslated: (globalPos, text) => {
        // Persist each line so a future request can resume from here
        const chunkIdx = Math.floor((globalPos - 1) / chunkSize);
        setCachedChunkLine(providerName, sourceCacheKey, sourceLang, target, chunkIdx, globalPos, text);
      },
      skipPositions,
      format: fmt,
      timeoutMs: perCallTimeout,
      concurrency,
      chunkSize,
    });
    console.log(`[translate] ${target}: ${chunked.successChunks}/${chunked.totalChunks} chunks ok (${parsed.length} cues, ${cachedLines.size} resumed, provider=${providerName})`);
    if (chunked.lines.size === 0) {
      log.push({
        target, source: sourceLang, status: 'failed',
        detail: `0/${chunked.totalChunks} chunks succeeded`, provider: providerName,
      });
      continue;
    }

    // 4. Stitch translated lines onto source timestamps
    const translatedEntries = stitchEntries(parsed, chunked.lines);
    if (chunked.complete) {
      setCachedTranslation(
        providerName,
        sourceCacheKey,
        sourceLang,
        target,
        {
          entries: translatedEntries,
          format: fmt,
          provider: providerName,
        },
      );
    }
    newSubs.push(buildSyntheticSub(sourceSub, target, {
      entries: translatedEntries,
      format: fmt,
      sourceLang,
      targetLang: target,
      provider: providerName,
    }));
    log.push({ target, source: sourceLang, status: 'translated', detail: `${chunked.successChunks}/${chunked.totalChunks} chunks`, provider: providerName });
    translatedAny = true;
  }

  return { subs: [...input.subs, ...newSubs], translated: translatedAny, log };
}
