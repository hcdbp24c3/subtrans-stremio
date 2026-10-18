import { Router, Request, Response } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import {
  detectFormat, sniffFormat, parseSubtitle, SubtitleFormat, SubtitleEntry,
} from '../lib/subtitle-parser.js';
import {
  adjustEntries, calculateOffsetFromTiming,
} from '../lib/aligner.js';
import {
  scoreReleaseMatch, findReferenceSub,
} from '../lib/align-fast.js';
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

// Nuvio client aborts each addon after 30s; Stremio web ~60s.
// Keeping handler budget to 28s guarantees response arrives safely before client timeout.
export const HANDLER_BUDGET_MS = 28_000;
const RESPONSE_MARGIN_MS = 1_500;
const TRANSLATE_MIN_MS = 2_500;

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

async function fetchAndParseSubEntries(sub: Subtitle): Promise<SubtitleEntry[]> {
  if (sub._entries && sub._entries.length > 0) return sub._entries;
  const realUrl = resolveRealUrl(sub.url);
  const cached = subDownloadCache.get(realUrl);
  let text = cached ? cached.body.toString('utf-8') : null;
  if (!text) {
    try {
      text = await fetchText(realUrl);
      if (text) {
        subDownloadCache.set(
          realUrl,
          { body: Buffer.from(text, 'utf-8'), contentType: 'text/plain' },
          SUB_DOWNLOAD_CACHE_TTL_MS,
        );
      }
    } catch {
      return [];
    }
  }
  if (!text) return [];
  const fmt = (sub._format || detectFormat(sub.url) || 'srt') as SubtitleFormat;
  try {
    return parseSubtitle(text, fmt);
  } catch {
    return [];
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

  // Wait for stream info first (we need videoFilename for release matching)
  await streamPromise;

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

  // 3. Find Benchmark Reference Subtitle ("Sub Chuẩn" - đã trùng codec/release)
  const benchmark = findReferenceSub(sourceWithFormat, videoFilename);
  const benchmarkSub = benchmark?.sub ?? sourceWithFormat[0];
  const isBenchmarkSynced = benchmark?.isReleaseMatch ?? false;
  if (benchmarkSub) {
    console.log(
      `[subtitle] benchmark sub: ${benchmarkSub.id} [${benchmarkSub.lang || 'und'}], ` +
      `releaseMatch=${isBenchmarkSynced} (score=${benchmark?.matchScore ?? 0})`
    );
  }

  // 4. Target language filter (e.g. "vi,vie" or "vi")
  const targetSubs = filterByLanguage(sourceWithFormat, config.languages);

  let allSubs: Subtitle[] = [];
  let listCacheable = true;
  let overallOffset = 0;
  let translatePromise: Promise<{ input: LingarrSourceSub[]; translated: Subtitle[] } | null> = Promise.resolve(null);

  if (targetSubs.length > 0) {
    // ── SCENARIO A: Target subtitles EXIST ──
    // "nếu có target sub thì dùng sub chuẩn đó để so lại cho target sub"
    console.log(`[subtitle] Found ${targetSubs.length} target sub(s) for languages="${config.languages}"`);
    let refEntries: SubtitleEntry[] | null = null;
    const candidatesToSync = limitPerLanguage(targetSubs, MAX_SUBS_PER_LANG);
    const syncedTargetSubs: Subtitle[] = [];

    for (const tSub of candidatesToSync) {
      const match = scoreReleaseMatch(videoFilename, tSub._releaseName);
      if (match.matched) {
        console.log(`[subtitle] target sub ${tSub.id} matches video release (${match.reason}) — already in sync (offset=0)`);
        syncedTargetSubs.push(tSub);
        continue;
      }

      // Target sub does NOT match release -> compare against benchmark sub!
      if (!refEntries && benchmarkSub) {
        refEntries = await fetchAndParseSubEntries(benchmarkSub);
      }

      if (refEntries && refEntries.length >= 3) {
        const tgtEntries = await fetchAndParseSubEntries(tSub);
        if (tgtEntries.length >= 3) {
          const timing = calculateOffsetFromTiming(refEntries, tgtEntries);
          if (timing.score >= 0.35 && Math.abs(timing.offset) >= 0.25) {
            console.log(
              `[subtitle] target sub ${tSub.id} aligned via benchmark: offset=${timing.offset.toFixed(2)}s ` +
              `(score=${timing.score.toFixed(2)}, matched ${timing.matchedCues}/${timing.totalCues} cues)`
            );
            overallOffset = timing.offset;
            const adjusted = adjustEntries(tgtEntries, timing.offset);
            const body = Buffer.from(reSerialize(adjusted, 'srt') || '', 'utf-8');
            const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
            alignedSubCache.set(token, { body, contentType: 'text/plain; charset=utf-8' }, ALIGNED_SUB_TTL_MS);
            syncedTargetSubs.push({
              ...tSub,
              url: `aligned:${token}`,
              _aligned: true,
              _entries: adjusted,
            });
            continue;
          }
        }
      }

      // If comparison not confident or offset is 0, use directly
      syncedTargetSubs.push(tSub);
    }

    allSubs = syncedTargetSubs;
  } else if (config.translateTargets.length > 0 && sourceSubs.length > 0) {
    // ── SCENARIO B: NO target subtitles exist -> TRANSLATE ──
    // "ko có thì dịch": take the benchmark sub (already in sync) and translate it!
    console.log(`[subtitle] 0 target subs found for "${config.languages}" — translating from benchmark sub (${benchmarkSub?.id || 'source'})`);

    const translateInput: LingarrSourceSub[] = [
      ...(benchmarkSub ? [{
        id: benchmarkSub.id,
        url: benchmarkSub.url,
        lang: benchmarkSub.lang,
        format: benchmarkSub._format,
        normLang: benchmarkSub.lang ? normalizeLang(benchmarkSub.lang) : '',
      }] : []),
      ...sourceWithFormat
        .filter((s) => s.id !== benchmarkSub?.id)
        .map((s) => ({
          id: s.id,
          url: s.url,
          lang: s.lang,
          format: s._format,
          normLang: s.lang ? normalizeLang(s.lang) : '',
        })),
    ];

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
        return { input: translateInput, translated: newSubs };
      }
      return null;
    })().catch((e: any) => {
      console.log(`[translate] error: ${e?.message?.substring(0, 200)}`);
      return null;
    });

    const remainingForTranslate = Math.max(0, budgetLeftMs() - (RESPONSE_MARGIN_MS + 500));
    const translateResult = await Promise.race([
      translatePromise,
      sleep(remainingForTranslate).then(() => null),
    ]);

    if (translateResult && translateResult.translated.length > 0) {
      allSubs = translateResult.translated;
    } else {
      console.log(`[subtitle] translate running in background — serving available fallback subs`);
      allSubs = limitPerLanguage(sourceSubs, MAX_SUBS_PER_LANG);
      listCacheable = false;
    }
  } else {
    // ── SCENARIO C: No target language filter or translation ──
    allSubs = limitPerLanguage(sourceWithFormat, MAX_SUBS_PER_LANG);
  }

  // Materialize any subtitles that carry `_entries` (e.g. translated or adjusted)
  const alignedSubtitles = await materializeTranslatedSubs(allSubs);

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
  console.log(`[subtitle] response: ${result.subtitles.length} subs [${Object.entries(langCounts).map(([l, c]) => `${l}:${c}`).join(', ')}], offset=${overallOffset.toFixed(2)}s, listCacheable=${listCacheable}`);

  res.json(result);

  // If translate was still running in background, warm the list cache when it finishes
  // so the user's next request / subtitle select gets the translated sub instantly.
  if (config.translateTargets.length > 0 && translatePromise) {
    translatePromise.then(async (res) => {
      if (!res || !res.translated || res.translated.length === 0) return;
      try {
        const materialized = await materializeTranslatedSubs(res.translated);
        const finalTranslated = materialized.map((sub) => {
          if (sub._aligned && sub.url.startsWith('aligned:')) {
            const token = sub.url.slice('aligned:'.length);
            return { ...sub, url: `${base}/alignedsub/${token}.srt` };
          }
          return sub;
        });
        const currentList = getFromCache(key);
        const baseSubs = currentList?.subtitles ?? finalSubtitles;
        const merged = [...finalTranslated, ...baseSubs];
        const deduped = dedupeSubtitles(limitPerLanguage(merged, MAX_SUBS_PER_LANG));
        const updatedResult = {
          subtitles: deduped.map(({ _format, _aligned, _source, _releaseName, _entries, ...rest }: any) => rest),
        };
        setCache(key, updatedResult);
        console.log(`[subtitle] background translate finished and populated list cache (${updatedResult.subtitles.length} subs)`);
      } catch (err: any) {
        console.log(`[subtitle] background translate cache update failed: ${err?.message}`);
      }
    }).catch(() => {});
  }
}

router.get('/subtitles/:type/*', subtitlesHandler);
// Path-segment config: /<config>/subtitles/<type>/<id>.json
router.get(`/:config(${PATH_SEGMENT_RE})/subtitles/:type/*`, subtitlesHandler);

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
