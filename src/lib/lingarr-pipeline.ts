/**
 * Lingarr translation pipeline.
 *
 * Given the upstream sub list, fills missing target languages by translating
 * the best source sub via Lingarr. Caches results in lingarr-cache; serves
 * the translated body through the existing /alignedsub/:token.:ext endpoint
 * (same mechanism as the offset-aligned sub cache).
 *
 * Pure orchestration: no Express, no res object. The route module wires it in
 * and handles the response side.
 */

import { fetchText } from './proxy.js';
import { resolveRealUrl } from './proxy-resolve.js';
import { parseSubtitle, SubtitleEntry, SubtitleFormat } from './subtitle-parser.js';
import { resolveLingarrUrl, resolveLingarrApiKey, AddonConfig } from '../config.js';
import {
  buildTranslateRequest, translateContent, MediaType, pingLingarr,
} from './lingarr.js';
import {
  getCachedTranslation, setCachedTranslation, CachedTranslation,
} from './lingarr-cache.js';

export interface LingarrPipelineInput {
  /** Upstream sub list (after dedupe + format detect). */
  subs: LingarrSourceSub[];
  /** Effective config (already-decoded from manifest URL). */
  config: AddonConfig;
  /**
   * Remaining time budget for the request (ms). Translation is skipped when
   * the budget is too low to finish one round-trip.
   */
  budgetMs: number;
  /** Hard cap per Lingarr call (ms). */
  perCallTimeoutMs?: number;
  /**
   * Injectable for tests. Defaults to the global fetch-based translateContent.
   */
  translate?: typeof translateContent;
  /**
   * Injectable for tests. Defaults to fetchText.
   */
  fetchSubContent?: typeof fetchText;
  /** Media type to send to Lingarr (defaults to 'Movie'). */
  mediaType?: MediaType;
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
  status: 'cache-hit' | 'translated' | 'skipped-budget' | 'no-source' | 'failed' | 'unavailable';
  detail?: string;
}

const PER_CALL_TIMEOUT_DEFAULT = 30_000;
/** Skip Lingarr work when the request budget has less than this much left. */
const MIN_BUDGET_MS = 4_000;
/** Per-language hard cap on Lingarr round-trips for a single request. */
const MAX_LANGS_PER_REQUEST = 5;

export async function runLingarrPipeline(
  input: LingarrPipelineInput,
): Promise<LingarrPipelineOutput> {
  const log: LingarrLogEntry[] = [];
  const baseUrl = resolveLingarrUrl(input.config);
  if (!baseUrl) {
    return { subs: input.subs, translated: false, log };
  }
  if (input.budgetMs < MIN_BUDGET_MS) {
    return { subs: input.subs, translated: false, log };
  }
  const targets = (input.config.translateTargets ?? [])
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, MAX_LANGS_PER_REQUEST);
  if (targets.length === 0) {
    return { subs: input.subs, translated: false, log };
  }

  // Probe Lingarr liveness once per request; if it fails, do not waste time
  // pinging per language. Cache probe result in a closure to keep the hot path
  // fast on misses.
  let probed = false;
  let available = true;
  const ensureAvailable = async (): Promise<boolean> => {
    if (probed) return available;
    probed = true;
    available = await pingLingarr(baseUrl, resolveLingarrApiKey(input.config));
    if (!available) {
      for (const t of targets) log.push({ target: t, source: '', status: 'unavailable' });
    }
    return available;
  };

  const apiKey = resolveLingarrApiKey(input.config);
  const translate = input.translate ?? translateContent;
  const fetchSubContent = input.fetchSubContent ?? fetchText;

  const presentLangs = new Set(
    input.subs
      .map((s) => (s.normLang ?? '').toLowerCase())
      .filter(Boolean),
  );
  const missingTargets = targets.filter((t) => !presentLangs.has(t));
  if (missingTargets.length === 0) {
    return { subs: input.subs, translated: false, log };
  }

  const source = pickBestSource(input.subs);
  if (!source) {
    for (const t of missingTargets) {
      log.push({ target: t, source: '', status: 'no-source' });
    }
    return { subs: input.subs, translated: false, log };
  }

  const sourceLang = (source.normLang ?? '').toLowerCase();
  const realSourceUrl = resolveRealUrl(source.url);

  const newSubs: LingarrSourceSub[] = [];
  let translatedAny = false;
  for (const target of missingTargets) {
    if (target === sourceLang) continue;
    if (!(await ensureAvailable())) break;

    // 1. Cache lookup (keyed by real URL + lang pair)
    const cached = getCachedTranslation(realSourceUrl, sourceLang, target);
    if (cached) {
      log.push({ target, source: sourceLang, status: 'cache-hit' });
      newSubs.push(buildSyntheticSub(source, target, cached));
      translatedAny = true;
      continue;
    }

    // 2. Download + parse source sub
    const subContent = await fetchSubContent(realSourceUrl);
    if (!subContent) {
      log.push({ target, source: sourceLang, status: 'failed', detail: 'source fetch failed' });
      continue;
    }
    const fmt: SubtitleFormat = source.format ?? 'srt';
    const entries = parseSubtitle(subContent, fmt);
    if (entries.length === 0) {
      log.push({ target, source: sourceLang, status: 'failed', detail: 'source parse empty' });
      continue;
    }

    // 3. Build request and translate
    const request = buildTranslateRequest(
      entries, sourceLang, target, input.mediaType ?? 'Movie',
    );
    const result = await translate(
      { baseUrl, apiKey, timeoutMs: input.perCallTimeoutMs ?? PER_CALL_TIMEOUT_DEFAULT },
      request,
    );
    if (!result.ok || result.lines.size === 0) {
      log.push({ target, source: sourceLang, status: 'failed' });
      continue;
    }

    // 4. Stitch translated lines back onto source timestamps
    const translatedEntries: SubtitleEntry[] = entries.map((e, i) => {
      const line = result.lines.get(i + 1);
      return {
        start: e.start,
        end: e.end,
        text: line ?? e.text,
      };
    });
    const value: CachedTranslation = {
      entries: translatedEntries,
      format: fmt,
      sourceLang,
      targetLang: target,
    };
    setCachedTranslation(realSourceUrl, sourceLang, target, value);
    newSubs.push(buildSyntheticSub(source, target, value));
    log.push({ target, source: sourceLang, status: 'translated' });
    translatedAny = true;
  }

  return { subs: [...input.subs, ...newSubs], translated: translatedAny, log };
}

/**
 * Prefer English for translation source; fall back to the first sub in the
 * upstream list. Translated subs will be skipped (we don't translate X→X).
 */
function pickBestSource(subs: LingarrSourceSub[]): LingarrSourceSub | null {
  if (subs.length === 0) return null;
  const eng = subs.find((s) => {
    const lang = (s.normLang ?? '').toLowerCase();
    return lang === 'en' || lang === 'eng';
  });
  return eng ?? subs[0];
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
