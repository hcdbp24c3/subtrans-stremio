import { describe, it, expect } from 'vitest';
import { offsetByReleaseName, extractReleaseEncode } from '../src/lib/align-fast.js';
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
