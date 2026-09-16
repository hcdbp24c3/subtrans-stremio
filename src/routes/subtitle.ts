import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle } from '../lib/subtitle-parser.js';
import { getVideoDuration, calculateOffset, adjustEntries } from '../lib/aligner.js';

const router = Router();

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
}

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

  // 1. Fetch subtitle list from upstream sub addon
  const upstreamSubUrl = `${config.subUrl.replace(/\/manifest\.json$/, '')}/subtitles/${type}/${decodedId}`;
  const subResponse = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);

  if (!subResponse?.subtitles?.length) {
    res.json({ subtitles: [] });
    return;
  }

  // 2. Try to get video duration via ffprobe
  // Fetch stream URL from upstream for ffprobe
  const upstreamStreamUrl = `${config.streamUrl.replace(/\/manifest\.json$/, '')}/stream/${type}/${decodedId}`;
  const streamResponse = await fetchJson<{ streams: Array<{ url?: string }> }>(upstreamStreamUrl);
  const videoUrl = streamResponse?.streams?.[0]?.url;

  let videoDuration: number | null = null;
  if (videoUrl) {
    videoDuration = await getVideoDuration(videoUrl);
  }

  // 3. Process each subtitle
  const alignedSubtitles: Subtitle[] = [];

  for (const sub of subResponse.subtitles) {
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

  res.json({ subtitles: alignedSubtitles });
});

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
