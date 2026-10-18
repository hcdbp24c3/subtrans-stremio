/**
 * Fast sub-alignment & release matching engine.
 *
 * Replaces ffsubsync with smart release matching & sub-to-sub timing comparison:
 *  1. Release-name / Codec match (instant, <1ms):
 *     If the sub's release tags match the video (BluRay→BluRay, WEB-DL→WEB-DL,
 *     same group/codec), offset is 0.0s ("hoàn chỉnh ko phải sync").
 *  2. Sub consensus (<1s):
 *     When multiple subs are available, find consensus on cue distribution
 *     across the video timeline.
 *  3. Reference Sub selection:
 *     Identifies the benchmark reference sub (matching codec/release) to
 *     serve as the comparison standard for target language subs or as the
 *     source for translation.
 */

import { SubtitleEntry, parseSubtitle, SubtitleFormat } from './subtitle-parser.js';
import { fetchText } from './proxy.js';

export interface FastOffsetResult {
  /** Offset in seconds. Positive = target sub starts early, needs forward shift. */
  offset: number;
  /** Confidence 0-1. ≥0.5 is cacheable. */
  score: number;
  method: 'release-name' | 'sub-consensus' | 'timing-match';
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

export interface ReleaseMatchResult {
  matched: boolean;
  score: number;
  reason: string;
}

/**
 * Score how well a subtitle release name matches the video filename.
 * Checks source (BluRay/Remux/WEB-DL), release group, codec, and resolution.
 */
export function scoreReleaseMatch(
  videoFilename: string | null | undefined,
  subReleaseName: string | null | undefined,
): ReleaseMatchResult {
  if (!videoFilename || !subReleaseName) {
    return { matched: false, score: 0, reason: 'missing-input' };
  }

  const vNorm = videoFilename.toLowerCase().replace(/[._\-[\]()]/g, ' ');
  const sNorm = subReleaseName.toLowerCase().replace(/[._\-[\]()]/g, ' ');

  const vTokens = new Set(vNorm.split(/\s+/).filter(Boolean));
  const sTokens = new Set(sNorm.split(/\s+/).filter(Boolean));

  let score = 0;
  const reasons: string[] = [];

  // 1. Source / Encode
  const vEnc = extractReleaseEncode(videoFilename);
  const sEnc = extractReleaseEncode(subReleaseName);

  if (vEnc.length > 0 && sEnc.length > 0) {
    // Both bluray or both remux (or bluray+remux cross-match)
    const isVBluray = vEnc.includes('bluray') || vEnc.includes('remux');
    const isSBluray = sEnc.includes('bluray') || sEnc.includes('remux');
    const isVWeb = vEnc.includes('web-dl') || vEnc.includes('webrip');
    const isSWeb = sEnc.includes('web-dl') || sEnc.includes('webrip');

    if (isVBluray && isSBluray) {
      score += 7;
      reasons.push('source:bluray/remux');
    } else if (isVWeb && isSWeb) {
      score += 7;
      reasons.push('source:web');
    } else if (vEnc.some((e) => sEnc.includes(e))) {
      score += 6;
      reasons.push(`source:${vEnc.find((e) => sEnc.includes(e))}`);
    } else {
      // Direct source mismatch (e.g. BluRay video vs WEB-DL sub)
      score -= 6;
      reasons.push('source-mismatch');
    }
  }

  // 2. Release group match (e.g. [Ben The Men], -FLUX, -SPARKS, -YIFY)
  const groupMatch = videoFilename.match(/\[([^\]]+)\]|-([a-zA-Z0-9_]+)$/);
  if (groupMatch) {
    const grp = (groupMatch[1] || groupMatch[2] || '').toLowerCase().trim();
    if (grp.length >= 3 && sNorm.includes(grp)) {
      score += 7;
      reasons.push(`group:${grp}`);
    }
  }

  // 3. Codec match (x265/hevc vs x264/avc)
  const isV265 = vTokens.has('x265') || vTokens.has('hevc') || vTokens.has('h265');
  const isS265 = sTokens.has('x265') || sTokens.has('hevc') || sTokens.has('h265');
  const isV264 = vTokens.has('x264') || vTokens.has('avc') || vTokens.has('h264');
  const isS264 = sTokens.has('x264') || sTokens.has('avc') || sTokens.has('h264');
  if ((isV265 && isS265) || (isV264 && isS264)) {
    score += 2;
    reasons.push('codec');
  }

  // 4. Resolution match (2160p, 1080p, 720p)
  const resTokens = ['2160p', '4k', 'uhd', '1080p', '720p', '480p'];
  for (const r of resTokens) {
    if (vTokens.has(r) && sTokens.has(r)) {
      score += 2;
      reasons.push(`res:${r}`);
      break;
    }
  }

  const matched = score >= 5;
  return { matched, score, reason: reasons.join('+') || 'none' };
}

/**
 * Method 1: release-name match.
 * If the sub's encode/tags match the video, offset is 0.0s.
 */
