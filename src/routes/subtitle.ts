import { Router } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle, SubtitleFormat } from '../lib/subtitle-parser.js';
import { getVideoDuration, calculateOffset, adjustEntries } from '../lib/aligner.js';

const router = Router();

const MAX_SUBS_PER_LANG = 5;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
  _format?: SubtitleFormat;
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

// ── Route ──────────────────────────────────────────────────────────
router.get('/subtitles/:type/:id', async (req, res) => {
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

  const { type, id } = req.params;
  // Stremio appends .json to resource URLs (/subtitles/movie/tt123.json)
  // Strip it so we get the raw IMDb ID for upstream queries
  const decodedId = decodeURIComponent(id).replace(/\.json$/, '');

  // 1. Check cache
  const key = cacheKey(config, type, decodedId);
  const cached = getFromCache(key);
  if (cached) {
    res.json(cached);
    return;
  }

  // 2. Fetch stream to get video URL for alignment (use first stream addon)
  let videoDuration: number | null = null;
  if (config.streamUrls.length > 0) {
    try {
      const streamBaseUrl = await getUpstreamBaseUrl(config.streamUrls[0]);
      const upstreamStreamUrl = `${streamBaseUrl}/stream/${type}/${decodedId}`;
      const streamResponse = await fetchJson<{ streams: Array<{ url?: string }> }>(upstreamStreamUrl);
      const videoUrl = streamResponse?.streams?.[0]?.url;
      if (videoUrl) {
        videoDuration = await getVideoDuration(videoUrl);
      }
    } catch {
      // Stream fetch failed — proceed without alignment
    }
  }

  // 3. Fetch subtitles from ALL upstream sub addons in parallel
  const subResults = await Promise.allSettled(
    config.subUrls.map(async (subUrl) => {
      const subBaseUrl = await getUpstreamBaseUrl(subUrl);
      const upstreamSubUrl = `${subBaseUrl}/subtitles/${type}/${decodedId}.json`;
      const data = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);
      return data?.subtitles || [];
    })
  );

  let allSubs = subResults
    .filter((r): r is PromiseFulfilledResult<Subtitle[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  if (allSubs.length === 0) {
    res.json({ subtitles: [] });
    return;
  }

  // 4. Filter + limit
  allSubs = filterByLanguage(allSubs, config.languages);
  allSubs = limitPerLanguage(allSubs, MAX_SUBS_PER_LANG);

  // 5. Detect format + rewrite subtitle URLs to go through our download proxy
  //    (upstream addons like SubSense return 127.0.0.1 URLs that only work locally)
  const base = `${req.protocol}://${req.headers.host || 'localhost'}`;
  const configParam = encodeURIComponent(encodeConfig(config));
  allSubs = allSubs.map((sub) => {
    const ext = detectFileExt(sub.url);
    return {
      ...sub,
      _format: detectFormat(sub.url) || undefined,
      url: `${base}/subdownload${ext}?url=${encodeURIComponent(sub.url)}&config=${configParam}`,
    } as Subtitle;
  });

  // 6. Align subtitles if we have video duration
  const alignedSubtitles: Subtitle[] = [];
  for (const sub of allSubs) {
    const format = sub._format as SubtitleFormat | null;
    if (!format) {
      alignedSubtitles.push(sub);
      continue;
    }

    const subContent = await fetchText(sub.url);
    if (!subContent) {
      alignedSubtitles.push(sub);
      continue;
    }

    const entries = parseSubtitle(subContent, format);
    if (entries.length === 0) {
      alignedSubtitles.push(sub);
      continue;
    }

    if (videoDuration && videoDuration > 0) {
      const offset = calculateOffset(entries, videoDuration);
      if (offset !== 0) {
        const adjusted = adjustEntries(entries, offset);
        const adjustedContent = reSerialize(adjusted, format);
        if (adjustedContent) {
          const dataUrl = `data:text/plain;base64,${Buffer.from(adjustedContent).toString('base64')}`;
          alignedSubtitles.push({ ...sub, url: dataUrl });
          continue;
        }
      }
    }

    alignedSubtitles.push(sub);
  }

  // 6. Cache result (strip internal _format fields)
  const result = {
    subtitles: alignedSubtitles.map(({ _format, ...rest }) => rest),
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
      // Strip UTF-8 BOM (0xEF 0xBB 0xBF) if present
      const content = (ext === 'srt' || ext === 'vtt')
        ? buffer.toString('utf-8').replace(/^\uFEFF/, '')
        : buffer.toString('utf-8');
      res.send(content);
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

  return null;
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
