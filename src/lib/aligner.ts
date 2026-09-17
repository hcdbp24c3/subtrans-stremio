import { execSync } from 'child_process';
import { SubtitleEntry } from './subtitle-parser.js';

const OFFSET_THRESHOLD = 0.5; // seconds — ignore offsets smaller than this
const MAX_OFFSET = 600; // seconds — ignore offsets larger than 10 minutes
const TEXT_SIMILARITY_MIN = 0.6; // minimum text similarity to consider a match

// ── Text normalization for comparison ──────────────────────────────
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')        // strip HTML tags
    .replace(/\{[^}]*\}/g, '')      // strip ASS formatting tags
    .replace(/[^\w\s]/g, '')        // remove punctuation
    .replace(/\s+/g, ' ')           // collapse whitespace
    .trim();
}

/** Simple text similarity (Jaccard on words) */
function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  const wordsA = new Set(na.split(' '));
  const wordsB = new Set(nb.split(' '));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Offset from reference subtitles ────────────────────────────────

/**
 * Calculate offset by comparing two subtitle files (reference vs target).
 */
export function calculateOffsetFromReference(
  reference: SubtitleEntry[],
  target: SubtitleEntry[],
): number {
  if (reference.length === 0 || target.length === 0) return 0;

  const refIndex = reference.map((e) => ({
    text: normalizeText(e.text),
    start: e.start,
  }));

  const targetIndex = target.map((e) => ({
    text: normalizeText(e.text),
    start: e.start,
  }));

  const diffs: number[] = [];

  for (const ref of refIndex) {
    if (!ref.text) continue;

    let bestSim = 0;
    let bestDiff = 0;

    for (const tgt of targetIndex) {
      if (!tgt.text) continue;
      const sim = textSimilarity(ref.text, tgt.text);
      if (sim > bestSim) {
        bestSim = sim;
        bestDiff = ref.start - tgt.start;
      }
    }

    if (bestSim >= TEXT_SIMILARITY_MIN) {
      diffs.push(bestDiff);
    }
  }

  if (diffs.length === 0) return 0;

  // Median of diffs
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];

  if (Math.abs(median) < OFFSET_THRESHOLD) return 0;
  if (Math.abs(median) > MAX_OFFSET) return 0;
  if (diffs.length < 3) return 0;

  // Verify consistency: most diffs should be within 1s of median
  const consistent = diffs.filter((d) => Math.abs(d - median) < 1.0);
  const consistency = consistent.length / diffs.length;
  if (consistency < 0.5) return 0;

  console.log(
    `[aligner] Reference offset: ${median.toFixed(1)}s ` +
    `(matched ${diffs.length} entries, ${Math.round(consistency * 100)}% consistent)`
  );

  return median;
}

// ── Offset from video duration ─────────────────────────────────────

/**
 * Calculate offset by comparing subtitle time range with video duration.
 *
 * Uses the LAST subtitle entry's timestamp vs video duration to detect
 * systematic offset. If the last sub ends much earlier than the video,
 * the subs may be shifted early (positive offset needed).
 */
export function calculateOffsetFromDuration(
  entries: SubtitleEntry[],
  videoDuration: number,
): number {
  if (entries.length === 0 || videoDuration <= 0) return 0;

  // Use the last entry's end time vs video duration
  const maxEnd = Math.max(...entries.map((e) => e.end));
  const minStart = Math.min(...entries.map((e) => e.start));

  // The offset is the difference between video end and sub end
  // This detects if subs end before the video does (shift forward)
  // or after (shift backward)
  const rawOffset = videoDuration - maxEnd;

  if (Math.abs(rawOffset) < OFFSET_THRESHOLD) return 0;
  if (Math.abs(rawOffset) > MAX_OFFSET) return 0;

  console.log(
    `[aligner] Duration offset: ${rawOffset.toFixed(1)}s ` +
    `(sub ends at ${maxEnd.toFixed(0)}s, video ${videoDuration.toFixed(0)}s)`
  );

  return rawOffset;
}

// ── Video duration via ffprobe ─────────────────────────────────────

/**
 * Get video duration by probing the URL.
 * Uses curl to follow redirects (Node.js fetch gets 404 from some CDNs
 * due to Cloudflare/TLS fingerprinting), then ffprobe the final URL.
 */
export async function getVideoDuration(url: string): Promise<number | null> {
  try {
    // Step 1: Use curl to follow redirects and get the final CDN URL
    let probeUrl = url;
    const location = execSync(
      `curl -sI --max-time 10 "${url}" 2>/dev/null | grep -i "^location:" | tail -1 | tr -d '\\r' | awk '{print $2}'`,
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();

    if (location) {
      probeUrl = location;
    }

    // Step 2: ffprobe the final URL
    const result = execSync(
      `ffprobe -v error -show_entries format=duration -analyzeduration 5000000 -probesize 1000000 "${probeUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();

    const match = result.match(/duration=([\d.]+)/);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// ── Entry adjustment ──────────────────────────────────────────────

export function adjustEntries(
  entries: SubtitleEntry[],
  offset: number,
): SubtitleEntry[] {
  return entries.map((e) => ({
    start: Math.max(0, e.start + offset),
    end: Math.max(0, e.end + offset),
    text: e.text,
  }));
}