export function offsetByReleaseName(
  videoFilename: string | null | undefined,
  subReleaseName: string | null | undefined,
): FastOffsetResult | null {
  const m = scoreReleaseMatch(videoFilename, subReleaseName);
  if (m.matched) {
    return { offset: 0, score: 0.9, method: 'release-name' };
  }
  return null;
}

interface SubWithCues {
  id: string;
  releaseName: string;
  entries: SubtitleEntry[];
  firstCue: number;
  lastCue: number;
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
    if (entries.length < 3) return null;
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
 * When multiple subs are present, compute expected cue span against video duration.
 */
export async function offsetBySubConsensus(
  videoDurationSec: number | null,
  subs: Array<{ id: string; url: string; lang?: string; _format?: SubtitleFormat; _releaseName?: string }>,
  videoFilename: string | null,
): Promise<FastOffsetResult | null> {
  if (subs.length < 2 || !videoDurationSec) return null;
  const built = await Promise.all(subs.map(buildSubWithCues));
  const valid = built.filter((s): s is SubWithCues => s !== null);
  if (valid.length < 2) return null;

  const expectedSpan = videoDurationSec * 0.8;
  const candidates: Array<{ id: string; offset: number; weight: number }> = [];

  for (const s of valid) {
    const actualSpan = s.lastCue - s.firstCue;
    if (actualSpan <= 0) continue;
    const scaleFactor = expectedSpan / actualSpan;
    if (scaleFactor < 0.95 || scaleFactor > 1.05) continue;
    const estimatedOffset = s.firstCue < 0 ? Math.abs(s.firstCue) : -s.firstCue;

    let weight = Math.log2(s.count + 1);
    if (videoFilename && s.releaseName) {
      const m = scoreReleaseMatch(videoFilename, s.releaseName);
      if (m.matched) weight *= 2;
    }
    candidates.push({ id: s.id, offset: estimatedOffset, weight });
  }
  if (candidates.length < 2) return null;

  candidates.sort((a, b) => a.offset - b.offset);
  const totalWeight = candidates.reduce((s, c) => s + c.weight, 0);
  let acc = 0;
  let median = candidates[0].offset;
  for (const c of candidates) {
    acc += c.weight;
    if (acc >= totalWeight / 2) { median = c.offset; break; }
  }

  const spread = candidates[candidates.length - 1].offset - candidates[0].offset;
  const score = Math.max(0, Math.min(1, 0.9 - spread / 30));
  if (score < 0.3) return null;
  return { offset: Math.round(median * 10) / 10, score, method: 'sub-consensus' };
}

/**
 * Identify the Benchmark Reference Sub ("Sub Chuẩn").
 * Prioritizes:
 *  1. English subtitles that match the video's release tags (offset = 0)
 *  2. Any subtitle matching the video's release tags (offset = 0)
 *  3. First English sub in list
 *  4. First available sub
 */
export function findReferenceSub<T extends { id: string; url: string; lang?: string; _releaseName?: string }>(
  subs: T[],
  videoFilename: string | null | undefined,
): { sub: T; matchScore: number; isReleaseMatch: boolean } | null {
  if (subs.length === 0) return null;

  const scored = subs.map((s) => {
    const m = scoreReleaseMatch(videoFilename, s._releaseName);
    const l = (s.lang || '').toLowerCase();
    const isEn = l === 'en' || l === 'eng';
    // English is the preferred reference standard
    const score = m.score + (isEn ? 5 : 0) + (m.matched ? 10 : 0);
    return { sub: s, matchScore: score, isReleaseMatch: m.matched };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  const best = scored[0];
  if (!best) return null;
  return {
    sub: best.sub,
    matchScore: best.matchScore,
    isReleaseMatch: best.isReleaseMatch,
  };
}

/**
 * Fast alignment runner:
 * Tests release name match on candidate subs, falls back to consensus.
 */
export async function calculateOffsetFast(
  videoUrl: string,
  videoFilename: string | null,
  videoDurationSec: number | null,
  subs: Array<{ id: string; url: string; lang?: string; _format?: SubtitleFormat; _releaseName?: string; _entries?: SubtitleEntry[] }>,
  budgetMs = 5_000,
): Promise<FastOffsetResult | null> {
  const startedAt = Date.now();
  const remaining = () => budgetMs - (Date.now() - startedAt);

  // 1. Release-name match against all subs
  if (videoFilename) {
    for (const s of subs) {
      if (remaining() < 200) break;
      const rn = offsetByReleaseName(videoFilename, s._releaseName);
      if (rn && rn.score >= 0.5) return rn;
    }
  }

  // 2. Sub consensus (if duration known and multiple subs present)
  if (subs.length >= 2 && videoDurationSec && remaining() > 1_500) {
    const c = await offsetBySubConsensus(videoDurationSec, subs, videoFilename);
    if (c && c.score >= 0.5) return c;
  }

  return null;
}
