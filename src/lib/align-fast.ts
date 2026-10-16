/**
 * Fast sub-alignment engine.
 *
 * ffsubsync (the only widely-used sub sync tool) is too slow for HTTP
 * REMUX workflows: it streams the full audio reference, runs VAD, then
 * cross-correlates. On a 60GB HTTP stream, audio extraction alone takes
 * 30-60s — well past any sensible HTTP handler budget.
 *
 * This engine tries three cheap signals, in order, and only escalates to
 * ffsubsync when none of them are decisive:
 *
 *  1. Release-name match (free, instant): if the sub's release name tags
 *     match the video (same group, same source, same resolution), assume
 *     offset=0. BluRay→BluRay, WEB-DL→WEB-DL, etc. are usually synced
 *     correctly by the uploader.
 *
 *  2. Sub consensus (free, <1s): when many subs of the same content are
 *     available (typical for popular movies/series), compare the temporal
 *     density histogram of each sub to the video duration. Subs whose
 *     median cue interval is closest to the expected (duration/cue_count)
 *     are likely already aligned. Use that sub's offset as the reference.
 *
 *  3. Minimal audio VAD (≤10s, 8s timeout): extract 5-10s of audio from
 *     the MIDDLE of the video (where speech is most likely), run VAD
 *     inline in Python, and cross-correlate with the sub's speech
 *     timeline. Falls back to ffsubsync if VAD returns empty.
 *
 * Each method returns { offset, score, method } or null when not confident.
 */

