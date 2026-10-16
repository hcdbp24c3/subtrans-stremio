import { Router, Request, Response } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import {
  detectFormat, sniffFormat, parseSubtitle, SubtitleFormat, SubtitleEntry,
} from '../lib/subtitle-parser.js';
import {
  calculateOffsetSmart, adjustEntries,
  isFfsubsyncAvailable,
  probeVideoInfoAsync, SmartOffsetResult, VideoProbeResult,
} from '../lib/aligner.js';
import { calculateOffsetFast, FastOffsetResult } from '../lib/align-fast.js';
import { detectFileExt } from './subtitle-ext.js';
import { createTtlStore } from '../lib/ttl-store.js';
import { resolveRealUrl } from '../lib/proxy-resolve.js';
import { runLingarrPipeline, LingarrSourceSub } from '../lib/translate-pipeline.js';

const router = Router();

const MAX_SUBS_PER_LANG = 5;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SUB_DOWNLOAD_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const subDownloadCache = createTtlStore<{ body: Buffer; contentType: string }>(100);
// Aligned (offset-applied) subtitle bodies keyed by token — Nuvio needs http(s) URLs, not data:
const alignedSubCache = createTtlStore<{ body: Buffer; contentType: string }>(100);
const ALIGNED_SUB_TTL_MS = 30 * 60 * 1000; // ≥ subtitle list cache TTL

// Nuvio client aborts each addon after 30s; Stremio web ~60s. Use 25s to
// leave a 5s margin while still fitting probe + audio extract + ffsubsync
// + translate + apply in a single request. Translation of N target langs
// adds at most a few seconds; ffsubsync cascade is the longest pole.
export const HANDLER_BUDGET_MS = 25_000;
const RESPONSE_MARGIN_MS = 2_000;
const MIN_ALIGN_WAIT_MS = 3_000;   // don't bother racing alignment under this
const MIN_APPLY_MS = 4_000;        // need time to re-download + adjust subs
const PROBE_MIN_MS = 4_000;        // skip ffprobe when the budget is already tight
const TRANSLATE_MIN_MS = 3_000;    // skip translate when budget is too tight

let ffsubsyncAvailable: boolean | null = null;
function ffsubsyncReady(): boolean {
  if (ffsubsyncAvailable === null) {
    ffsubsyncAvailable = isFfsubsyncAvailable();
  }
  return ffsubsyncAvailable;
}

function sleep(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), Math.max(0, ms)));
}

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
  _format?: SubtitleFormat;
  _source?: number; // index of the sub addon that provided this subtitle
  _releaseName?: string; // release name of the sub (for matching with video)
  _aligned?: boolean; // internal: body cached under aligned:<token> → /alignedsub/
  /**
   * Pre-built subtitle entries (translation pipeline output). When present,
   * the route serializes them directly and serves via /alignedsub/<token>.
   * Bypasses the normal subdownload fetch.
   */
  _entries?: SubtitleEntry[];
}

interface StreamResponse {
  streams: Array<{
    url?: string;
    title?: string;
    infoHash?: string;
    behaviorHints?: { filename?: string };
  }>;
}

interface Manifest {
  id: string;
  transportUrl?: string;
}

// ── Cache ──────────────────────────────────────────────────────────
interface CacheEntry {
  data: { subtitles: Subtitle[] };
  expires: number;
}

const cache = new Map<string, CacheEntry>();

// Separate offset cache: keyed by video URL (reusable across requests)
const offsetCache = new Map<string, { offset: number; expires: number }>();
const OFFSET_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getOffsetFromCache(videoUrl: string): number | null {
  const entry = offsetCache.get(videoUrl);
  if (!entry) return null;
  if (Date.now() > entry.expires) { offsetCache.delete(videoUrl); return null; }
  console.log(`[subtitle] Using cached offset: ${entry.offset.toFixed(1)}s for this video`);
  return entry.offset;
}

/** Cache offset whenever alignment completed — including 0 (already synced). */
function setOffsetCache(videoUrl: string, offset: number): void {
  if (offsetCache.size > 50) {
    const oldest = offsetCache.keys().next().value;
    if (oldest) offsetCache.delete(oldest);
  }
  offsetCache.set(videoUrl, { offset, expires: Date.now() + OFFSET_CACHE_TTL });
  console.log(`[subtitle] Offset cached for this video: ${offset.toFixed(3)}s`);
}

function cacheKey(config: AddonConfig, type: string, id: string): string {
  return `${config.streamUrls.join(',')}|${config.subUrls.join(',')}|${type}|${id}`;
}

