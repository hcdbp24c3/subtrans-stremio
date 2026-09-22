import { describe, it, expect } from 'vitest';
import {
  normalizeReleaseName,
  extractEncodeKeywords,
  encodeCompatible,
  releaseNameMatchScore,
  sortByReleaseMatch,
} from '../src/lib/release-match.js';

const VIDEO = 'In.The.Grey.2026.2160p.UHD.BluRay.REMUX.HDR.MULTi[Ben The Men].mkv';
const SUB_WEB = 'In.The.Grey.2026.AMZN.WEB-DL.DDP5.1.H.264-NTb';
const SUB_BLURAY = 'In.The.Grey.2026.2160p.BluRay.x265-GRP';

describe('release-match', () => {
  it('normalizes dots and strips extension', () => {
    expect(normalizeReleaseName('In.the.Grey.2026.mkv')).toBe('in the grey 2026');
  });

  it('extracts bluray+remux from remux filename, web-dl from webdl', () => {
    expect(extractEncodeKeywords(VIDEO)).toEqual(new Set(['bluray', 'remux']));
    expect(extractEncodeKeywords(SUB_WEB)).toEqual(new Set(['web-dl']));
  });

  it('encodeCompatible: empty set is compatible; bluray-remux vs web-dl is not', () => {
    expect(encodeCompatible(new Set(), new Set(['web-dl']))).toBe(true);
    expect(encodeCompatible(new Set(['bluray', 'remux']), new Set(['web-dl']))).toBe(false);
    expect(encodeCompatible(new Set(['bluray']), new Set(['bluray']))).toBe(true);
  });

  it('compatible sub scores above incompatible sub (soft rank still prefers match)', () => {
    const scoreMatch = releaseNameMatchScore(VIDEO, SUB_BLURAY);
    const scoreMismatch = releaseNameMatchScore(VIDEO, SUB_WEB);
    expect(scoreMatch).toBeGreaterThan(scoreMismatch);
    expect(scoreMismatch).toBeGreaterThan(0); // soft: no longer hard-zero
    expect(scoreMismatch).toBeLessThanOrEqual(0.4); // capped mismatch rank
  });

  it('among two mismatched subs, higher token overlap ranks first', () => {
    const better = 'In.The.Grey.2026.1080p.WEB-DL.H.264-GRP';
    const worse = 'Totally.Unrelated.Movie.2020.WEB-DL';
    expect(releaseNameMatchScore(VIDEO, better)).toBeGreaterThan(
      releaseNameMatchScore(VIDEO, worse)
    );
  });

  it('sortByReleaseMatch returns a new array sorted best-first and scores each sub once', () => {
    const subs = [
      { id: '1', _releaseName: SUB_WEB },
      { id: '2', _releaseName: SUB_BLURAY },
      { id: '3', _releaseName: 'no-encode-tags-something-grey-2026' },
    ];
    const sorted = sortByReleaseMatch(subs, VIDEO);
    expect(sorted.map((s) => s.id)).toEqual(['2', '1', '3']);
    expect(sorted).not.toBe(subs); // original order untouched
  });

  it('sortByReleaseMatch with null videoFilename returns input as-is', () => {
    const subs = [{ id: '1', _releaseName: 'x' }];
    expect(sortByReleaseMatch(subs, null)).toBe(subs);
  });
});
