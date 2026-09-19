import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { SubtitleEntry, parseSubtitle, SubtitleFormat } from './subtitle-parser.js';

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

// ── Audio-based dialogue start detection ───────────────────────────

/**
 * Detect when the first dialogue starts in the video using ffmpeg silence detection.
 *
 * Uses ffmpeg's silencedetect filter on the first 3 minutes of audio to find
 * when actual audio content (dialogue) begins. Skips initial silence (studio logos)
 * and returns the timestamp of the first significant audio segment.
 *
 * This is more reliable than duration-based alignment because it directly
 * measures when audio content starts, rather than comparing end timestamps
 * (which are unreliable due to credits gaps).
 *
 * @returns timestamp in seconds when first dialogue starts, or null if detection fails
 */
export function detectDialogueStart(videoUrl: string): number | null {
  try {
    // Step 1: Use curl to follow redirects and get the final CDN URL
    let probeUrl = videoUrl;
    const location = execSync(
      `curl -sI --max-time 10 "${videoUrl}" 2>/dev/null | grep -i "^location:" | tail -1 | tr -d '\\r' | awk '{print $2}'`,
      { encoding: 'utf-8', timeout: 15000 },
    ).trim();

    if (location) {
      probeUrl = location;
      console.log(`[aligner] Resolved URL: ${probeUrl.substring(0, 120)}...`);
    }

    // Step 2: Detect silence boundaries using ffmpeg
    // Use 90s window (not 3min) — faster, less likely to timeout on debrid URLs
    // -30dB threshold — slightly more aggressive than -35dB to catch quieter dialogue
    // 1.5s minimum duration — filter out brief pauses
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const ffmpegCmd = [
      `ffmpeg -user_agent "${ua}"`,
      `-i "${probeUrl}"`,
      `-t 90`,
      `-af silencedetect=n=-30dB:d=1.5`,
      `-f null - 2>&1`,
    ].join(' ');
    console.log(`[aligner] Running ffmpeg silencedetect (90s window)...`);

    // Capture full output (not just grep) for debugging
    const fullOutput = execSync(ffmpegCmd, { encoding: 'utf-8', timeout: 90000 }).trim();

    // Parse all silence_end timestamps from full output
    const ends: number[] = [];
    for (const line of fullOutput.split('\n')) {
      const match = line.match(/silence_end:\s*([\d.]+)/);
      if (match) {
        ends.push(parseFloat(match[1]));
      }
    }

    if (ends.length === 0) {
      // Log some of the ffmpeg output for debugging
      const stderr = fullOutput.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid') || l.includes('failed'));
      if (stderr.length > 0) {
        console.log(`[aligner] ffmpeg errors: ${stderr.slice(0, 3).join(' | ')}`);
      } else {
        console.log(`[aligner] No silence_end in ffmpeg output (${fullOutput.split('\n').length} lines total)`);
      }
      return null;
    }

    // The first silence_end is when the first audio content starts
    // Skip very early detections (< 3s) which are likely studio logo sounds
    const firstDialogue = ends.find((t) => t >= 3.0) ?? ends[0];

    console.log(
      `[aligner] Dialogue start detected at ${firstDialogue.toFixed(1)}s ` +
      `(${ends.length} audio segments found in first 90s)`
    );

    return firstDialogue;
  } catch (e: any) {
    console.log(`[aligner] Dialogue detection failed: ${e.message?.substring(0, 300)}`);
    return null;
  }
}

/**
 * Calculate offset by detecting when dialogue starts in the video
 * and comparing with the first subtitle entry.
 *
 * If the first subtitle starts at 31s but dialogue starts at 60s,
 * the subs are 29s early → offset = +29s (shift subs forward).
 */