function getFromCache(key: string): { subtitles: Subtitle[] } | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: { subtitles: Subtitle[] }): void {
  if (cache.size > 200) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ── Helpers ────────────────────────────────────────────────────────

async function getUpstreamBaseUrl(manifestUrl: string): Promise<string> {
  const manifest = await fetchJson<Manifest>(manifestUrl);
  if (manifest?.transportUrl) return manifest.transportUrl;
  return manifestUrl.replace(/\/manifest\.json$/, '');
}

// ISO 639-2/B → 639-1 mapping for common subtitle languages
const ISO639_2_TO_1: Record<string, string> = {
  eng: 'en', vie: 'vi', jpn: 'ja', kor: 'ko', zho: 'zh', tha: 'th',
  ind: 'id', msa: 'ms', fra: 'fr', deu: 'de', spa: 'es', por: 'pt',
  ita: 'it', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl',
  nld: 'nl', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', ukr: 'uk',
  ces: 'cs', ell: 'el', ron: 'ro', hun: 'hu', heb: 'he',
};

/** Normalize any language code (639-1 or 639-2) to 639-1 */
function normalizeLang(code: string): string {
  const lower = code.toLowerCase().trim();
  if (lower.length <= 2) return lower;            // already 639-1
  return ISO639_2_TO_1[lower] ?? lower;           // map or keep
}

function filterByLanguage(subs: Subtitle[], languages: string): Subtitle[] {
  if (!languages) return subs;
  const allowed = new Set(
    languages.split(',').map((l) => normalizeLang(l)).filter(Boolean)
  );
  return subs.filter((s) => {
    const lang = normalizeLang(s.lang || '');
    return allowed.has(lang);
  });
}

function limitPerLanguage(subs: Subtitle[], limit: number): Subtitle[] {
  const counts = new Map<string, number>();
  return subs.filter((s) => {
    const lang = normalizeLang(s.lang || 'unknown');
    const count = counts.get(lang) || 0;
    if (count >= limit) return false;
    counts.set(lang, count + 1);
    return true;
  });
}

/** Drop duplicate subtitle entries by exact URL, keeping first occurrence. */
export function dedupeSubtitles(subs: Subtitle[]): Subtitle[] {
  const seen = new Set<string>();
  return subs.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

// ── Route ──────────────────────────────────────────────────────────
// Stremio appends extra path segments to subtitle URLs:
//   /subtitles/movie/tt27681354/filename=...mkv&videoSize=...json
// Use wildcard to capture the full path after /subtitles/:type/
//
// We accept the config in three forms for max compatibility:
//   1. /subtitles/<type>/<id>.json?config=...   (legacy query string)
//   2. /<config>/subtitles/<type>/<id>.json     (path segment, base64url)
// The path-segment form matches Stremio's protocol convention for
// "extra args" (see protocol.md "/{resource}/{type}/{id}/{extraArgs}.json
// where extraArgs is the query string stringified object").

const PATH_SEGMENT_RE = '[A-Za-z0-9_-]+'; // base64url charset

function decodePathConfig(seg: string | undefined): string | undefined {
  if (!seg) return undefined;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Extract a release name from a subtitle URL when the upstream addon
 * omits the metadata. Looks at the last URL path segment, strips
 * extension + common query params, and decodes percent-encoding.
 * Example: https://cdn.example.com/movies/In.The.Grey.2026.BluRay.x265.srt
 *        → "In.The.Grey.2026.BluRay.x265"
 */
export function extractReleaseNameFromUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || '';
    const dot = last.lastIndexOf('.');
    // Only strip if the suffix looks like a subtitle/video extension
    const ext = dot >= 0 ? last.slice(dot + 1).toLowerCase() : '';
    const looksLikeFile = ['srt', 'vtt', 'ass', 'ssa', 'mkv', 'mp4', 'avi', 'ts', 'sub', 'txt'].includes(ext);
    const base = looksLikeFile ? last.slice(0, dot) : last;
    let decoded = base;
    try { decoded = decodeURIComponent(base); } catch { /* keep raw */ }
    // Skip purely numeric IDs (e.g. /1962380715)
    if (/^\d+$/.test(decoded)) return '';
    return decoded;
  } catch {
    return '';
  }
}

async function subtitlesHandler(req: Request, res: Response) {
  const startedAt = Date.now();
  const budgetLeftMs = () => HANDLER_BUDGET_MS - (Date.now() - startedAt);

  let configStr: string | undefined;
  const pathConfig = (req.params as { config?: string }).config;
  if (pathConfig) {
    configStr = decodePathConfig(pathConfig);
  } else {
    const raw = req.query.config;
    const first = Array.isArray(raw) ? raw[0] : raw;
    configStr = typeof first === 'string' ? first : undefined;
  }
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  // Wildcard captures everything after /subtitles/:type/
  // e.g. "tt27681354/filename=...mkv&videoSize=...json"
  const wildcard = (req.params as any)[0] || '';
  const rawId = wildcard.split('/')[0];
  const decodedId = decodeURIComponent(rawId).replace(/\.json$/, '');
  const { type: paramType } = req.params;
  const type = Array.isArray(paramType) ? paramType[0] : paramType;

  // 1. Check cache
  const key = cacheKey(config, type, decodedId);
  const cached = getFromCache(key);
  if (cached) {
    res.json(cached);
    return;
  }

  // 2. Fetch stream + probe video info + fetch subs — ALL IN PARALLEL
  let videoDuration: number | null = null;
  let videoUrl: string | null = null;
  let videoFilename: string | null = null;
  let videoProbe: VideoProbeResult | null = null;

  // 2a. Fetch stream info (to get video URL + filename)
  const streamPromise = (async () => {
    if (config.streamUrls.length === 0) return;
    try {
      const streamBaseUrl = await getUpstreamBaseUrl(config.streamUrls[0]);
      const upstreamStreamUrl = `${streamBaseUrl}/stream/${type}/${decodedId}.json`;
      const streamResponse = await fetchJson<StreamResponse>(upstreamStreamUrl);
      const bestStream = streamResponse?.streams?.[0];
      if (bestStream) {
        videoUrl = bestStream.url ?? null;
        videoFilename = bestStream.behaviorHints?.filename ?? bestStream.title ?? null;
      }
    } catch (e: any) {
      console.log(`[subtitle] Stream fetch failed: ${e.message}`);
    }
  })();

  // 2b. Fetch subtitles from ALL upstream sub addons in parallel
  const subPromise = Promise.allSettled(
    config.subUrls.map(async (subUrl, sourceIdx) => {
      const subBaseUrl = await getUpstreamBaseUrl(subUrl);
      const upstreamSubUrl = `${subBaseUrl}/subtitles/${type}/${decodedId}.json`;
      const data = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);
      const subs = data?.subtitles || [];
      return subs.map((s) => {
        // Prefer upstream's releaseName/fileName; fall back to extracting
        // the filename from the URL path so the fast-align engine can still
        // match against the video. Many sub addons omit the metadata
        // field but encode the release in the URL path itself.
        const raw = (s as any).releaseName || (s as any).fileName || '';
        const releaseName = raw || extractReleaseNameFromUrl((s as any).url || '');
        return {
          ...s,
          _source: sourceIdx,
          _releaseName: releaseName,
        } as Subtitle;
      });
    })
  );

  // Wait for stream info first (we need videoUrl for offset cache / probe)
  await streamPromise;

  // 2c. Offset cache first — skip everything else on hit.
  let offset = 0;
  let offsetFromCache = false;
  if (videoUrl) {
    const cachedOffset = getOffsetFromCache(videoUrl);
    if (cachedOffset !== null) {
      offset = cachedOffset;
      offsetFromCache = true;
    }
  }

  // Wait for subs (parallel with stream)
  const subResults = await subPromise;

  const sourceSubs: Subtitle[] = subResults
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => (r as PromiseFulfilledResult<Subtitle[]>).value);

  console.log(`[subtitle] Fetched ${sourceSubs.length} subs from ${config.subUrls.length} addon(s)`);

  if (sourceSubs.length === 0 && config.translateTargets.length === 0) {
    console.log(`[subtitle] No upstream subs; configure a sub addon (OpenSubtitles, Stremio Community Subs, etc.)`);
    res.json({ subtitles: [] });
    return;
  }

  // Detect format for source subs (BEFORE URL rewrite). Display list
  // inherits these.
  const sourceWithFormat: Subtitle[] = sourceSubs.map((sub) => ({
    ...sub,
    _format: detectFormat(sub.url) || undefined,
  })) as Subtitle[];

  // Display list = language-filtered + deduped + per-lang limited. The
  // translation pipeline reads the unfiltered sourceSubs so it can pick an
  // English source even when the user's display filter is narrow.
  let allSubs: Subtitle[] = filterByLanguage(sourceWithFormat, config.languages);
  allSubs = limitPerLanguage(allSubs, MAX_SUBS_PER_LANG);
  const beforeDedupe = allSubs.length;
  allSubs = dedupeSubtitles(allSubs);
  if (allSubs.length !== beforeDedupe) {
    console.log(`[subtitle] Deduped ${beforeDedupe - allSubs.length} duplicate URL(s)`);
  }
  if (sourceSubs.length !== allSubs.length) {
    console.log(`[subtitle] Display filter: ${allSubs.length}/${sourceSubs.length} subs (languages="${config.languages || '*'}")`);
  }

  // ────────────────────────────────────────────────────────────────────
  // Parallel pipeline: probe + translate + ffsubsync run concurrently.
  // Translation uses sourceWithFormat (unfiltered, format-detected) so it
  // can pick an English source even when the display filter is narrow.
  // Offset is applied to the translated entries AFTER alignment completes
  // — translated subs inherit the source sub's timing, so the same offset
  // must shift them by the same amount.
  // ────────────────────────────────────────────────────────────────────
  const canAlign = !!videoUrl && !offsetFromCache && ffsubsyncReady() && budgetLeftMs() > PROBE_MIN_MS;
  const canProbe = !!videoUrl && (canAlign || (
    config.translateTargets.length > 0
    && (config.subUrls.length === 0 || config.subUrls.every((u) => !u || u === 'x'))
  ));

  // 2c.i Probe (separate from align so it can run in parallel with translate)
  const probePromise: Promise<VideoProbeResult | null> = (async () => {
    if (!videoUrl || !canProbe) return null;
    try {
      const r = await probeVideoInfoAsync(videoUrl);
      console.log(`[subtitle] Video: filename="${videoFilename}", duration=${r.duration != null ? `${r.duration.toFixed(1)}s` : 'unknown'}, textSubStreams=${r.subtitleStreams.length}`);
      return r;
    } catch {
      return null;
    }
  })();

  // 2c.ii Align: ffsubsync against best English source. Returns offset (or
  // null on failure/timeout). Runs in parallel with translate so the total
  // request fits in budget.
  let alignPromise: Promise<{ offset: number; completed: boolean; method?: string } | null> = Promise.resolve(null);
  const willAlign = canAlign && sourceWithFormat.length > 0;
  if (willAlign) {
    alignPromise = (async () => {
      // 1. Try fast engine (release-name, sub-consensus, minimal-vad).
      //    These are free or <2s and cover most real-world cases.
      const probe = await probePromise;
      const videoDuration = probe?.duration ?? null;
      const fastBudget = Math.max(2_000, budgetLeftMs() - 8_000);
      // Diagnostic: log what fast-align saw
      const releaseNames = sourceWithFormat.slice(0, 5).map((s) => ({
        id: s.id,
        lang: s.lang || '',
        url: (s.url || '').slice(-80),
        release: s._releaseName || '',
      }));
      console.log(`[subtitle] fast-align: video="${videoFilename}", sourceSubs=${sourceWithFormat.length}, samples=${JSON.stringify(releaseNames)}`);
      const fast = await calculateOffsetFast(
        videoUrl!,
        videoFilename,
        videoDuration,
        sourceWithFormat,
        fastBudget,
      );
      if (fast && fast.score >= 0.5) {
        setOffsetCache(videoUrl!, fast.offset);
        console.log(
          `[subtitle] fast-align: offset=${fast.offset.toFixed(3)}s via ${fast.method}` +
          (fast.offset === 0 ? ' (already synced)' : ''),
        );
        return { offset: fast.offset, completed: true, method: fast.method };
      }
      console.log(`[subtitle] fast-align: not confident${fast ? ` (best=${fast.method}@${fast.score.toFixed(2)})` : ''}, escalating to ffsubsync`);

      // 2. Fall back to ffsubsync (slow but reliable). Try the best
      //    English sub first, then up to 3 more English subs in case
      //    the first URL is dead (CDN/auth/redirect issues).
      const englishSubs = sourceWithFormat
        .filter((s) => {
          const l = (s.lang || '').toLowerCase();
          return l === 'en' || l === 'eng';
        })
        .slice(0, 4);
      const candidates = englishSubs.length > 0 ? englishSubs : sourceWithFormat.slice(0, 4);
      for (const candidate of candidates) {
        const realUrl = resolveRealUrl(candidate.url);
        console.log(`[subtitle] ffsubsync: trying ${candidate.id} (url=${realUrl.slice(-60)})`);
        const subContent = await fetchText(realUrl);
        if (!subContent) {
          console.log(`[subtitle] ffsubsync: could not fetch ${candidate.id}, trying next`);
          continue;
        }
        const fmt = (candidate._format || 'srt') as SubtitleFormat;
        let analysisSrt = subContent;
        if (fmt !== 'srt') {
          const entries = parseSubtitle(subContent, fmt);
          if (entries.length > 0) analysisSrt = reSerialize(entries, 'srt') || subContent;
        }
        console.log(`[subtitle] ffsubsync: syncing ${candidate.id} (${analysisSrt.length}B) against video audio...`);
        const align = await calculateOffsetSmart(
          videoUrl!,
          analysisSrt,
          probe?.subtitleStreams ?? [],
        );
        if (align.completed) {
          setOffsetCache(videoUrl!, align.offset);
          console.log(
            `[subtitle] ffsubsync: offset=${align.offset.toFixed(3)}s via ${align.method}` +
            (align.offset === 0 ? ' (already synced)' : ''),
          );
        } else {
          console.log(`[subtitle] ffsubsync: no definitive offset via ${align.method || 'cascade'}`);
        }
        return { offset: align.offset, completed: align.completed, method: align.method };
      }
      console.log(`[subtitle] ffsubsync: all ${candidates.length} candidates failed to fetch`);
      return null;
    })().catch((e: any) => {
      console.log(`[subtitle] align: error: ${e?.message?.substring(0, 200)}`);
      return null;
    });
  }

  // 2c.iii Translate: can run in parallel with align. If align finishes
  // first, the translated entries get the same offset applied to the
  // source sub's timestamps — so the output is correctly aligned.
  let translatePromise: Promise<{ input: LingarrSourceSub[]; translated: Subtitle[] } | null> = Promise.resolve(null);
  if (config.translateTargets.length === 0) {
    // No targets — skip
  } else if (budgetLeftMs() < TRANSLATE_MIN_MS) {
    console.log(`[translate] skip: budget low (${budgetLeftMs()}ms < ${TRANSLATE_MIN_MS}ms)`);
  } else {
    const translateInput: LingarrSourceSub[] = sourceWithFormat.map((s) => ({
      id: s.id,
      url: s.url,
      lang: s.lang,
      format: s._format,
      normLang: s.lang ? normalizeLang(s.lang) : '',
    }));
    console.log(`[translate] running: targets=[${config.translateTargets.join(',')}] sourceSubs=${translateInput.length} budgetMs=${budgetLeftMs()}`);
    translatePromise = (async () => {
      const out = await runLingarrPipeline({
        subs: translateInput,
        config,
        budgetMs: budgetLeftMs(),
      });
      if (out.translated) {
        const newSubs: Subtitle[] = out.subs
          .filter((s) => !translateInput.some((orig) => orig.id === s.id && orig.url === s.url))
          .map((s) => ({
            id: s.id,
            url: s.url,
            lang: s.lang,
            _format: s.format,
            _entries: s.entries,
          }));
        const cacheHitCount = out.log.filter((l) => l.status === 'cache-hit').length;
        const freshCount = out.log.filter((l) => l.status === 'translated').length;
        console.log(`[translate] inserted ${newSubs.length} translated sub(s): ${cacheHitCount} cache, ${freshCount} fresh`);
        for (const entry of out.log) {
          console.log(`[translate] ${entry.target} ← ${entry.source || '?'} ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`);
        }
        return { input: translateInput, translated: newSubs };
      } else if (out.log.length > 0) {
        console.log(`[translate] no translation: ${out.log.length} log entries`);
        for (const entry of out.log) {
          console.log(`[translate] ${entry.target} ← ${entry.source || '?'} ${entry.status}${entry.detail ? ` (${entry.detail})` : ''}`);
        }
      }
      return null;
    })().catch((e: any) => {
      console.log(`[translate] error: ${e?.message?.substring(0, 200)}`);
      return null;
    });
  }

  // Wait for translate first — it's usually the longest pole and we need
  // its output to know whether to apply offset to translated subs.
  const translateResult = await translatePromise;
  if (translateResult) {
    allSubs = [...allSubs, ...translateResult.translated];
    allSubs = limitPerLanguage(allSubs, MAX_SUBS_PER_LANG);
  }

  // Wait for align — usually finishes in ~3-6s when ffsubsync finds
  // built-in subs; ~10-20s with audio extraction.
  let listCacheable = true;
  const remainingForAlign = budgetLeftMs() - RESPONSE_MARGIN_MS;
  if (willAlign && remainingForAlign > 0) {
    if (remainingForAlign < MIN_ALIGN_WAIT_MS) {
      console.log(`[subtitle] time budget low for align — letting it finish in background, serving with offset=${offset}`);
      alignPromise.catch(() => {}); // fire-and-forget warm
      listCacheable = false;
    } else {
      const alignResult = await Promise.race([
        alignPromise,
        sleep(remainingForAlign),
      ]);
      if (alignResult === null) {
        // Timed out — keep waiting in background to warm cache
        alignPromise.catch(() => {});
        listCacheable = false;
        console.log(`[subtitle] alignment exceeded budget — serving with offset=${offset}, warming in background`);
      } else {
        offset = alignResult.offset;
        if (!alignResult.completed) listCacheable = false;
      }
    }
  } else if (willAlign) {
    listCacheable = false;
  }

  // 7. If offset detected, apply to all subs (including translated ones
  //    that carry `_entries`). Parallel downloads; race against the
  //    remaining budget so Nuvio never hangs.
  let alignedSubtitles: Subtitle[] = allSubs;
  if (offset !== 0) {
    const remaining = budgetLeftMs() - RESPONSE_MARGIN_MS;
    if (remaining < MIN_APPLY_MS) {
      listCacheable = false;
      console.log(`[subtitle] offset=${offset.toFixed(1)}s known but no time to apply — serving unaligned`);
    } else {
      const applyPromise = applyOffsetToSubtitles(allSubs, offset);
      const raced = await Promise.race([applyPromise, sleep(remaining)]);
      if (raced === null) {
        applyPromise.catch(() => {});
        listCacheable = false;
        console.log(`[subtitle] applying offset exceeded budget — serving unaligned`);
      } else {
        alignedSubtitles = raced;
      }
    }
  } else {
    // No offset to apply — still need to materialize translated subs (which carry
    // `_entries` but no body) into the alignedSubCache so the URL rewrite below
    // can serve them via /alignedsub/<token>.<ext>.
    alignedSubtitles = await materializeTranslatedSubs(allSubs);
  }

  // 8. NOW rewrite URLs to proxy format (all content downloads are done)
  const base = `${req.protocol}://${req.headers.host || 'localhost'}`;
  const configParam = encodeURIComponent(encodeConfig(config));
  const finalSubtitles = alignedSubtitles.map((sub) => {
    // Aligned content: serve via HTTP endpoint (Nuvio cannot read data: URLs)
    if (sub._aligned && sub.url.startsWith('aligned:')) {
      const token = sub.url.slice('aligned:'.length);
      return {
        ...sub,
        url: `${base}/alignedsub/${token}.srt`,
      };
    }
    // Skip proxy URLs (already rewritten)
    if (sub.url.startsWith(base)) {
      return { ...sub };
    }
    const ext = detectFileExt(sub.url);
    return {
      ...sub,
      url: `${base}/subdownload${ext}?url=${encodeURIComponent(sub.url)}&config=${configParam}`,
    };
  });
  // Strip internal fields — clients (Moshi/etc.) only need id/url/lang
  const result = {
    subtitles: finalSubtitles.map(
      ({ _format, _aligned, _source, _releaseName, _entries, ...rest }) => rest,
    ),
  };
  if (listCacheable) {
    setCache(key, result);
  } else {
    console.log(`[subtitle] list not cached (alignment pending/incomplete)`);
  }

  // Final summary for log analysis
  const langCounts: Record<string, number> = {};
  for (const s of result.subtitles) {
    const l = s.lang || 'unknown';
    langCounts[l] = (langCounts[l] || 0) + 1;
  }
  console.log(`[subtitle] response: ${result.subtitles.length} subs [${Object.entries(langCounts).map(([l, c]) => `${l}:${c}`).join(', ')}], offset=${offset.toFixed(2)}s, listCacheable=${listCacheable}`);

  res.json(result);
}

