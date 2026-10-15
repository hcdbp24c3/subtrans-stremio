import { describe, it, expect } from 'vitest';
import { offsetByReleaseName, extractReleaseEncode } from '../src/lib/align-fast.js';

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