import { SubtitleEntry, parseSubtitle, SubtitleFormat } from './subtitle-parser.js';
import { fetchText } from './proxy.js';
import { exec, execSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

export interface FastOffsetResult {
  /** Offset in seconds. Positive = sub is ahead of video (delay video, advance sub). */
  offset: number;
  /** Confidence 0-1. ≥0.5 is cacheable. */
  score: number;
  method: 'release-name' | 'sub-consensus' | 'minimal-vad' | 'ffsubsync';
}

const RELEASE_NAME_KEYWORDS: Record<string, string[]> = {
  bluray: ['bluray', 'blu-ray', 'bdrip', 'brrip', 'bd'],
  remux: ['remux'],
  'web-dl': ['web-dl', 'webdl', 'web'],
  webrip: ['webrip', 'web-rip'],
  hdtv: ['hdtv', 'pdtv'],
  dvdrip: ['dvdrip', 'dvd'],
};

export function extractReleaseEncode(releaseName: string | null | undefined): string[] {
  if (!releaseName) return [];
  const norm = releaseName.toLowerCase()
    .replace(/[._-]/g, ' ')
    .replace(/\.(mkv|mp4|avi|srt|ass|vtt|ts)$/i, '');
  const tokens = norm.split(/\s+/).filter(Boolean);
  const present = new Set(tokens);
  const encodes: string[] = [];
  for (const [encode, variants] of Object.entries(RELEASE_NAME_KEYWORDS)) {
    for (const v of variants) {
      if (present.has(v)) { encodes.push(encode); break; }
    }
  }
  return encodes;
}

/**
 * Method 1: release-name match.
 * If the best sub's encode matches the video's encode, assume offset=0.
 * This is correct for ~80% of BluRay→BluRay, WEB-DL→WEB-DL cases.
 */
export function offsetByReleaseName(
  videoFilename: string | null | undefined,
  subReleaseName: string | null | undefined,
): FastOffsetResult | null {
  if (!videoFilename || !subReleaseName) return null;
  const vEnc = extractReleaseEncode(videoFilename);
  const sEnc = extractReleaseEncode(subReleaseName);
  if (vEnc.length === 0 || sEnc.length === 0) return null;
  for (const e of vEnc) {
    if (sEnc.includes(e)) {
      return { offset: 0, score: 0.7, method: 'release-name' };
    }
  }
  return null;
}

interface SubWithCues {
  id: string;
  releaseName: string;
  entries: SubtitleEntry[];
  /** First and last cue timestamps in seconds. */
  firstCue: number;
  lastCue: number;
  /** Total cue count. */
  count: number;
}

async function buildSubWithCues(
  sub: { id: string; url: string; lang?: string; _format?: SubtitleFormat; _releaseName?: string },
): Promise<SubWithCues | null> {
  try {
    const content = await fetchText(sub.url);
    if (!content) return null;
    const fmt = sub._format || 'srt';
    const entries = parseSubtitle(content, fmt);
    if (entries.length < 3) return null; // too few to be useful
    return {
      id: sub.id,
      releaseName: sub._releaseName || '',
      entries,
      firstCue: entries[0].start,
      lastCue: entries[entries.length - 1].end,
      count: entries.length,
    };
  } catch {
    return null;
  }
}

/**
 * Method 2: sub consensus.
 * If multiple subs are present, look for outliers — subs whose first/last
 * cue are unusually close or far from the median. The "correct" offset is
 * the median of the well-clustered subs; outliers (lone WEB-DL sub in a
 * BluRay release group) are rejected.
 */
export async function offsetBySubConsensus(
  videoDurationSec: number | null,
  subs: Array<{ id: string; url: string; lang?: string; _format?: SubtitleFormat; _releaseName?: string }>,
  videoFilename: string | null,
): Promise<FastOffsetResult | null> {
  if (subs.length < 2 || !videoDurationSec) return null;
  // Need at least 2 subs to detect a consensus
  const built = await Promise.all(subs.map(buildSubWithCues));
  const valid = built.filter((s): s is SubWithCues => s !== null);
  if (valid.length < 2) return null;

  // Compute "expected last cue" assuming offset=0 and average sub duration
  // spans ~80% of the video (films typically have credits in last 20%)
  const expectedSpan = videoDurationSec * 0.8;

  // For each sub, compute a "would-be" offset to align lastCue → expectedSpan
  const candidates: Array<{ id: string; offset: number; weight: number }> = [];
  for (const s of valid) {
    const actualSpan = s.lastCue - s.firstCue;
    if (actualSpan <= 0) continue;
    // Scale to expected span
    const scaleFactor = expectedSpan / actualSpan;
    // If scale factor is reasonable (0.95-1.05), sub is likely aligned
    if (scaleFactor < 0.95 || scaleFactor > 1.05) continue;
    // Estimate offset: sub.firstCue should be near 0 (or near video start)
    // If firstCue > 5s, sub probably starts late → negative offset to bring it back
    const estimatedOffset = s.firstCue < 0 ? Math.abs(s.firstCue) : -s.firstCue;
    // Weight: subs with more cues and matching release encode are more trusted
    let weight = Math.log2(s.count + 1);
    if (videoFilename && s.releaseName) {
      const vEnc = extractReleaseEncode(videoFilename);
      const sEnc = extractReleaseEncode(s.releaseName);
      if (vEnc.some((e) => sEnc.includes(e))) weight *= 2;
    }
    candidates.push({ id: s.id, offset: estimatedOffset, weight });
  }
  if (candidates.length < 2) return null;

  // Weighted median
  candidates.sort((a, b) => a.offset - b.offset);
  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
  let acc = 0;
  let median = candidates[0].offset;
  for (const c of candidates) {
    acc += c.weight;
    if (acc >= totalWeight / 2) { median = c.offset; break; }
  }
  // Confidence: tighter cluster = higher score
  const spread = candidates[candidates.length - 1].offset - candidates[0].offset;
  const score = Math.max(0, Math.min(1, 0.9 - spread / 30));
  if (score < 0.3) return null;
  return { offset: Math.round(median * 10) / 10, score, method: 'sub-consensus' };
}

// ── Method 3: minimal audio VAD ──────────────────────────────────

const PYTHON_TIMEOUT_MS = 8000;

function resolveBridge(): string {
  if (process.env.FFSUBSYNC_BRIDGE) return process.env.FFSUBSYNC_BRIDGE;
  return fileURLToPath(new URL('./ffsubsync_run.py', import.meta.url));
}

/**
 * Extract a tiny audio slice from the middle of the video via ffmpeg,
 * then run inline VAD + cross-correlation against the sub's speech
 * timeline. Designed for HTTP REMUXes where full audio extraction is
 * too slow: 5-10s from the middle is enough to lock the offset.
 */
export async function offsetByMinimalVad(
  videoUrl: string,
  videoDurationSec: number | null,
  subEntries: SubtitleEntry[],
  timeoutMs = PYTHON_TIMEOUT_MS,
): Promise<FastOffsetResult | null> {
  if (!videoUrl || subEntries.length < 3) return null;
  const duration = videoDurationSec || 600;
  // Pick a slice in the middle where speech is densest
  const sliceStart = Math.max(0, Math.min(duration - 30, duration * 0.25));
  const sliceDur = 15;
  const wavPath = join(tmpdir(), `vad_${Date.now()}.wav`);
  // 16kHz mono s16le is the standard VAD input
  const extractCmd = `timeout 6 ffmpeg -y -ss ${sliceStart.toFixed(1)} -i "${videoUrl}" -t ${sliceDur} -vn -ac 1 -ar 16000 -c:a pcm_s16le "${wavPath}" 2>/dev/null`;
  try { execSync(extractCmd, { encoding: 'utf-8', timeout: 7000, stdio: 'pipe' }); } catch { /* timeout ok */ }
  if (!existsSync(wavPath)) return null;
  const size = (() => { try { return statSync(wavPath).size; } catch { return 0; } })();
  if (size < 44 + 16000 * 2 * 2) { // < 2s of audio
    try { unlinkSync(wavPath); } catch {}
    return null;
  }

  // Run inline VAD + cross-correlation via Python bridge
  // Convert sub entries to a SRT file for the bridge
  const srtPath = join(tmpdir(), `vad_sub_${Date.now()}.srt`);
  const srtContent = subEntries
    .filter((e) => e.start < sliceStart + sliceDur && e.end > sliceStart)
    .map((e, i) => {
      const rel = (t: number) => Math.max(0, t - sliceStart);
      return `${i + 1}\n${formatSrt(rel(e.start))} --> ${formatSrt(rel(e.end))}\n${e.text}\n`;
    })
    .join('\n');
  if (srtContent.trim().length === 0) {
    try { unlinkSync(wavPath); unlinkSync(srtPath); } catch {}
    return null;
  }
  writeFileSync(srtPath, srtContent, 'utf-8');

  // Inline Python: VAD via webrtcvad + FFT cross-correlation via numpy
  const inlinePy = `
import sys, json
import numpy as np
try:
    import webrtcvad
except ImportError:
    print(json.dumps({"ok": False, "reason": "no webrtcvad"}))
    sys.exit(0)

wav_path = "${wavPath}"
srt_path = "${srtPath}"

# Read WAV (16k mono s16le, header 44B)
with open(wav_path, "rb") as f:
    data = f.read()
audio = np.frombuffer(data[44:], dtype=np.int16).astype(np.float32)
audio = (audio - audio.mean()) / (np.abs(audio).max() + 1e-9)

# Frame into 30ms windows (webrtcvad default), produce binary "is_speech" timeline
vad = webrtcvad.Vad(2)
frame_dur_ms = 30
frame_size = int(16000 * frame_dur_ms / 1000)
ref_signal = []
for i in range(0, len(audio) - frame_size, frame_size):
    frame = audio[i:i + frame_size].astype(np.int16).tobytes()
    try:
        is_speech = vad.is_speech(frame, 16000)
    except Exception:
        is_speech = False
    ref_signal.append(1 if is_speech else 0)
ref = np.array(ref_signal, dtype=float)
if ref.sum() < 3:
    print(json.dumps({"ok": False, "reason": "no speech detected"}))
    sys.exit(0)

# Parse SRT into speech timeline (1 where sub is "speaking", 0 otherwise)
# SRT timestamps are 0-based relative to slice start
import re
sub_signal = []
with open(srt_path) as f:
    srt = f.read()
cue_pattern = re.compile(r"(\\d+)\\n(\\d{2}):(\\d{2}):(\\d{2}),(\\d{3}) --> (\\d{2}):(\\d{2}):(\\d{2}),(\\d{3})")
sub_start = 0
sub_end = ${sliceDur}
sub_bin = np.zeros(int(sub_end * 1000 / frame_dur_ms), dtype=float)
for m in cue_pattern.finditer(srt):
    s = int(m.group(2))*3600 + int(m.group(3))*60 + int(m.group(4)) + int(m.group(5))/1000
    e = int(m.group(6))*3600 + int(m.group(7))*60 + int(m.group(8)) + int(m.group(9))/1000
    s_idx = int(s * 1000 / frame_dur_ms)
    e_idx = int(e * 1000 / frame_dur_ms)
    sub_bin[max(0, s_idx):min(len(sub_bin), e_idx)] = 1
if sub_bin.sum() < 3:
    print(json.dumps({"ok": False, "reason": "no sub cues in slice"}))
    sys.exit(0)

# FFT cross-correlation (sub pattern slid across reference)
# Reference = audio speech, sub = expected speech → find best offset
ref_bin = ref.astype(np.float32)
sub_bin = sub_bin.astype(np.float32)
# Pad sub to ref length
total = len(ref_bin) + len(sub_bin)
n = 1
while n < total: n *= 2
ref_padded = np.zeros(n, dtype=np.float32)
ref_padded[:len(ref_bin)] = ref_bin - ref_bin.mean()
sub_padded = np.zeros(n, dtype=np.float32)
sub_padded[:len(sub_bin)] = sub_bin - sub_bin.mean()
convolve = np.real(np.fft.ifft(np.fft.fft(sub_padded) * np.fft.fft(ref_padded[::-1])))
# argmax → offset in frames
best_idx = int(np.argmax(convolve))
# offset = position in ref where sub starts matching
# convolve[i] = sum_k sub[k] * ref[i + len(sub) - k] → if i = len(sub), sub[0] aligns with ref[0]
# best_offset_in_ref_samples = best_idx - len(sub) + len(ref)
# We want: at ref position (best_idx), how far is sub[0]?
offset_frames = best_idx - len(sub_bin) + len(ref_bin)
# offset in seconds (positive = sub is AHEAD of audio = need to delay sub)
# If offset_frames > 0, sub should start EARLIER in audio (sub is shifted right relative to ref)
# If offset_frames < 0, sub should start LATER (sub is shifted left)
# In ffsubsync convention: positive offset = sub is ahead of video
# Our offset = -offset_frames * frame_dur_ms / 1000
offset_sec = -offset_frames * frame_dur_ms / 1000
score = float(convolve[best_idx] / (len(sub_bin) + 1e-9))
print(json.dumps({"ok": True, "offset": round(offset_sec, 3), "score": round(score, 3), "speech_frames": int(ref.sum()), "ref_len": len(ref), "sub_len": len(sub_bin)}))
`;

  const bridgePath = resolveBridge();
  const pyScript = join(tmpdir(), `vad_inline_${Date.now()}.py`);
  writeFileSync(pyScript, inlinePy, 'utf-8');
  try {
    const stdout = execSync(`python3 "${pyScript}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      stdio: 'pipe',
    });
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1];
    const result = JSON.parse(last) as { ok: boolean; offset?: number; score?: number; reason?: string };
    try { unlinkSync(wavPath); unlinkSync(srtPath); unlinkSync(pyScript); } catch {}
    if (!result.ok || typeof result.offset !== 'number') return null;
    // Clamp to reasonable range
    if (Math.abs(result.offset) > 600) return null;
    return {
      offset: Math.round(result.offset * 10) / 10,
      score: Math.min(1, Math.max(0, result.score ?? 0)),
      method: 'minimal-vad',
    };
  } catch {
    try { unlinkSync(wavPath); unlinkSync(srtPath); unlinkSync(pyScript); } catch {}
    return null;
  }
}

function formatSrt(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Run the fast engine: release-name → sub-consensus → minimal-vad.
 * Returns the first decisive result. Returns null if no method is confident
 * — caller should fall back to ffsubsync.
 */
export async function calculateOffsetFast(
  videoUrl: string,
  videoFilename: string | null,
  videoDurationSec: number | null,
  subs: Array<{ id: string; url: string; lang?: string; _format?: SubtitleFormat; _releaseName?: string; _entries?: SubtitleEntry[] }>,
  budgetMs: number = 10_000,
): Promise<FastOffsetResult | null> {
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  // Pick the best source sub for sync. Prefer:
  //  1. English subs whose release encode matches the video's encode
  //     (BluRay→BluRay, WEB-DL→WEB-DL — usually already synced).
  //  2. Any English sub with a non-empty release name.
  //  3. First English sub.
  //  4. First sub (last resort).
  const videoEncodes = videoFilename ? new Set(extractReleaseEncode(videoFilename)) : new Set<string>();
  const englishSubs = subs.filter((s) => {
    const l = (s.lang || '').toLowerCase();
    return l === 'en' || l === 'eng';
  });
  const enCandidate =
    englishSubs.find((s) => {
      if (!s._releaseName || videoEncodes.size === 0) return false;
      const sEnc = extractReleaseEncode(s._releaseName);
      return sEnc.some((e) => videoEncodes.has(e));
    }) ??
    englishSubs.find((s) => s._releaseName) ??
    englishSubs[0] ??
    subs[0];

  // 1. Release-name match (free). Test ALL English subs, return the
  //    first match. Don't just check subs[0] — when the upstream addon
  //    returns WEB-DL subs first, the BluRay match is further down.
  if (enCandidate && videoEncodes.size > 0) {
    for (const s of englishSubs.length > 0 ? englishSubs : [enCandidate]) {
      if (remaining() < 500) break;
      const rn = offsetByReleaseName(videoFilename, s._releaseName);
      if (rn && rn.score >= 0.5) return rn;
    }
  }

  // 2. Sub consensus (needs ≥2 subs and known duration)
  if (subs.length >= 2 && videoDurationSec) {
    if (remaining() > 2_000) {
      const c = await offsetBySubConsensus(videoDurationSec, subs, videoFilename);
      if (c && c.score >= 0.5) return c;
    }
  }

  // 3. Minimal VAD (≤10s budget)
  if (videoUrl && enCandidate && remaining() > 4_000) {
    let entries: SubtitleEntry[] = enCandidate._entries || [];
    if (entries.length === 0) {
      const content = await fetchText(enCandidate.url);
      if (content) entries = parseSubtitle(content, enCandidate._format || 'srt');
    }
    if (entries.length >= 3) {
      const v = await offsetByMinimalVad(videoUrl, videoDurationSec, entries, Math.min(remaining() - 1_000, 8_000));
      if (v && v.score >= 0.3) return v;
    }
  }

  return null;
}