router.get('/subtitles/:type/*', subtitlesHandler);
// Path-segment config: /<config>/subtitles/<type>/<id>.json
router.get(`/:config(${PATH_SEGMENT_RE})/subtitles/:type/*`, subtitlesHandler);

/** Re-download each subtitle, apply offset, cache aligned SRT under /alignedsub/. */
async function applyOffsetToSubtitles(subs: Subtitle[], offset: number): Promise<Subtitle[]> {
  return Promise.all(
    subs.map(async (sub) => {
      const format = (sub._format || 'srt') as SubtitleFormat | null;
      if (!format) return sub;
      try {
        let adjustedContent: string | null = null;
        if (sub._entries && sub._entries.length > 0) {
          // Translation pipeline already built entries — apply offset, re-serialize.
          // ASS body is always converted to SRT (Nuvio ICU-safe).
          const adjusted = adjustEntries(sub._entries, offset);
          adjustedContent = reSerialize(adjusted, format === 'ass' ? 'srt' : format);
        } else {
          const realUrl = resolveRealUrl(sub.url);
          const subContent = await fetchText(realUrl);
          if (!subContent) return sub;
          if (format === 'ass') {
            // Nuvio Android cannot parse ASS (ICU regex crash on unescaped }).
            // Convert to SRT after offsetting.
            const entries = parseSubtitle(subContent, 'ass');
            if (entries.length > 0) {
              adjustedContent = reSerialize(adjustEntries(entries, offset), 'srt');
            }
          } else {
            // SRT/VTT: parse → adjust → re-serialize
            const entries = parseSubtitle(subContent, format);
            if (entries.length > 0) {
              const adjusted = adjustEntries(entries, offset);
              adjustedContent = reSerialize(adjusted, format === 'vtt' ? 'srt' : format);
            }
          }
        }

        if (adjustedContent) {
          const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
          alignedSubCache.set(
            token,
            {
              body: Buffer.from(adjustedContent, 'utf-8'),
              contentType: 'text/plain; charset=utf-8',
            },
            ALIGNED_SUB_TTL_MS,
          );
          return {
            ...sub,
            url: `aligned:${token}`,
            _aligned: true,
          };
        }
      } catch (e: any) {
        console.log(`[subtitle] apply offset failed for one sub: ${e.message?.substring(0, 120)}`);
      }
      return sub;
    }),
  );
}

