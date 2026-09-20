import { Router } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle, SubtitleFormat } from '../lib/subtitle-parser.js';
import {
  calculateOffsetFromReference, getVideoDuration, adjustEntries,
  findBestRefSubtitleStream, extractBuiltinSubtitle,
  calculateOffsetWithFfsubsync, isFfsubsyncAvailable,
} from '../lib/aligner.js';

const router = Router();

const MAX_SUBS_PER_LANG = 5;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
  _format?: SubtitleFormat;
  _source?: number; // index of the sub addon that provided this subtitle
  _releaseName?: string; // release name from the sub addon (for matching with video)
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

/** Detect file extension from upstream URL for Nuvio format detection */
function detectFileExt(url: string): string {
  // Check for known extensions in the URL path (not query params)
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.vtt') || pathname.includes('.vtt?')) return '.vtt';
    if (pathname.endsWith('.ass') || pathname.endsWith('.ssa') || pathname.includes('.ass?') || pathname.includes('.ssa?')) return '.ass';
  } catch {}
  // Default to .srt (most common subtitle format)
  return '.srt';
}

/** Extract real download URL from SubSense local proxy URLs */
function resolveRealUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const from = parsed.searchParams.get('from');
    if (from && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) {
      return from;
    }
  } catch {}
  return url;
}

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

// ── Release name matching ─────────────────────────────────────────

/**
 * Normalize a release name/filename for comparison.
 * Strips extensions, codec info, common prefixes, and lowercases.
 * e.g. "In.the.Grey.2026.1080p.AMZN.WEB-DL.DDP5.1.Atmos.H.264-BYNDR.mkv"
 *   → "in the grey 2026 1080p amzn web dl ddp51 atmos h264 byndr"
 */
function normalizeReleaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|srt|ass|vtt|ts)$/i, '') // strip video/sub extensions
    .replace(/[._]/g, ' ')                             // dots/underscores → spaces
    .replace(/\s+/g, ' ')                              // collapse whitespace
    .trim();
}

/**
 * Extract video source/encode keywords from a release name.
 * These determine subtitle timing — subs synced for one source
 * won't match another due to different intros/outros.
 *
 * Returns a Set of normalized encode tokens: "bluray", "remux", "web-dl",
 * "webrip", "hdtv", "dvdrip", "hdrip", "bdrip", "hdtv".
 */
function extractEncodeKeywords(releaseName: string): Set<string> {
  const norm = normalizeReleaseName(releaseName);
  const tokens = norm.split(' ');
  const encodeMap: Record<string, string> = {
    'bluray': 'bluray', 'bdrip': 'bluray', 'brrip': 'bluray',
    'remux': 'remux',
    'web-dl': 'web-dl', 'webdl': 'web-dl', 'webrip': 'webrip', 'web': 'web-dl',
    'hdtv': 'hdtv',
    'dvdrip': 'dvdrip',
    'hdrip': 'hdrip',
  };
  const result = new Set<string>();
  for (const t of tokens) {
    const mapped = encodeMap[t];
    if (mapped) result.add(mapped);
  }
  return result;
}

/**
 * Check if two encode keyword sets are compatible.
 * e.g. {bluray, remux} vs {web-dl} → incompatible
 *      {bluray} vs {bluray} → compatible
 *      {} vs {web-dl} → compatible (unknown = any)
 */
function encodeCompatible(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return true; // unknown = compatible
  // Check if any keyword matches
  for (const kw of a) {
    if (b.has(kw)) return true;
  }
  return false;
}

/**
 * Score how well two encode keyword sets match.
 * Returns 0-1: 1 = same source, 0 = incompatible.
 */
function encodeMatchScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.5; // unknown = neutral
  for (const kw of a) {
    if (b.has(kw)) return 1;
  }
  return 0;
}

/**
 * Calculate how well a subtitle release name matches a video filename.
 * Returns 0-1 (1 = perfect match, 0 = no match).
 *
 * Two-phase scoring:
 *   Phase 1 — Encode compatibility (hard filter): video source (bluray/remux/web-dl)
 *             must match subtitle source. Incompatible encodes get score 0.
 *   Phase 2 — Token overlap: among compatible subs, rank by name similarity.
 *
 * This ensures subs for "BluRay.REMUX" rank above subs for "WEB-DL" when
 * the video is BluRay.
 */
