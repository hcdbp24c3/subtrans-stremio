import { Router } from 'express';
import { decodeConfig, AddonConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle } from '../lib/subtitle-parser.js';
import { getVideoDuration, calculateOffset, adjustEntries } from '../lib/aligner.js';

const router = Router();

const MAX_SUBS_PER_LANG = 5;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
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
  return `${config.streamUrl}|${config.subUrl}|${type}|${id}`;
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
  // Evict oldest if cache grows too large (>200 entries)
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

function filterByLanguage(subs: Subtitle[], languages: string): Subtitle[] {
  if (!languages) return subs; // empty = all languages

  const allowed = new Set(
    languages.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean)
  );
  return subs.filter((s) => {
    const lang = (s.lang || '').toLowerCase();
    return allowed.has(lang);
  });
}

function limitPerLanguage(subs: Subtitle[], limit: number): Subtitle[] {
  const counts = new Map<string, number>();
  return subs.filter((s) => {
    const lang = (s.lang || 'unknown').toLowerCase();
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
  const decodedId = decodeURIComponent(id);

  // 1. Check cache
  const key = cacheKey(config, type, decodedId);
  const cached = getFromCache(key);
  if (cached) {
    res.json(cached);
    return;
  }

  // 2. Fetch manifest to discover correct base URLs
  const subBaseUrl = await getUpstreamBaseUrl(config.subUrl);
  const streamBaseUrl = await getUpstreamBaseUrl(config.streamUrl);

  // 3. Fetch subtitle list from upstream sub addon
  const upstreamSubUrl = `${subBaseUrl}/subtitles/${type}/${decodedId}`;
  const subResponse = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);

  if (!subResponse?.subtitles?.length) {
    res.json({ subtitles: [] });
    return;
  }

  // 4. Filter by language + limit per language
  let subs = filterByLanguage(subResponse.subtitles, config.languages);
  subs = limitPerLanguage(subs, MAX_SUBS_PER_LANG);

  // 5. Try to get video duration via ffprobe
  const upstreamStreamUrl = `${streamBaseUrl}/stream/${type}/${decodedId}`;
  const streamResponse = await fetchJson<{ streams: Array<{ url?: string }> }>(upstreamStreamUrl);
  const videoUrl = streamResponse?.streams?.[0]?.url;

  let videoDuration: number | null = null;
  if (videoUrl) {
    videoDuration = await getVideoDuration(videoUrl);
  }

  // 6. Process each subtitle — align if needed
  const alignedSubtitles: Subtitle[] = [];

  for (const sub of subs) {
    const format = detectFormat(sub.url);
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

    // Calculate and apply offset if we have video duration
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

  // 7. Cache result
  const result = { subtitles: alignedSubtitles };
  setCache(key, result);

  res.json(result);
});

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

  // ASS re-serialization is complex; pass through original
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