export function calculateOffsetFromDialogue(
  entries: SubtitleEntry[],
  dialogueStart: number,
): number {
  if (entries.length === 0 || dialogueStart <= 0) return 0;

  // Use the first few subtitle entries to estimate when dialogue "should" start
  // Sort by start time and take the earliest entries
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const firstSubStart = sorted[0].start;

  // The offset is: when dialogue actually starts - when first subtitle says it starts
  // Positive = subs are early (need to shift forward)
  // Negative = subs are late (need to shift backward)
  const rawOffset = dialogueStart - firstSubStart;

  if (Math.abs(rawOffset) < OFFSET_THRESHOLD) return 0;
  if (Math.abs(rawOffset) > MAX_OFFSET) return 0;

  // Confidence check: also verify with 2nd and 3rd entries if available
  if (sorted.length >= 3) {
    const offsets = [
      dialogueStart - sorted[0].start,
      dialogueStart - sorted[1].start + (sorted[1].start - sorted[0].start),
    ];
    // If the offsets diverge significantly, confidence is low
    if (Math.abs(offsets[0] - offsets[1]) > 5.0) {
      console.log(
        `[aligner] Dialogue offset inconsistent (${offsets[0].toFixed(1)}s vs ${offsets[1].toFixed(1)}s), skipping`
      );
      return 0;
    }
  }

  console.log(
    `[aligner] Dialogue offset: ${rawOffset.toFixed(1)}s ` +
    `(dialogue at ${dialogueStart.toFixed(1)}s, first sub at ${firstSubStart.toFixed(1)}s)`
  );

  return rawOffset;
}

// ── Built-in subtitle extraction + comparison ─────────────────────

/**
 * Extract the first text-based subtitle track from a video URL.
 *
 * Built-in subs (SRT/ASS embedded in the video) are always correctly synced
 * because they're part of the same encode. External subs may be for a
 * different encode with different intro/outro padding.
 *
 * This works on debrid URLs because subtitle tracks are tiny (~KB)
 * — ffmpeg can extract them in seconds even on slow connections.
 *
 * @returns parsed subtitle entries, or null if extraction fails
 */
export function extractBuiltinSubtitles(videoUrl: string): SubtitleEntry[] | null {
  try {
    // Step 1: List subtitle streams in the video
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const streamInfo = execSync(
      `ffprobe -user_agent "${ua}" -v error -show_entries stream=index,codec_name,codec_type -of csv=p=0 "${videoUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();

    if (!streamInfo) {
      console.log(`[aligner] No streams found in video`);
      return null;
    }

    // Find text-based subtitle streams (skip PGS — bitmap, can't convert to text)
    const textCodecs = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'];
    const subStreams: { index: number; codec: string }[] = [];

    for (const line of streamInfo.split('\n')) {
      const parts = line.split(',');
      if (parts.length >= 3 && parts[2].trim() === 'subtitle') {
        const codec = parts[1].trim().toLowerCase();
        if (textCodecs.includes(codec)) {
          subStreams.push({ index: parseInt(parts[0]), codec });
        }
      }
    }

    if (subStreams.length === 0) {
      console.log(`[aligner] No text-based subtitle streams (skipped PGS/bitmap)`);
      return null;
    }

    console.log(`[aligner] Found ${subStreams.length} text subtitle stream(s): ${subStreams.map(s => `${s.index}:${s.codec}`).join(', ')}`);

    // Step 2: Try ONLY the first text stream — debrid URLs are extremely slow
    // for MKV seeking (each attempt can take 30-60s+)
    const stream = subStreams[0];
    try {
      const tmpFile = `/tmp/builtin_sub_${stream.index}_${Date.now()}.srt`;
      console.log(`[aligner] Extracting stream ${stream.index} (${stream.codec})...`);

      // Pipe to stdout via -f srt to avoid file I/O issues
      const result = execSync(
        `ffmpeg -user_agent "${ua}" -probesize 32 -analyzeduration 0 -i "${videoUrl}" -map 0:${stream.index} -c:s srt -f srt - 2>/dev/null`,
        { encoding: 'utf-8', timeout: 30000 },
      );

      if (result && result.trim().length > 0) {
        const entries = parseSubtitle(result, 'srt' as SubtitleFormat);
        if (entries.length > 0) {
          console.log(`[aligner] Extracted built-in subtitle stream ${stream.index}: ${entries.length} entries`);
          return entries;
        }
        console.log(`[aligner] Stream ${stream.index}: parsed 0 entries from ${result.length} chars`);
      } else {
        console.log(`[aligner] Stream ${stream.index}: empty output`);
      }
    } catch (e: any) {
      console.log(`[aligner] Stream ${stream.index} extraction failed: ${e.message?.substring(0, 200)}`);
    }

    console.log(`[aligner] Could not extract usable subtitle from video`);
    return null;
  } catch (e: any) {
    console.log(`[aligner] Built-in sub extraction failed: ${e.message?.substring(0, 200)}`);
    return null;
  }
}

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