function releaseNameMatchScore(videoFilename: string, subReleaseName: string): number {
  if (!videoFilename || !subReleaseName) return 0;

  const videoNorm = normalizeReleaseName(videoFilename);
  const subNorm = normalizeReleaseName(subReleaseName);

  if (!videoNorm || !subNorm) return 0;
  if (videoNorm === subNorm) return 1;

  // Phase 1: Encode compatibility — HARD FILTER
  const videoEncode = extractEncodeKeywords(videoFilename);
  const subEncode = extractEncodeKeywords(subReleaseName);
  const compatible = encodeCompatible(videoEncode, subEncode);
  if (!compatible) {
    console.log(`[subtitle] Encode mismatch: video=[${[...videoEncode]}] sub=[${[...subEncode]}] "${subReleaseName}"`);
    return 0;
  }

  // Phase 2: Token overlap scoring
  // Noise tokens that don't help distinguish releases (but encode tokens are NOT noise here)
  const noiseTokens = new Set([
    '1080p', '2160p', '720p', '480p', '4k', 'uhd',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1',
    'aac', 'ac3', 'ddp', 'ddp5', 'ddp51', 'eac3', 'truehd', 'atmos', 'dd51',
    'hdr', 'hdr10', 'dolby', 'vision', 'dv', 'sdr',
    '10bit', 'hdrp',
    // encode tokens are now handled separately, add to noise to avoid double-counting
    'bluray', 'bdrip', 'brrip', 'remux', 'web', 'web-dl', 'webdl', 'webrip',
    'hdtv', 'dvdrip', 'hdrip',
  ]);

  const videoTokens = new Set(videoNorm.split(' ').filter((t) => t.length > 1));
  const subTokens = subNorm.split(' ').filter((t) => t.length > 1);

  // Filter noise from both
  const videoMeaningful = [...videoTokens].filter((t) => !noiseTokens.has(t));
  const subMeaningful = subTokens.filter((t) => !noiseTokens.has(t));

  if (videoMeaningful.length === 0 || subMeaningful.length === 0) return 0;

  // Count overlapping meaningful tokens
  const subSet = new Set(subMeaningful);
  let matchCount = 0;
  for (const vt of videoMeaningful) {
    if (subSet.has(vt)) matchCount++;
  }

  // Score = matched meaningful tokens / total meaningful tokens in subtitle
  const score = matchCount / subMeaningful.length;

  // Boost score slightly when encode matches perfectly (same source keyword)
  const encodeBoost = encodeMatchScore(videoEncode, subEncode) * 0.1;
  const finalScore = Math.min(1, score + encodeBoost);

  if (finalScore >= 0.5) {
    console.log(`[subtitle] Release match: score=${finalScore.toFixed(2)} encode=${[...subEncode]} "${subReleaseName}" ↔ "${videoFilename}"`);
  }

  return finalScore;
}

/** Sort subs by release name match score (best match first) */
function sortByReleaseMatch(subs: Subtitle[], videoFilename: string | null): Subtitle[] {
  if (!videoFilename) return subs;
  return [...subs].sort((a, b) => {
    const scoreA = releaseNameMatchScore(videoFilename, a._releaseName || '');
    const scoreB = releaseNameMatchScore(videoFilename, b._releaseName || '');
    return scoreB - scoreA; // higher score first
  });
}

