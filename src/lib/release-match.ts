// Pure release-name / encode matching. No logging — callers log once.

export function normalizeReleaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|srt|ass|vtt|ts)$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEncodeKeywords(releaseName: string): Set<string> {
  const norm = normalizeReleaseName(releaseName);
  const tokens = norm.split(' ');
  const encodeMap: Record<string, string> = {
    bluray: 'bluray', bdrip: 'bluray', brrip: 'bluray',
    remux: 'remux',
    'web-dl': 'web-dl', webdl: 'web-dl', webrip: 'webrip', web: 'web-dl',
    hdtv: 'hdtv',
    dvdrip: 'dvdrip',
    hdrip: 'hdrip',
  };
  const result = new Set<string>();
  for (const t of tokens) {
    const mapped = encodeMap[t];
    if (mapped) result.add(mapped);
  }
  return result;
}

export function encodeCompatible(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return true;
  for (const kw of a) {
    if (b.has(kw)) return true;
  }
  return false;
}

function encodeMatchScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.5;
  for (const kw of a) {
    if (b.has(kw)) return 1;
  }
  return 0;
}

const NOISE_TOKENS = new Set([
  '1080p', '2160p', '720p', '480p', '4k', 'uhd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1',
  'aac', 'ac3', 'ddp', 'ddp5', 'ddp51', 'eac3', 'truehd', 'atmos', 'dd51',
  'hdr', 'hdr10', 'dolby', 'vision', 'dv', 'sdr',
  '10bit', 'hdrp',
  'bluray', 'bdrip', 'brrip', 'remux', 'web', 'web-dl', 'webdl', 'webrip',
  'hdtv', 'dvdrip', 'hdrip',
]);

const MISMATCH_RANK_CAP = 0.4; // cap mismatch ranks; high-overlap mismatch may still beat zero-overlap compatible (intended)

export function releaseNameMatchScore(videoFilename: string, subReleaseName: string): number {
  if (!videoFilename || !subReleaseName) return 0;

  const videoNorm = normalizeReleaseName(videoFilename);
  const subNorm = normalizeReleaseName(subReleaseName);
  if (!videoNorm || !subNorm) return 0;
  if (videoNorm === subNorm) return 1;

  const videoEncode = extractEncodeKeywords(videoFilename);
  const subEncode = extractEncodeKeywords(subReleaseName);
  const compatible = encodeCompatible(videoEncode, subEncode);

  const videoTokens = new Set(videoNorm.split(' ').filter((t) => t.length > 1));
  const subTokens = subNorm.split(' ').filter((t) => t.length > 1);
  const videoMeaningful = [...videoTokens].filter((t) => !NOISE_TOKENS.has(t));
  const subMeaningful = subTokens.filter((t) => !NOISE_TOKENS.has(t));
  if (videoMeaningful.length === 0 || subMeaningful.length === 0) {
    return compatible ? 0.5 : 0; // unknown tokens: compatible stays neutral, mismatch stays 0
  }

  const subSet = new Set(subMeaningful);
  let matchCount = 0;
  for (const vt of videoMeaningful) {
    if (subSet.has(vt)) matchCount++;
  }
  const tokenScore = matchCount / subMeaningful.length;

  if (!compatible) {
    // Soft rank: still order mismatched subs by overlap, but cap below any compatible score.
    return Math.min(MISMATCH_RANK_CAP, tokenScore * 0.4);
  }

  const encodeBoost = encodeMatchScore(videoEncode, subEncode) * 0.1;
  return Math.min(1, tokenScore + encodeBoost);
}

export function sortByReleaseMatch<T extends { _releaseName?: string }>(
  subs: T[],
  videoFilename: string | null,
): T[] {
  if (!videoFilename) return subs;
  return subs
    .map((sub, index) => ({
      sub,
      index,
      score: releaseNameMatchScore(videoFilename, sub._releaseName || ''),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.sub);
}
