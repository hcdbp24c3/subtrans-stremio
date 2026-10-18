import { exec, execSync } from 'child_process';
import { SubtitleEntry } from './subtitle-parser.js';

const OFFSET_THRESHOLD = 0.25;
const MAX_OFFSET = 600;
const TEXT_SIMILARITY_MIN = 0.6;

/** Run a shell command without blocking the Node event loop. */
function execAsync(
  cmd: string,
  timeoutMs: number,
  maxBuffer = 4 * 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { encoding: 'utf-8', timeout: timeoutMs, maxBuffer },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

// ── Text normalization & similarity ───────────────────────────────
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function textSimilarity(a: string, b: string): number {
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

// ── Cue Timing Sub-to-Sub Comparison ──────────────────────────────

export interface SubTimingOffsetResult {
  offset: number;
  score: number;
  matchedCues: number;
  totalCues: number;
}

/**
 * Compare dialogue start times and speech pauses between two subtitles of
 * possibly DIFFERENT languages (e.g. English benchmark vs Vietnamese target).
 *
 * Runs in pure TypeScript (<5ms), without Python, ffmpeg, or audio downloads.
 * Offset convention: offset = ref.start - target.start.
 * Positive offset means target starts early, needs to be shifted forward.
 */
export function calculateOffsetFromTiming(
  reference: SubtitleEntry[],
  target: SubtitleEntry[],
): SubTimingOffsetResult {
  if (reference.length < 3 || target.length < 3) {
    return { offset: 0, score: 0, matchedCues: 0, totalCues: target.length };
  }

  const refStarts = reference.map((e) => e.start).sort((a, b) => a - b);
  const targetStarts = target.map((e) => e.start).sort((a, b) => a - b);

  // Extract anchor cues: first cue + cues occurring after a pause >= 2.5s
  const extractAnchors = (starts: number[]): number[] => {
    const anchors: number[] = [starts[0]];
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] - starts[i - 1] >= 2.5) {
        anchors.push(starts[i]);
      }
    }
    return anchors;
  };

  const refAnchors = extractAnchors(refStarts);
  const targetAnchors = extractAnchors(targetStarts);

  // Collect candidate offsets in range [-60s, +60s]
  const candidateBins = new Map<number, number>();
  const addCandidate = (delta: number) => {
    if (Math.abs(delta) > 60) return;
    const bin = Math.round(delta * 10) / 10; // 0.1s binning
    candidateBins.set(bin, (candidateBins.get(bin) || 0) + 1);
  };

  // 1. Compare anchor pairs
  for (const t of targetAnchors) {
    for (const r of refAnchors) {
      addCandidate(r - t);
    }
  }

  // 2. Also sample first 30 cues to guarantee initial alignment detection
  const sampleCount = Math.min(30, targetStarts.length, refStarts.length);
  for (let i = 0; i < sampleCount; i++) {
    for (let j = 0; j < sampleCount; j++) {
      addCandidate(refStarts[j] - targetStarts[i]);
    }
  }

  // Always test 0.0 offset
  candidateBins.set(0, (candidateBins.get(0) || 0) + 1);

  // Pick top candidate bins with the highest votes
  const topBins = Array.from(candidateBins.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([bin]) => bin);

  let bestScore = 0;
  let bestOffset = 0;
  let bestMatched = 0;

  for (const candidate of topBins) {
    let matched = 0;
    const residuals: number[] = [];

    let refIdx = 0;
    for (const t of targetStarts) {
      const expected = t + candidate;
      while (refIdx < refStarts.length && refStarts[refIdx] < expected - 0.5) {
        refIdx++;
      }
      if (refIdx < refStarts.length && Math.abs(refStarts[refIdx] - expected) <= 0.5) {
        matched++;
        residuals.push(refStarts[refIdx] - expected);
      }
    }

    const score = matched / targetStarts.length;
    if (score > bestScore) {
      bestScore = score;
      bestMatched = matched;
      residuals.sort((a, b) => a - b);
      const medianResidual = residuals.length > 0 ? residuals[Math.floor(residuals.length / 2)] : 0;
      bestOffset = candidate + medianResidual;
    }
  }

  // Accept if at least 35% of cues match within 0.5s tolerance (and at least 5 cues)
  if (bestScore >= 0.35 && bestMatched >= Math.min(5, targetStarts.length)) {
    const finalOffset = Math.round(bestOffset * 1000) / 1000;
    return {
      offset: Math.abs(finalOffset) < OFFSET_THRESHOLD ? 0 : finalOffset,
      score: bestScore,
      matchedCues: bestMatched,
      totalCues: targetStarts.length,
    };
  }

  return { offset: 0, score: 0, matchedCues: 0, totalCues: targetStarts.length };
}

