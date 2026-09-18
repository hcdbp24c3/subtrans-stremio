import { Router } from 'express';
import { decodeConfig, encodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle, SubtitleFormat } from '../lib/subtitle-parser.js';
import { calculateOffsetFromReference, getVideoDuration, detectDialogueStart, calculateOffsetFromDialogue, adjustEntries } from '../lib/aligner.js';

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

  // 2. Fetch stream to get video URL for alignment (use first stream addon)
  let videoDuration: number | null = null;
  let videoUrl: string | null = null;
  let refSubs: Subtitle[] = [];

  if (config.streamUrls.length > 0) {
    try {
      const streamBaseUrl = await getUpstreamBaseUrl(config.streamUrls[0]);

      // Try to get video URL for ffprobe-based alignment
      try {
        const upstreamStreamUrl = `${streamBaseUrl}/stream/${type}/${decodedId}`;
        const streamResponse = await fetchJson<{ streams: Array<{ url?: string }> }>(upstreamStreamUrl);
        videoUrl = streamResponse?.streams?.[0]?.url ?? null;
        if (videoUrl) {
          videoDuration = await getVideoDuration(videoUrl);
          if (videoDuration) {
            console.log(`[subtitle] Video duration: ${videoDuration.toFixed(1)}s`);
          } else {
            console.log(`[subtitle] Could not get video duration`);
          }
        } else {
          console.log(`[subtitle] No video URL in stream response`);
        }
      } catch (e: any) {
        console.log(`[subtitle] Stream fetch failed: ${e.message}`);
      }

      // Also try to get reference subtitles from stream addon
      try {
        const upstreamSubUrl = `${streamBaseUrl}/subtitles/${type}/${decodedId}.json`;
        const data = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);
        refSubs = data?.subtitles || [];
        console.log(`[subtitle] Reference subs from stream addon: ${refSubs.length}`);
      } catch {
        // Stream addon doesn't support subtitles resource
      }
    } catch {
      // Stream addon manifest fetch failed
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

  // 5. Detect format for alignment (BEFORE URL rewrite — all URLs are still original upstream URLs)
  allSubs = allSubs.map((sub) => ({
    ...sub,
    _format: detectFormat(sub.url) || undefined,
  })) as Subtitle[];

  // 6. Calculate alignment offset using multiple strategies:
  //    Downloads use ORIGINAL upstream URLs (before proxy rewrite)
  let offset = 0;

  // Strategy A: Reference subtitle comparison (highest confidence)
  if (refSubs.length > 0 && allSubs.length > 0) {
    const refByLang = new Map<string, Subtitle[]>();
    for (const s of refSubs) {
      const lang = normalizeLang(s.lang || '');
      if (!refByLang.has(lang)) refByLang.set(lang, []);
      refByLang.get(lang)!.push(s);
    }
    const ourByLang = new Map<string, Subtitle[]>();
    for (const s of allSubs) {
      const lang = normalizeLang(s.lang || '');
      if (!ourByLang.has(lang)) ourByLang.set(lang, []);
      ourByLang.get(lang)!.push(s);
    }

    const offsets: number[] = [];
    for (const [lang, refLangSubs] of refByLang) {
      const ourLangSubs = ourByLang.get(lang);
      if (!ourLangSubs || ourLangSubs.length === 0) continue;

      for (const refSub of refLangSubs.slice(0, 2)) {
        const refFormat = detectFormat(refSub.url);
        if (!refFormat) continue;
        const refContent = await fetchText(refSub.url);
        if (!refContent) continue;
        const refEntries = parseSubtitle(refContent, refFormat);
        if (refEntries.length === 0) continue;

        for (const ourSub of ourLangSubs.slice(0, 2)) {
          const ourFormat = ourSub._format || 'srt' as SubtitleFormat;
          const ourRealUrl = resolveRealUrl(ourSub.url);
          const ourContent = await fetchText(ourRealUrl);
          if (!ourContent) continue;
          const ourEntries = parseSubtitle(ourContent, ourFormat);
          if (ourEntries.length === 0) continue;

          const pairOffset = calculateOffsetFromReference(refEntries, ourEntries);
          if (pairOffset !== 0) offsets.push(pairOffset);
        }
      }
    }

    if (offsets.length > 0) {
      offsets.sort((a, b) => a - b);
      offset = offsets[Math.floor(offsets.length / 2)];
      console.log(`[subtitle] Strategy A (reference): offset=${offset.toFixed(1)}s from ${offsets.length} pairs`);
    } else {
      console.log(`[subtitle] Strategy A (reference): no offset found (${refSubs.length} ref subs, ${allSubs.length} our subs)`);
    }
  }

  // Strategy B: Cross-correlation between multiple subtitle files
  // Compare the first few subtitle files against each other to detect offset
  // (works when different uploaders/source versions have different timing)
  if (offset === 0 && allSubs.length >= 2) {
    console.log(`[subtitle] Strategy B (cross-correlation): comparing ${allSubs.length} subtitle files...`);
    const crossOffsets: number[] = [];

    for (let i = 0; i < Math.min(allSubs.length, 3); i++) {
      for (let j = i + 1; j < Math.min(allSubs.length, 3); j++) {
        const fmtA = allSubs[i]._format || 'srt' as SubtitleFormat;
        const fmtB = allSubs[j]._format || 'srt' as SubtitleFormat;
        const realUrlA = resolveRealUrl(allSubs[i].url);
        const realUrlB = resolveRealUrl(allSubs[j].url);

        const [contentA, contentB] = await Promise.all([fetchText(realUrlA), fetchText(realUrlB)]);
        if (!contentA || !contentB) continue;

        const entriesA = parseSubtitle(contentA, fmtA);
        const entriesB = parseSubtitle(contentB, fmtB);
        if (entriesA.length === 0 || entriesB.length === 0) continue;

        const pairOffset = calculateOffsetFromReference(entriesA, entriesB);
        if (pairOffset !== 0) {
          crossOffsets.push(pairOffset);
          console.log(`[subtitle]   Cross-correlation: file ${i} vs ${j} → ${pairOffset.toFixed(1)}s`);
        }
      }
    }

    if (crossOffsets.length > 0) {
      crossOffsets.sort((a, b) => a - b);
      offset = crossOffsets[Math.floor(crossOffsets.length / 2)];
      console.log(`[subtitle] Strategy B (cross-correlation): offset=${offset.toFixed(1)}s from ${crossOffsets.length} pairs`);
    } else {
      console.log(`[subtitle] Strategy B (cross-correlation): files agree (no offset detected)`);
    }
  }

  // Strategy C: Audio-based dialogue start detection (slower, last resort)
  // Uses ffmpeg silencedetect to find when dialogue actually starts in the video,
  // then compares with the first subtitle entry
  if (offset === 0 && videoUrl) {
    console.log(`[subtitle] Strategy C (audio dialogue detection): analyzing...`);
    const dialogueStart = detectDialogueStart(videoUrl);
    if (dialogueStart !== null) {
      // Download one subtitle to compare
      const sub = allSubs[0];
      const fmt = sub._format || 'srt' as SubtitleFormat;
      const realUrl = resolveRealUrl(sub.url);
      const content = await fetchText(realUrl);
      if (content) {
        const entries = parseSubtitle(content, fmt);
        if (entries.length > 0) {
          const dialogueOffset = calculateOffsetFromDialogue(entries, dialogueStart);
          if (dialogueOffset !== 0) {
            offset = dialogueOffset;
            console.log(`[subtitle] Strategy C (dialogue): offset=${offset.toFixed(1)}s`);
          }
        }
      }
    } else {
      console.log(`[subtitle] Strategy C (dialogue): detection failed`);
    }
  }

  console.log(`[subtitle] Final: offset=${offset.toFixed(1)}s, duration=${videoDuration?.toFixed(0) ?? 'none'}s, subs=${allSubs.length}`);

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
