import { describe, it, expect } from 'vitest';
import {
  offsetByReleaseName, extractReleaseEncode, scoreReleaseMatch, findReferenceSub,
} from '../src/lib/align-fast.js';
import { extractReleaseNameFromUrl } from '../src/routes/subtitle.js';

describe('extractReleaseEncode', () => {
  it('extracts bluray from various spellings', () => {
    expect(extractReleaseEncode('In.The.Grey.2026.2160p.BluRay.REMUX.x265.mkv'))
      .toEqual(expect.arrayContaining(['bluray', 'remux']));
  });
  it('extracts web-dl', () => {
    expect(extractReleaseEncode('In.The.Grey.2026.AMZN.WEB-DL.DDP5.1.H.264'))
      .toEqual(expect.arrayContaining(['web-dl']));
  });
  it('returns empty for null', () => {
    expect(extractReleaseEncode(null)).toEqual([]);
    expect(extractReleaseEncode(undefined)).toEqual([]);
  });
  it('returns empty for filename without source tag', () => {
    expect(extractReleaseEncode('In.The.Grey.2026.mkv')).toEqual([]);
  });
});

describe('offsetByReleaseName', () => {
  const VIDEO_BD = 'In.The.Grey.2026.2160p.UHD.BluRay.REMUX.HDR.MULTi.mkv';
  const SUB_BD = 'In.The.Grey.2026.2160p.BluRay.x265-GRP';
  const SUB_WEB = 'In.The.Grey.2026.AMZN.WEB-DL.DDP5.1.H.264-NTb';

  it('returns offset=0 when encodes match (BluRay→BluRay)', () => {
    const r = offsetByReleaseName(VIDEO_BD, SUB_BD);
    expect(r).not.toBeNull();
    expect(r!.offset).toBe(0);
    expect(r!.method).toBe('release-name');
  });

  it('returns null when encodes mismatch (BluRay vs WEB-DL)', () => {
    expect(offsetByReleaseName(VIDEO_BD, SUB_WEB)).toBeNull();
  });

  it('returns null for missing input', () => {
    expect(offsetByReleaseName(null, SUB_BD)).toBeNull();
    expect(offsetByReleaseName(VIDEO_BD, null)).toBeNull();
    expect(offsetByReleaseName(VIDEO_BD, '')).toBeNull();
  });
});

describe('extractReleaseNameFromUrl', () => {
  it('strips .srt extension', () => {
    expect(extractReleaseNameFromUrl('https://cdn.example.com/movies/In.The.Grey.2026.BluRay.x265.srt'))
      .toBe('In.The.Grey.2026.BluRay.x265');
  });
  it('decodes percent-encoding', () => {
    expect(extractReleaseNameFromUrl('https://cdn.example.com/In%20The%20Grey%20BluRay.srt'))
      .toBe('In The Grey BluRay');
  });
  it('skips purely numeric IDs', () => {
    expect(extractReleaseNameFromUrl('https://cdn.example.com/subtitles/1962380715')).toBe('');
  });
  it('handles no extension', () => {
    expect(extractReleaseNameFromUrl('https://cdn.example.com/In.The.Grey.2026.BluRay'))
      .toBe('In.The.Grey.2026.BluRay');
  });
  it('returns empty for empty URL', () => {
    expect(extractReleaseNameFromUrl('')).toBe('');
  });
});

describe('scoreReleaseMatch', () => {
  const VIDEO = 'In.The.Grey.2026.2160p.UHD.BluRay.REMUX.HDR.MULTi[Ben The Men].mkv';

  it('matches bluray remux with same group', () => {
    const sub = 'In.The.Grey.2026.2160p.BluRay.REMUX.x265[Ben The Men].srt';
    const match = scoreReleaseMatch(VIDEO, sub);
    expect(match.matched).toBe(true);
    expect(match.score).toBeGreaterThanOrEqual(10);
  });

  it('matches bluray to remux across groups', () => {
    const sub = 'In.The.Grey.2026.1080p.BluRay.x264-SPARKS.srt';
    const match = scoreReleaseMatch(VIDEO, sub);
    expect(match.matched).toBe(true);
  });

  it('rejects web-dl when video is bluray remux', () => {
    const sub = 'In.The.Grey.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb.srt';
    const match = scoreReleaseMatch(VIDEO, sub);
    expect(match.matched).toBe(false);
  });
});

describe('findReferenceSub', () => {
  const VIDEO = 'In.The.Grey.2026.2160p.UHD.BluRay.REMUX.HDR.MULTi[Ben The Men].mkv';
  const subs = [
    { id: 'sub-web', url: 'https://example.com/web.srt', lang: 'en', _releaseName: 'In.The.Grey.2026.WEB-DL.srt' },
    { id: 'sub-bd-vi', url: 'https://example.com/bd-vi.srt', lang: 'vi', _releaseName: 'In.The.Grey.2026.BluRay.REMUX.srt' },
    { id: 'sub-bd-en', url: 'https://example.com/bd-en.srt', lang: 'en', _releaseName: 'In.The.Grey.2026.BluRay.REMUX.x265[Ben The Men].srt' },
  ];

  it('selects the release-matched English sub as benchmark', () => {
    const found = findReferenceSub(subs, VIDEO);
    expect(found).not.toBeNull();
    expect(found!.sub.id).toBe('sub-bd-en');
    expect(found!.isReleaseMatch).toBe(true);
  });
});