// ── Offset from reference subtitles (Timing first, Text fallback) ──
export function calculateOffsetFromReference(
  reference: SubtitleEntry[],
  target: SubtitleEntry[],
): number {
  if (reference.length === 0 || target.length === 0) return 0;

  // 1. Try timing-based comparison (works across any languages)
  const timing = calculateOffsetFromTiming(reference, target);
  if (timing.score >= 0.35) {
    return timing.offset;
  }

  // 2. Fall back to text similarity (for same-language subs)
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

  return median;
}

// ── Video probe (combined duration + streams) ─────────────────────

async function resolveRedirectAsync(url: string): Promise<string> {
  try {
    const location = (await execAsync(
      `curl -sI --max-time 5 "${url}" 2>/dev/null | grep -i "^location:" | tail -1 | tr -d '\\r' | awk '{print $2}'`,
      6000,
    )).trim();
    return location || url;
  } catch { return url; }
}

export function parseDurationFromProbeLine(line: string): number | null {
  const durMatch = line.match(/duration=([\d.]+)/);
  if (durMatch) return parseFloat(durMatch[1]);
  const trimmed = line.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const n = parseFloat(trimmed);
    if (n > 0) return n;
  }
  return null;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  lang: string;
  title?: string;
}

export interface VideoProbeResult {
  duration: number | null;
  subtitleStreams: SubtitleStreamInfo[];
}

function parseProbeOutput(result: string): VideoProbeResult {
  const textCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
  const subtitleStreams: SubtitleStreamInfo[] = [];
  let duration: number | null = null;

  for (const line of result.split('\n')) {
    const parts = line.split(',');
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
    const d = parseDurationFromProbeLine(line);
    if (d !== null) duration = d;
  }

  return { duration, subtitleStreams };
}

export async function probeVideoInfoAsync(url: string, timeoutMs = 6000): Promise<VideoProbeResult> {
  try {
    const probeUrl = await resolveRedirectAsync(url);
    const isHttp = /^https?:\/\//i.test(probeUrl);
    const netTimeout = isHttp ? '-timeout 5000000' : '';
    const result = (await execAsync(
      `ffprobe -v error ${netTimeout} -analyzeduration 2000000 -probesize 1000000 -show_entries stream=index,codec_name,codec_type:stream_tags=language,title -show_entries format=duration -of csv=p=0 "${probeUrl}" 2>/dev/null`,
      timeoutMs,
    )).trim();
    return parseProbeOutput(result);
  } catch {
    return { duration: null, subtitleStreams: [] };
  }
}

// ── Subtitle adjustment ───────────────────────────────────────────
export function adjustEntries(entries: SubtitleEntry[], offset: number): SubtitleEntry[] {
  return entries.map((e) => ({
    start: Math.max(0, e.start + offset),
    end: Math.max(0, e.end + offset),
    text: e.text,
  }));
}

// ── Lightweight parser stubs (for test compatibility) ─────────────
export function parseFfsubsyncOutput(output: string): { offset: number; score: number } | null {
  const offsetMatch = output.match(/offset seconds:\s*([-\d.]+)/);
  if (!offsetMatch) return null;
  const scoreMatch = output.match(/score:\s*([\d.]+)/);
  return {
    offset: parseFloat(offsetMatch[1]),
    score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
  };
}

export function parseFfsubsyncBridgeJson(output: string): { offset: number; score: number } | null {
  const lines = output.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const j = JSON.parse(line) as { offset?: number; score?: number; ok?: boolean };
      if (j.ok && typeof j.offset === 'number') {
        return { offset: j.offset, score: typeof j.score === 'number' ? j.score : 0 };
      }
      return null;
    } catch { /* skip */ }
  }
  return null;
}

export function countSrtEntries(content: string): number {
  return (content.match(/^\d+$/gm) || []).length;
}

export function isFfsubsyncAvailable(): boolean {
  return false;
}
