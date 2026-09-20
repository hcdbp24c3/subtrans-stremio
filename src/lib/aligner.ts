import { execSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SubtitleEntry } from './subtitle-parser.js';

const OFFSET_THRESHOLD = 0.5;
const MAX_OFFSET = 600;
const TEXT_SIMILARITY_MIN = 0.6;

// ── Text normalization ────────────────────────────────────────────
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Offset from reference subtitles ────────────────────────────────
export function calculateOffsetFromReference(
  reference: SubtitleEntry[],
  target: SubtitleEntry[],
): number {
  if (reference.length === 0 || target.length === 0) return 0;
  const refIndex = reference.map((e) => ({ text: normalizeText(e.text), start: e.start }));
  const targetIndex = target.map((e) => ({ text: normalizeText(e.text), start: e.start }));
  const diffs: number[] = [];

  for (const ref of refIndex) {
    if (!ref.text) continue;
    let bestSim = 0;
    let bestDiff = 0;
    for (const tgt of targetIndex) {
      if (!tgt.text) continue;
      const sim = textSimilarity(ref.text, tgt.text);
      if (sim > bestSim) { bestSim = sim; bestDiff = ref.start - tgt.start; }
    }
    if (bestSim >= TEXT_SIMILARITY_MIN) { diffs.push(bestDiff); }
  }

  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  if (Math.abs(median) < OFFSET_THRESHOLD) return 0;
  if (Math.abs(median) > MAX_OFFSET) return 0;
  if (diffs.length < 3) return 0;

  const consistent = diffs.filter((d) => Math.abs(d - median) < 1.0);
  const consistency = consistent.length / diffs.length;
  if (consistency < 0.5) return 0;

  console.log(`[aligner] Reference offset: ${median.toFixed(1)}s (matched ${diffs.length} entries, ${Math.round(consistency * 100)}% consistent)`);
  return median;
}

// ── Video probe (combined duration + streams) ─────────────────────