// ── Route ──────────────────────────────────────────────────────────
// Stremio appends extra path segments to subtitle URLs:
//   /subtitles/movie/tt27681354/filename=...mkv&videoSize=...json
// Use wildcard to capture the full path after /subtitles/:type/
router.get('/subtitles/:type/*', async (req, res) => {
  const configStr = req.query.config as string;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  const { type } = req.params;
  // Wildcard captures everything after /subtitles/:type/
  // e.g. "tt27681354/filename=...mkv&videoSize=...json"
  const wildcard = (req.params as any)[0] || '';
  const rawId = wildcard.split('/')[0];
  const decodedId = decodeURIComponent(rawId).replace(/\.json$/, '');

  // 1. Check cache
  const key = cacheKey(config, type, decodedId);
  const cached = getFromCache(key);
  if (cached) {
    res.json(cached);
    return;
  }

  // 2. Fetch stream to get video URL + filename for alignment (use first stream addon)
  let videoDuration: number | null = null;
  let videoUrl: string | null = null;
  let videoFilename: string | null = null;

  if (config.streamUrls.length > 0) {
    try {
      const streamBaseUrl = await getUpstreamBaseUrl(config.streamUrls[0]);
      const upstreamStreamUrl = `${streamBaseUrl}/stream/${type}/${decodedId}.json`;
      const streamResponse = await fetchJson<StreamResponse>(upstreamStreamUrl);
      const bestStream = streamResponse?.streams?.[0];
      if (bestStream) {
        videoUrl = bestStream.url ?? null;
        videoFilename = bestStream.behaviorHints?.filename ?? bestStream.title ?? null;
        if (videoUrl) {
          videoDuration = await getVideoDuration(videoUrl);
          console.log(`[subtitle] Video: filename="${videoFilename}", duration=${videoDuration?.toFixed(1) ?? 'unknown'}s`);
        } else {
          console.log(`[subtitle] Stream has no direct URL (torrent/debrid), filename="${videoFilename}"`);
        }
      } else {
        console.log(`[subtitle] No streams found`);
      }
    } catch (e: any) {
      console.log(`[subtitle] Stream fetch failed: ${e.message}`);
    }
  }

  // 3. Fetch subtitles from ALL upstream sub addons in parallel
  //    Track which addon provided each subtitle for cross-correlation
  const subResults = await Promise.allSettled(
    config.subUrls.map(async (subUrl, sourceIdx) => {
      const subBaseUrl = await getUpstreamBaseUrl(subUrl);
      const upstreamSubUrl = `${subBaseUrl}/subtitles/${type}/${decodedId}.json`;
      const data = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);
      const subs = data?.subtitles || [];
      // Tag each subtitle with its source addon index + preserve releaseName
      return subs.map((s) => ({
        ...s,
        _source: sourceIdx,
        _releaseName: ((s as any).releaseName || (s as any).fileName || '') as string,
      } as Subtitle));
    })
  );

  let allSubs: Subtitle[] = subResults
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => (r as PromiseFulfilledResult<Subtitle[]>).value);

  console.log(`[subtitle] Fetched ${allSubs.length} subs from ${config.subUrls.length} addon(s)`);

  if (allSubs.length === 0) {
    res.json({ subtitles: [] });
    return;
  }

  // 4. Filter + limit
  allSubs = filterByLanguage(allSubs, config.languages);
  allSubs = limitPerLanguage(allSubs, MAX_SUBS_PER_LANG);

  // 5. Detect format for alignment (BEFORE URL rewrite — all URLs are still original upstream URLs)
  allSubs = allSubs.map((sub) => ({
    ...sub,
    _format: detectFormat(sub.url) || undefined,
  })) as Subtitle[];

  // 6. Align subtitles with the video using multiple strategies:
  //    Priority: match subtitle release → cross-correlation → audio detection
  let offset = 0;

  // ── Strategy A: Match subtitle release name to video filename ──────
  // Subtitles are release-specific — a sub synced for "AMZN.WEB-DL" won't
  // match a "BluRay" encode if they have different intros. By matching the
  // release name, we pick the right sub and avoid offset entirely.
  if (videoFilename) {
    allSubs = sortByReleaseMatch(allSubs, videoFilename);
    const bestMatch = allSubs[0];
    const bestScore = releaseNameMatchScore(videoFilename, bestMatch?._releaseName || '');
    // Count how many subs match the video encode vs mismatched
    const videoEncode = extractEncodeKeywords(videoFilename);
    let encodeMatch = 0, encodeMismatch = 0;
    for (const s of allSubs) {
      const subEnc = extractEncodeKeywords(s._releaseName || '');
      if (encodeCompatible(videoEncode, subEnc)) encodeMatch++;
      else encodeMismatch++;
    }
    console.log(`[subtitle] Strategy A (release match): best=${bestScore.toFixed(2)} (${encodeMatch} matched, ${encodeMismatch} mismatched encode)`);
    if (encodeMatch === 0 && videoEncode.size > 0 && allSubs.length > 0) {
      console.log(`[subtitle] ⚠ NO SUBS FOR THIS ENCODE: video needs [${[...videoEncode].join(',')}], ${encodeMismatch} subs all from different encodes`);
      console.log(`[subtitle] Serving best available sub but timing may differ. Use Stremio offset to adjust.`);
    }
  } else {
    console.log(`[subtitle] Strategy A (release match): skipped (no video filename)`);
  }

  // ── Strategy B: Cross-correlation between DIFFERENT sub addons ──────
  // If subs from different addons disagree on timing, detect the offset.
  // (In practice, most sources sync to the same encode — this rarely fires.)
  if (offset === 0) {
    const sourceGroups = new Map<number, Subtitle[]>();
    for (const s of allSubs) {
      const src = s._source ?? -1;
      if (!sourceGroups.has(src)) sourceGroups.set(src, []);
      sourceGroups.get(src)!.push(s);
    }
    const sourceIndices = [...sourceGroups.keys()].filter((k) => k >= 0);

    if (sourceIndices.length >= 2) {
      console.log(`[subtitle] Strategy B (cross-addon): comparing ${sourceIndices.length} addon sources...`);
      const crossOffsets: number[] = [];

      for (let i = 0; i < sourceIndices.length; i++) {
        for (let j = i + 1; j < sourceIndices.length; j++) {
          const subsA = sourceGroups.get(sourceIndices[i])!;
          const subsB = sourceGroups.get(sourceIndices[j])!;

          const byLangA = new Map<string, Subtitle[]>();
          for (const s of subsA) {
            const lang = normalizeLang(s.lang || '');
            if (!byLangA.has(lang)) byLangA.set(lang, []);
            byLangA.get(lang)!.push(s);
          }
          const byLangB = new Map<string, Subtitle[]>();
          for (const s of subsB) {
            const lang = normalizeLang(s.lang || '');
            if (!byLangB.has(lang)) byLangB.set(lang, []);
            byLangB.get(lang)!.push(s);
          }

          for (const [lang, langSubsA] of byLangA) {
            const langSubsB = byLangB.get(lang);
            if (!langSubsB || langSubsB.length === 0) continue;

            const fmtA = langSubsA[0]._format || 'srt' as SubtitleFormat;
            const fmtB = langSubsB[0]._format || 'srt' as SubtitleFormat;
            const realUrlA = resolveRealUrl(langSubsA[0].url);
            const realUrlB = resolveRealUrl(langSubsB[0].url);

            const [contentA, contentB] = await Promise.all([fetchText(realUrlA), fetchText(realUrlB)]);
            if (!contentA || !contentB) continue;

            const entriesA = parseSubtitle(contentA, fmtA);
            const entriesB = parseSubtitle(contentB, fmtB);
            if (entriesA.length === 0 || entriesB.length === 0) continue;

            const pairOffset = calculateOffsetFromReference(entriesA, entriesB);
            if (pairOffset !== 0) {
              crossOffsets.push(pairOffset);
              console.log(`[subtitle]   Addon ${sourceIndices[i]} vs ${sourceIndices[j]} [${lang}]: ${pairOffset.toFixed(1)}s`);
            }
          }
        }
      }

      if (crossOffsets.length > 0) {
        crossOffsets.sort((a, b) => a - b);
        offset = crossOffsets[Math.floor(crossOffsets.length / 2)];
        console.log(`[subtitle] Strategy B (cross-addon): offset=${offset.toFixed(1)}s from ${crossOffsets.length} pairs`);
      } else {
        console.log(`[subtitle] Strategy B (cross-addon): addons agree (no offset detected)`);
      }
    }
  }

  // ── Strategy C: Subtitle-to-subtitle sync via ffsubsync ──────────
  // Extract built-in English subtitle from the video, then use ffsubsync
  // to find the sync offset between it and the external subtitle.
  // This is the most reliable method — works even when no cross-addon
  // subs are available, and handles translation timing differences.
  if (offset === 0 && videoUrl && isFfsubsyncAvailable()) {
    console.log(`[subtitle] Strategy C (ffsubsync): checking for builtin subs...`);
    const refStream = findBestRefSubtitleStream(videoUrl);
    if (refStream) {
      console.log(`[subtitle] Strategy C: extracting builtin sub stream ${refStream.index} (${refStream.lang})...`);
      const builtinSrt = extractBuiltinSubtitle(videoUrl, refStream.index, 60);
      if (builtinSrt) {
        // Sync against the best-matching external subtitle
        const bestSub = allSubs[0];
        if (bestSub) {
          const realUrl = resolveRealUrl(bestSub.url);
          console.log(`[subtitle] Strategy C: running ffsubsync against best sub...`);
          const subContent = await fetchText(realUrl);
          if (subContent) {
            const ffsubsyncOffset = calculateOffsetWithFfsubsync(builtinSrt, subContent);
            if (ffsubsyncOffset !== 0) {
              offset = ffsubsyncOffset;
              console.log(`[subtitle] Strategy C (ffsubsync): offset=${offset.toFixed(3)}s`);
            } else {
              console.log(`[subtitle] Strategy C (ffsubsync): no offset detected (subs already synced)`);
            }
          }
        }
      } else {
        console.log(`[subtitle] Strategy C: failed to extract builtin sub (timeout or no text subs)`);
      }
    } else {
      console.log(`[subtitle] Strategy C: no text subtitle streams found in video`);
    }
  } else if (offset === 0 && videoUrl && !isFfsubsyncAvailable()) {
    console.log(`[subtitle] Strategy C: ffsubsync not available, skipping`);
  }

  // 7. If offset detected, re-download all subs and re-serialize with offset applied
  //    (using resolved upstream URLs for download)
  const alignedSubtitles: Subtitle[] = [];
  for (const sub of allSubs) {
    if (offset !== 0) {
      const format = (sub._format || 'srt') as SubtitleFormat | null;
      if (format) {
        const realUrl = resolveRealUrl(sub.url);
        const subContent = await fetchText(realUrl);
        if (subContent) {
          let adjustedContent: string | null = null;

          if (format === 'ass') {
            // ASS/SSA: adjust timestamps in-place on raw text (preserves styling)
            adjustedContent = adjustAssTimestamps(subContent, offset);
          } else {
            // SRT/VTT: parse → adjust → re-serialize
            const entries = parseSubtitle(subContent, format);
            if (entries.length > 0) {
              const adjusted = adjustEntries(entries, offset);
              adjustedContent = reSerialize(adjusted, format);
            }
          }

          if (adjustedContent) {
            const dataUrl = `data:text/plain;base64,${Buffer.from(adjustedContent).toString('base64')}`;
            alignedSubtitles.push({ ...sub, url: dataUrl });
            continue;
          }
        }
      }
    }
    alignedSubtitles.push(sub);
  }

  // 8. NOW rewrite URLs to proxy format (all content downloads are done)
  const base = `${req.protocol}://${req.headers.host || 'localhost'}`;
  const configParam = encodeURIComponent(encodeConfig(config));
  const finalSubtitles = alignedSubtitles.map((sub) => {
    // Skip data URLs (already encoded) or proxy URLs (already rewritten)
    if (sub.url.startsWith('data:') || sub.url.startsWith(base)) {
      return { ...sub } as Subtitle;
    }
    const ext = detectFileExt(sub.url);
    return {
      ...sub,
      url: `${base}/subdownload${ext}?url=${encodeURIComponent(sub.url)}&config=${configParam}`,
    } as Subtitle;
  });
  const result = {
    subtitles: finalSubtitles.map(({ _format, ...rest }) => rest),
  };
  setCache(key, result);

  res.json(result);
});

// ── Subtitle download proxy ───────────────────────────────────────
// Upstream addons (SubSense) return 127.0.0.1 URLs that only work locally.
// This endpoint proxies the download so Nuvio/browser can fetch it.
// URL format: /subdownload.srt?url=...&config=...
// The .srt/.vtt/.ass extension helps Nuvio detect subtitle format.
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
    res.setHeader('Content-Type', mimeMap[ext] || 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

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

      // Stremio only supports SRT/VTT — convert ASS/SSA to SRT on the fly
      const upstreamFormat = detectFormat(url) || ((ext === 'ass' || ext === 'ssa') ? 'ass' : null);
      if (upstreamFormat === 'ass') {
        const entries = parseSubtitle(rawContent, 'ass');
        if (entries.length > 0) {
          const srtContent = reSerialize(entries, 'srt');
          if (srtContent) {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.send(srtContent);
            return;
          }
        }
      }

      // SRT/VTT: send as-is
      res.send(rawContent);
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

  // ASS/SSA: handled separately via adjustAssTimestamps
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
