import { Router } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import {
  detectFormat, sniffFormat, parseSubtitle, SubtitleFormat
} from '../lib/subtitle-parser.js';
import {
  calculateOffsetWithFfsubsyncVideo, adjustEntries,
  isFfsubsyncAvailable,
  probeVideoInfo, VideoProbeResult,
} from '../lib/aligner.js';
import { detectFileExt } from './subtitle-ext.js';
import { createTtlStore } from '../lib/ttl-store.js';

const router = Router();

const MAX_SUBS_PER_LANG = 5;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SUB_DOWNLOAD_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const subDownloadCache = createTtlStore<{ body: Buffer; contentType: string }>(100);

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

function setOffsetCache(videoUrl: string, offset: number): void {
  if (offsetCache.size > 50) {
    const oldest = offsetCache.keys().next().value;
    if (oldest) offsetCache.delete(oldest);
  }
  offsetCache.set(videoUrl, { offset, expires: Date.now() + OFFSET_CACHE_TTL });
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
      return subs.map((s) => ({
        ...s,
        _source: sourceIdx,
        _releaseName: ((s as any).releaseName || (s as any).fileName || '') as string,
      } as Subtitle));
    })
  );

  // Wait for stream info first (we need videoUrl for probe)
  await streamPromise;

  // 2c. Probe video (synchronous — runs while subs continue fetching)
  if (videoUrl) {
    videoProbe = probeVideoInfo(videoUrl);
    videoDuration = videoProbe.duration;
    console.log(`[subtitle] Video: filename="${videoFilename}", duration=${videoDuration?.toFixed(1) ?? 'unknown'}s, textSubStreams=${videoProbe.subtitleStreams.length}`);
  } else {
    console.log(`[subtitle] Video: filename="${videoFilename}", no direct URL`);
  }

  // Wait for subs to complete (probe already done synchronously above)
  const subResults = await subPromise;

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
  const beforeDedupe = allSubs.length;
  allSubs = dedupeSubtitles(allSubs);
  if (allSubs.length !== beforeDedupe) {
    console.log(`[subtitle] Deduped ${beforeDedupe - allSubs.length} duplicate URL(s)`);
  }

  // 5. Detect format for alignment (BEFORE URL rewrite — all URLs are still original upstream URLs)
  allSubs = allSubs.map((sub) => ({
    ...sub,
    _format: detectFormat(sub.url) || undefined,
  })) as Subtitle[];

  // 6. Align: single path — ffsubsync against the VIDEO (audio/VAD).
  //    No encode ranking, no cross-addon, no duration heuristic.
  let offset = 0;
  if (videoUrl && isFfsubsyncAvailable()) {
    const cachedOffset = getOffsetFromCache(videoUrl);
    if (cachedOffset !== null) {
      offset = cachedOffset;
    } else {
      const bestSub = allSubs[0];
      if (bestSub) {
        try {
          const realUrl = resolveRealUrl(bestSub.url);
          console.log(`[subtitle] ffsubsync: syncing best sub against video audio...`);
          const subContent = await fetchText(realUrl);
          if (subContent) {
            // ffsubsync wants SRT-shaped text; convert ASS/VTT for analysis only
            const fmt = (bestSub._format || 'srt') as SubtitleFormat;
            let analysisSrt = subContent;
            if (fmt !== 'srt') {
              const entries = parseSubtitle(subContent, fmt);
              if (entries.length > 0) {
                analysisSrt = reSerialize(entries, 'srt') || subContent;
              }
            }
            offset = calculateOffsetWithFfsubsyncVideo(videoUrl, analysisSrt);
            if (offset !== 0) {
              setOffsetCache(videoUrl, offset);
              console.log(`[subtitle] ffsubsync: offset=${offset.toFixed(3)}s (cached for this video)`);
            } else {
              console.log(`[subtitle] ffsubsync: no offset (already synced or low confidence)`);
            }
          }
        } catch (e: any) {
          console.log(`[subtitle] ffsubsync: error: ${e.message?.substring(0, 200)}`);
        }
      }
    }
  } else if (videoUrl && !isFfsubsyncAvailable()) {
    console.log(`[subtitle] ffsubsync not available, serving subs without alignment`);
  } else {
    console.log(`[subtitle] no video URL, serving subs without alignment`);
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
            // Nuvio Android cannot parse ASS (ICU regex crash on unescaped }).
            // Convert to SRT after offsetting so the data URL is always SRT.
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