/**
 * Serialize pre-built `_entries` from the translation pipeline into
 * alignedSubCache so the URL rewrite step can serve them as HTTP bodies.
 * Subs without `_entries` (regular upstream subs) are passed through.
 * ASS is always converted to SRT for Nuvio Android safety.
 */
async function materializeTranslatedSubs(subs: Subtitle[]): Promise<Subtitle[]> {
  const out: Subtitle[] = [];
  for (const sub of subs) {
    if (!sub._entries || sub._entries.length === 0) {
      out.push(sub);
      continue;
    }
    const format = (sub._format || 'srt') as SubtitleFormat;
    const content = reSerialize(sub._entries, format === 'ass' ? 'srt' : format);
    if (!content) {
      out.push(sub);
      continue;
    }
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    alignedSubCache.set(
      token,
      { body: Buffer.from(content, 'utf-8'), contentType: 'text/plain; charset=utf-8' },
      ALIGNED_SUB_TTL_MS,
    );
    out.push({ ...sub, url: `aligned:${token}`, _aligned: true });
  }
  return out;
}

// ── Aligned subtitle content endpoint ──────────────────────────────
// Serves offset-applied SRT bodies stored during the /subtitles response.
// Nuvio/Stremio clients only fetch http(s) URLs — no data: support.
router.get('/alignedsub/:token.:ext', (req, res) => {
  const token = req.params.token;
  const ext = (req.params.ext || 'srt').toLowerCase();
  const hit = alignedSubCache.get(token);
  if (!hit) {
    res.status(404).json({ error: 'Aligned subtitle not found or expired' });
    return;
  }
  res.setHeader('Content-Type', ext === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=1800');
  res.send(hit.body);
});

// ── Subtitle download proxy ───────────────────────────────────────
// Upstream addons (SubSense) return 127.0.0.1 URLs that only work locally.
// This endpoint proxies the download so Nuvio/browser can fetch it.
// URL format: /subdownload.srt?url=...&config=...
// Extension is .srt/.vtt only — never .ass (Nuvio Android ICU regex crash).
// ASS upstream content is converted to SRT on the fly.
async function handleSubDownload(req: any, res: any) {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  try {
    let realUrl = decodeURIComponent(url);

    // SubSense wraps download URLs through its local proxy:
    //   http://127.0.0.1:11470/subtitles.srt?from=https://real-url...
    // Extract the actual download URL from the 'from' parameter
    try {
      const parsed = new URL(realUrl);
      const from = parsed.searchParams.get('from');
      if (from && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
        realUrl = from;
      }
    } catch {}

    const cacheKey = `${(req.params.ext || 'srt').toLowerCase()}|${realUrl}`;
    const hit = subDownloadCache.get(cacheKey);
    if (hit) {
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Subtitle-Cache', 'hit');
      res.send(hit.body);
      return;
    }
    console.log('[subdownload] Proxying:', realUrl.substring(0, 120));
    const response = await fetch(realUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36',
        'Referer': 'https://web.stremio.com/',
        'Accept': '*/*',
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      res.status(response.status).json({ error: `Upstream returned ${response.status}` });
      return;
    }

    // Set correct Content-Type based on file extension
    const ext = (req.params.ext || 'srt').toLowerCase();
    const mimeMap: Record<string, string> = {
      srt: 'text/plain; charset=utf-8',
      vtt: 'text/vtt; charset=utf-8',
      ass: 'text/x-ssa; charset=utf-8',
      ssa: 'text/x-ssa; charset=utf-8',
    };

    // Read content, strip BOM if present, then send
    if (response.body) {
      const chunks: Uint8Array[] = [];
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const buffer = Buffer.concat(chunks);
      const rawContent = buffer.toString('utf-8').replace(/^\uFEFF/, '');

      // Detect by CONTENT first (OpenSubtitles often has no extension).
      // Always convert ASS→SRT: Nuvio Android ICU crashes on ASS parser.
      const extHint = (ext === 'ass' || ext === 'ssa') ? 'ass' : ext;
      const upstreamFormat = sniffFormat(rawContent, extHint);
      let finalContent = rawContent;
      let finalContentType = mimeMap[ext] || 'text/plain; charset=utf-8';
      if (upstreamFormat === 'ass') {
        const entries = parseSubtitle(rawContent, 'ass');
        if (entries.length > 0) {
          const srtContent = reSerialize(entries, 'srt');
          if (srtContent) {
            finalContent = srtContent;
            finalContentType = 'text/plain; charset=utf-8';
          }
        }
      }

      const bodyBuf = Buffer.from(finalContent, 'utf-8');
      subDownloadCache.set(cacheKey, { body: bodyBuf, contentType: finalContentType }, SUB_DOWNLOAD_CACHE_TTL_MS);
      res.setHeader('Content-Type', finalContentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(bodyBuf);
      return;
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('[subdownload] Error:', err.message);
    res.status(502).json({ error: 'Failed to fetch subtitle', detail: err.message });
  }
}

// Both routes: /subdownload.srt and /subdownload (backward compat)
router.get('/subdownload.:ext', handleSubDownload);
router.get('/subdownload', handleSubDownload);

// ── Serialization helpers ──────────────────────────────────────────
function reSerialize(
  entries: Array<{ start: number; end: number; text: string }>,
  format: string
): string | null {
  if (format === 'srt') {
    return entries
      .map((e, i) => {
        const start = formatSrtTime(e.start);
        const end = formatSrtTime(e.end);
        return `${i + 1}\n${start} --> ${end}\n${e.text}`;
      })
      .join('\n\n');
  }

  if (format === 'vtt') {
    const body = entries
      .map((e) => {
        const start = formatVttTime(e.start);
        const end = formatVttTime(e.end);
        return `${start} --> ${end}\n${e.text}`;
      })
      .join('\n\n');
    return `WEBVTT\n\n${body}`;
  }

  // ASS/SSA content is converted to SRT in handleSubDownload (Nuvio ICU-safe)
  return null;
}

/** Format seconds to ASS timestamp H:MM:SS.cc */
function formatAssTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Parse ASS timestamp H:MM:SS.cc to seconds */
function parseAssTime(ts: string): number {
  const match = ts.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!match) return 0;
  return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 100;
}

/**
 * Adjust ASS/SSA timestamps in-place on raw content.
 * Only modifies Dialogue lines — preserves all styles, events, headers.
 */
export function adjustAssTimestamps(raw: string, offset: number): string {
  const lines = raw.split('\n');
  return lines.map(line => {
    if (!line.startsWith('Dialogue:')) return line;
    // ASS Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const parts = line.split(',');
    if (parts.length < 10) return line;
    // Start is index 1, End is index 2
    const startSec = parseAssTime(parts[1]);
    const endSec = parseAssTime(parts[2]);
    const newStart = Math.max(0, startSec + offset);
    const newEnd = Math.max(0, endSec + offset);
    parts[1] = formatAssTime(newStart);
    parts[2] = formatAssTime(newEnd);
    return parts.join(',');
  }).join('\n');
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export default router;