/** Resolve redirects via curl (Node fetch gets 404 on some CDNs) */
function resolveRedirect(url: string): string {
  try {
    const location = execSync(
      `curl -sI --max-time 10 "${url}" 2>/dev/null | grep -i "^location:" | tail -1 | tr -d '\\r' | awk '{print $2}'`,
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();
    return location || url;
  } catch { return url; }
}

export async function getVideoDuration(url: string): Promise<number | null> {
  try {
    const probeUrl = resolveRedirect(url);
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -analyzeduration 5000000 -probesize 1000000 "${probeUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();
    const match = result.match(/duration=([\d.]+)/);
    return match ? parseFloat(match[1]) : null;
  } catch { return null; }
}

export interface VideoProbeResult {
  duration: number | null;
  subtitleStreams: SubtitleStreamInfo[];
}

/**
 * Combined ffprobe: get duration + subtitle streams in ONE call.
 * Resolves redirects once, then runs a single ffprobe with both requests.
 * This cuts the two sequential ffprobe calls (30s each) down to one.
 */
export function probeVideoInfo(url: string): VideoProbeResult {
  const probeUrl = resolveRedirect(url);
  try {
    const result = execSync(
      `ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=language,title -show_entries format=duration -of csv=p=0 "${probeUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();

    const textCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
    const subtitleStreams: SubtitleStreamInfo[] = [];
    let duration: number | null = null;

    for (const line of result.split('\n')) {
      const parts = line.split(',');
      // Duration line: format=...,{duration}
      if (parts.length >= 3 && parts[2].trim() === 'subtitle') {
        const codec = parts[1].trim().toLowerCase();
        if (textCodecs.includes(codec)) {
          subtitleStreams.push({
            index: parseInt(parts[0]),
            codec,
            lang: (parts[3] || 'und').trim(),
            title: (parts[4] || '').trim(),
          });
        }
      }
      // Format line has duration
      const durMatch = line.match(/duration=([\d.]+)/);
      if (durMatch) { duration = parseFloat(durMatch[1]); }
    }

    return { duration, subtitleStreams };
  } catch {
    return { duration: null, subtitleStreams: [] };
  }
}

// ── Built-in subtitle extraction ──────────────────────────────────
export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  lang: string;
  title?: string;
}

/** List text-based subtitle streams in a video URL via ffprobe. */
export function listSubtitleStreams(videoUrl: string): SubtitleStreamInfo[] {
  try {
    const result = execSync(
      `ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=language,title -of csv=p=0 "${videoUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();
    const textCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
    const streams: SubtitleStreamInfo[] = [];
    for (const line of result.split('\n')) {
      const parts = line.split(',');
      if (parts.length >= 3 && parts[2].trim() === 'subtitle') {
        const codec = parts[1].trim().toLowerCase();
        if (textCodecs.includes(codec)) {
          streams.push({ index: parseInt(parts[0]), codec, lang: (parts[3] || 'und').trim(), title: (parts[4] || '').trim() });
        }
      }
    }
    return streams;
  } catch { return []; }
}

/**
 * Find the best text-based subtitle stream for alignment reference.
 * Prefers English, then falls back to first available.
 */
export function findBestRefSubtitleStream(videoUrl: string): SubtitleStreamInfo | null {
  const streams = listSubtitleStreams(videoUrl);
  if (streams.length === 0) return null;
  console.log(`[aligner] Found ${streams.length} text subtitle streams: ${streams.map(s => `${s.index}:${s.lang}`).join(', ')}`);
  const engStream = streams.find(s => s.lang.startsWith('eng') || s.lang === 'en');
  if (engStream) { console.log(`[aligner] Selected English ref stream: ${engStream.index}`); return engStream; }
  console.log(`[aligner] No English stream, using first: ${streams[0].index}`);
  return streams[0];
}

/**
 * Extract a subtitle track from a video URL as SRT content.
 * Uses timeout — for large files, partial extraction is OK for alignment.
 */
export function extractBuiltinSubtitle(videoUrl: string, streamIndex: number, timeoutSec = 60): string | null {
  const tmpFile = join(tmpdir(), `builtin_sub_${streamIndex}_${Date.now()}.srt`);
  try {
    console.log(`[aligner] Extracting builtin sub stream ${streamIndex} (timeout ${timeoutSec}s)...`);
    execSync(
      `timeout ${timeoutSec} ffmpeg -y -probesize 32 -analyzeduration 0 -i "${videoUrl}" -map 0:${streamIndex} -c:s srt -f srt "${tmpFile}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: (timeoutSec + 10) * 1000 },
    );
    if (existsSync(tmpFile)) {
      const content = readFileSync(tmpFile, 'utf-8');
      try { unlinkSync(tmpFile); } catch {}
      if (content.trim().length > 0) {
        const entryCount = (content.match(/^\d+$/gm) || []).length;
        console.log(`[aligner] Extracted builtin sub: ${content.length} bytes, ${entryCount} entries`);
        return content;
      }
    }
    return null;
  } catch (e: any) {
    // Timeout may leave partial file — recover it
    if (existsSync(tmpFile)) {
      try {
        const content = readFileSync(tmpFile, 'utf-8');
        try { unlinkSync(tmpFile); } catch {}
        if (content.trim().length > 100) {
          const entryCount = (content.match(/^\d+$/gm) || []).length;
          console.log(`[aligner] Recovered partial builtin sub: ${content.length} bytes, ${entryCount} entries`);
          return content;
        }
      } catch {}
    }
    try { unlinkSync(tmpFile); } catch {}
    console.log(`[aligner] Builtin sub extraction failed: ${e.message?.substring(0, 100)}`);
    return null;
  }
}

// ── ffsubsync wrapper ─────────────────────────────────────────────

/** Detect if ffsubsync CLI is available */
export function isFfsubsyncAvailable(): boolean {
  try {
    execSync('ffsubsync --version 2>&1 || ffs --version 2>&1', { encoding: 'utf-8', timeout: 5000 });
    return true;
  } catch { return false; }
}

/**
 * Calculate subtitle sync offset using ffsubsync CLI.
 * Subtitle-to-subtitle alignment (no video/audio needed).
 */
export function calculateOffsetWithFfsubsync(referenceSrtContent: string, targetSrtContent: string): number {
  const refFile = join(tmpdir(), `ffs_ref_${Date.now()}.srt`);
  const targetFile = join(tmpdir(), `ffs_target_${Date.now()}.srt`);
  const outputFile = join(tmpdir(), `ffs_out_${Date.now()}.srt`);

  try {
    writeFileSync(refFile, referenceSrtContent);
    writeFileSync(targetFile, targetSrtContent);

    const result = execSync(
      `ffsubsync "${refFile}" -i "${targetFile}" -o "${outputFile}" --no-fix-framerate 2>&1`,
      { encoding: 'utf-8', timeout: 30000 },
    );

    const offsetMatch = result.match(/offset seconds:\s*([-\d.]+)/);
    const scoreMatch = result.match(/score:\s*([\d.]+)/);

    if (offsetMatch) {
      const offset = parseFloat(offsetMatch[1]);
      const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
      console.log(`[aligner] ffsubsync: offset=${offset.toFixed(3)}s, score=${score}`);
      if (score <= 0) {
        console.log(`[aligner] ffsubsync: low confidence (score<=0), ignoring offset`);
        return 0;
      }
      return offset;
    }
    console.log(`[aligner] ffsubsync: no offset found in output`);
    return 0;
  } catch (e: any) {
    console.log(`[aligner] ffsubsync failed: ${e.message?.substring(0, 200)}`);
    return 0;
  } finally {
    try { unlinkSync(refFile); } catch {}
    try { unlinkSync(targetFile); } catch {}
    try { unlinkSync(outputFile); } catch {}
  }
}

// ── Entry adjustment ──────────────────────────────────────────────
export function adjustEntries(entries: SubtitleEntry[], offset: number): SubtitleEntry[] {
  return entries.map((e) => ({
    start: Math.max(0, e.start + offset),
    end: Math.max(0, e.end + offset),
    text: e.text,
  }));
}
