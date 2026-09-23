import { exec, execSync } from 'child_process';
import { writeFileSync, existsSync, readFileSync, unlinkSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { SubtitleEntry } from './subtitle-parser.js';

const OFFSET_THRESHOLD = 0.5;
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

async function resolveRedirectAsync(url: string): Promise<string> {
  try {
    const location = (await execAsync(
      `curl -sI --max-time 10 "${url}" 2>/dev/null | grep -i "^location:" | tail -1 | tr -d '\\r' | awk '{print $2}'`,
      15000,
    )).trim();
    return location || url;
  } catch { return url; }
}

export async function getVideoDuration(url: string): Promise<number | null> {
  try {
    const probeUrl = await resolveRedirectAsync(url);
    const result = (await execAsync(
      `ffprobe -v error -show_entries format=duration -analyzeduration 5000000 -probesize 1000000 "${probeUrl}" 2>/dev/null`,
      30000,
    )).trim();
    const match = result.match(/duration=([\d.]+)/);
    return match ? parseFloat(match[1]) : null;
  } catch { return null; }
}

export interface VideoProbeResult {
  duration: number | null;
  subtitleStreams: SubtitleStreamInfo[];
}

/**
 * Parse one ffprobe CSV line for format duration.
 * Handles `duration=N` and bare `N` (`-of csv=p=0`).
 * Returns null when the line is not a duration value.
 */
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

/**
 * Combined ffprobe: get duration + subtitle streams in ONE call.
 * Resolves redirects once, then runs a single ffprobe with both requests.
 * This cuts the two sequential ffprobe calls (30s each) down to one.
 */
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

export function probeVideoInfo(url: string): VideoProbeResult {
  const probeUrl = resolveRedirect(url);
  try {
    const result = execSync(
      `ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=language,title -show_entries format=duration -of csv=p=0 "${probeUrl}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 30000 },
    ).trim();
    return parseProbeOutput(result);
  } catch {
    return { duration: null, subtitleStreams: [] };
  }
}

/** Non-blocking ffprobe — safe to run after the HTTP response is sent. */
export async function probeVideoInfoAsync(url: string): Promise<VideoProbeResult> {
  try {
    const probeUrl = await resolveRedirectAsync(url);
    const result = (await execAsync(
      `ffprobe -v error -show_entries stream=index,codec_name,codec_type:stream_tags=language,title -show_entries format=duration -of csv=p=0 "${probeUrl}" 2>/dev/null`,
      30000,
    )).trim();
    return parseProbeOutput(result);
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
export async function extractBuiltinSubtitle(
  videoUrl: string,
  streamIndex: number,
  timeoutSec = 60,
): Promise<string | null> {
  const tmpFile = join(tmpdir(), `builtin_sub_${streamIndex}_${Date.now()}.srt`);
  try {
    console.log(`[aligner] Extracting builtin sub stream ${streamIndex} (timeout ${timeoutSec}s)...`);
    await execAsync(
      `timeout ${timeoutSec} ffmpeg -y -probesize 32 -analyzeduration 0 -i "${videoUrl}" -map 0:${streamIndex} -c:s srt -f srt "${tmpFile}" 2>/dev/null`,
      (timeoutSec + 10) * 1000,
    );
    if (existsSync(tmpFile)) {
      const content = readFileSync(tmpFile, 'utf-8');
      try { unlinkSync(tmpFile); } catch {}
      if (content.trim().length > 0) {
        console.log(`[aligner] Extracted builtin sub: ${content.length} bytes, ${countSrtEntries(content)} entries`);
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
          console.log(`[aligner] Recovered partial builtin sub: ${content.length} bytes, ${countSrtEntries(content)} entries`);
          return content;
        }
      } catch {}
    }
    try { unlinkSync(tmpFile); } catch {}
    console.log(`[aligner] Builtin sub extraction failed: ${e.message?.substring(0, 100)}`);
    return null;
  }
}

// ── ffsubsync wrapper (Python library bridge) ─────────────────────

/** Absolute path to the Python bridge (ships next to this file in dist/ or src/). */
export function resolveFfsubsyncBridge(): string {
  if (process.env.FFSUBSYNC_BRIDGE) return process.env.FFSUBSYNC_BRIDGE;
  return fileURLToPath(new URL('./ffsubsync_run.py', import.meta.url));
}

/** Detect if the Python ffsubsync library bridge is available */
export function isFfsubsyncAvailable(): boolean {
  try {
    const script = resolveFfsubsyncBridge();
    execSync(
      `test -f "${script}" && python3 -c "from ffsubsync.ffsubsync import run, make_parser" 2>&1`,
      { encoding: 'utf-8', timeout: 8000 },
    );
    return true;
  } catch { return false; }
}

/** Parse ffsubsync CLI stdout for offset + score. Returns null if no offset line. */
export function parseFfsubsyncOutput(output: string): { offset: number; score: number } | null {
  const offsetMatch = output.match(/offset seconds:\s*([-\d.]+)/);
  if (!offsetMatch) return null;
  const scoreMatch = output.match(/score:\s*([\d.]+)/);
  return {
    offset: parseFloat(offsetMatch[1]),
    score: scoreMatch ? parseFloat(scoreMatch[1]) : 0,
  };
}

/** Parse JSON last-line from the Python bridge. Returns null if unusable.
 *  ok=true with offset=0 is a valid "already synced" result (not a failure). */
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
      return null; // valid JSON but not ok → stop
    } catch { /* keep scanning upward */ }
  }
  return null;
}

/** Count numbered SRT cue indices in content (diagnostics). */
export function countSrtEntries(content: string): number {
  return (content.match(/^\d+$/gm) || []).length;
}

export interface BridgeRunResult {
  /** Effective offset after confidence gate (0 when low confidence / failure). */
  offset: number;
  /** True when the bridge completed with score > 0 (result is cacheable). */
  ok: boolean;
}

/**
 * Run the Python library bridge (`ffsubsync.run`) without blocking the event loop.
 * ok=false → failure / low confidence (try next cascade step).
 * ok=true  → definitive answer, including offset=0 (already synced).
 */
async function runFfsubsyncBridge(args: string[], label: string, timeoutMs = 30000): Promise<BridgeRunResult> {
  const script = resolveFfsubsyncBridge();
  try {
    const quoted = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    const result = await execAsync(
      `python3 "${script}" ${quoted} 2>/dev/null`,
      timeoutMs,
    );
    const parsed = parseFfsubsyncBridgeJson(result);
    if (!parsed) {
      console.log(`[aligner] ffsubsync(${label}): no usable offset from bridge`);
      return { offset: 0, ok: false };
    }
    if (parsed.score <= 0) {
      console.log(`[aligner] ffsubsync(${label}): low confidence (score<=0), ignoring offset`);
      return { offset: 0, ok: false };
    }
    console.log(`[aligner] ffsubsync(${label}): offset=${parsed.offset.toFixed(3)}s, score=${parsed.score}`);
    return { offset: parsed.offset, ok: true };
  } catch (e: any) {
    console.log(`[aligner] ffsubsync(${label}) failed: ${e.message?.substring(0, 200)}`);
    return { offset: 0, ok: false };
  }
}

/**
 * Sync target against a local reference (SRT or WAV) via the library bridge.
 */
async function runFfsubsyncLocal(refPath: string, targetSubContent: string, label: string): Promise<BridgeRunResult> {
  const targetFile = join(tmpdir(), `ffs_target_${Date.now()}.srt`);
  try {
    writeFileSync(targetFile, targetSubContent, 'utf-8');
    return await runFfsubsyncBridge(['sub-to-sub', refPath, targetFile], label, 30000);
  } finally {
    try { unlinkSync(targetFile); } catch {}
  }
}

/**
 * Extract a bounded local audio sample (mono 16 kHz WAV) from a video URL.
 * Partial file on timeout is accepted if large enough for ffsubsync.
 */
export async function extractAudioSample(videoUrl: string, seconds = 180, timeoutSec = 45): Promise<string | null> {
  const tmpFile = join(tmpdir(), `audio_sample_${Date.now()}.wav`);
  const cmd = `timeout ${timeoutSec} ffmpeg -y -i "${videoUrl}" -t ${seconds} -vn -ac 1 -ar 16000 -c:a pcm_s16le "${tmpFile}" 2>/dev/null`;
  try {
    console.log(`[aligner] Extracting ${seconds}s audio sample (timeout ${timeoutSec}s)...`);
    await execAsync(cmd, (timeoutSec + 5) * 1000);
  } catch {
    // timeout(1) leaves a partial WAV — recover if usable
    if (existsSync(tmpFile)) {
      try {
        const size = statSync(tmpFile).size;
        // WAV header 44B + ≥5s of 16-bit mono 16 kHz
        if (size > 44 + 5 * 16000 * 2) {
          console.log(`[aligner] Recovered partial audio sample: ${size} bytes`);
          return tmpFile;
        }
      } catch {}
    }
    try { unlinkSync(tmpFile); } catch {}
    console.log(`[aligner] Audio sample extract failed`);
    return null;
  }
  if (existsSync(tmpFile)) {
    try {
      const size = statSync(tmpFile).size;
      if (size > 44 + 5 * 16000 * 2) {
        console.log(`[aligner] Audio sample ready: ${size} bytes`);
        return tmpFile;
      }
    } catch {}
    try { unlinkSync(tmpFile); } catch {}
  }
  return null;
}

/**
 * Sync a subtitle against the VIDEO (audio/VAD reference) via the library bridge.
 * --fast: extract-audio-first + max-duration 60 + ref-stream a:0
 * (skips the slow "Checking video for subtitles stream" probe that hangs
 * on large remote REMUXes; copies only the first 60s of audio).
 * Works when the video has no text builtin subs (PGS-only remuxes).
 */
export async function calculateOffsetWithFfsubsyncVideo(
  videoUrl: string,
  targetSubContent: string,
): Promise<BridgeRunResult> {
  const targetFile = join(tmpdir(), `ffs_target_${Date.now()}.srt`);
  try {
    writeFileSync(targetFile, targetSubContent, 'utf-8');
    return await runFfsubsyncBridge(
      ['video', videoUrl, targetFile, '--fast'],
      'video-fast',
      60000,
    );
  } finally {
    try { unlinkSync(targetFile); } catch {}
  }
}

export type OffsetMethod = 'builtin-sub' | 'audio-sample' | 'video-remote';

export interface SmartOffsetResult {
  offset: number;
  method: OffsetMethod;
  /** True when alignment finished with a definitive answer (including offset=0). */
  completed: boolean;
}

/**
 * Fast offset cascade (benchmarked on 62GB Real-Debrid REMUX):
 *  1. Builtin text sub extract → library sub-to-sub (~30s extract + ~1s sync)
 *  2. Library video --fast (extract-audio-first 60s → ~35s total)
 *  3. Bounded local audio sample → library sub-to-sub (fallback)
 *
 * Does not block the event loop. completed=false means every step failed
 * (do not cache). completed=true with offset=0 means "already synced" (cache).
 */
export async function calculateOffsetSmart(
  videoUrl: string,
  targetSubContent: string,
  textStreams: SubtitleStreamInfo[] = [],
): Promise<SmartOffsetResult> {
  // 1) Builtin text subtitle reference (fastest reliable path)
  const eng = textStreams.find((s) => s.lang.startsWith('eng') || s.lang === 'en')
    ?? textStreams[0];
  if (eng) {
    const refSrt = await extractBuiltinSubtitle(videoUrl, eng.index, 30);
    if (refSrt && countSrtEntries(refSrt) >= 3) {
      const refPath = writeTempSrt(refSrt, `ref_${eng.index}`);
      try {
        const result = await runFfsubsyncLocal(refPath, targetSubContent, `builtin-sub#${eng.index}`);
        if (result.ok) return { offset: result.offset, method: 'builtin-sub', completed: true };
      } finally {
        try { unlinkSync(refPath); } catch {}
      }
    }
  }

  // 2) Library video path with --fast (extract-audio-first, bounded)
  const videoResult = await calculateOffsetWithFfsubsyncVideo(videoUrl, targetSubContent);
  if (videoResult.ok) return { offset: videoResult.offset, method: 'video-remote', completed: true };

  // 3) Local audio sample + library sub-to-sub (works for PGS-only remuxes)
  const wavPath = await extractAudioSample(videoUrl, 180, 45);
  if (wavPath) {
    try {
      const result = await runFfsubsyncLocal(wavPath, targetSubContent, 'audio-sample');
      if (result.ok) return { offset: result.offset, method: 'audio-sample', completed: true };
    } finally {
      try { unlinkSync(wavPath); } catch {}
    }
  }

  return { offset: 0, method: 'video-remote', completed: false };
}

function writeTempSrt(content: string, prefix: string): string {
  const p = join(tmpdir(), `ffs_${prefix}_${Date.now()}.srt`);
  writeFileSync(p, content, 'utf-8');
  return p;
}

/**
 * Calculate subtitle sync offset using the ffsubsync library bridge (sub-to-sub).
 * Prefer calculateOffsetSmart when a video URL is available.
 */
export async function calculateOffsetWithFfsubsync(
  referenceSrtContent: string,
  targetSrtContent: string,
): Promise<BridgeRunResult> {
  const refFile = join(tmpdir(), `ffs_ref_${Date.now()}.srt`);
  try {
    writeFileSync(refFile, referenceSrtContent);
    return await runFfsubsyncLocal(refFile, targetSrtContent, 'sub-to-sub');
  } finally {
    try { unlinkSync(refFile); } catch {}
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
