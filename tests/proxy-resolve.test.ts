import { describe, it, expect } from 'vitest';
import { resolveRealUrl } from '../src/lib/proxy-resolve.js';

describe('resolveRealUrl', () => {
  it('passes through a normal URL unchanged', () => {
    const u = 'https://example.com/sub.srt';
    expect(resolveRealUrl(u)).toBe(u);
  });

  it('unwraps SubSense 127.0.0.1?from= wrapper', () => {
    const wrapped = 'http://127.0.0.1:11470/subtitles.srt?from=https%3A%2F%2Freal.example.com%2Ffile.srt';
    expect(resolveRealUrl(wrapped)).toBe('https://real.example.com/file.srt');
  });

  it('decodes percent-encoded path (e.g. %2F for /)', () => {
    const encoded = 'ensubtitles.org%2Fen%2Fdownload%2Fsrc-api%2Fvrf-198b0c4a%2Ffile%2F1962340017.srt';
    const decoded = resolveRealUrl(encoded);
    // Upstream omitted the scheme; we add https:// so the URL is fetchable
    expect(decoded).toBe('https://ensubtitles.org/en/download/src-api/vrf-198b0c4a/file/1962340017.srt');
    // Round-tripping should not re-decode
    expect(resolveRealUrl(decoded)).toBe(decoded);
  });

  it('decodes multiple layers of percent-encoding', () => {
    const encoded = 'ensubtitles.org%252Fen%252Fdownload%252Ffile.srt';
    const decoded = resolveRealUrl(encoded);
    expect(decoded).toBe('https://ensubtitles.org/en/download/file.srt');
  });

  it('handles fully-qualified URL with encoded path', () => {
    const encoded = 'https://ensubtitles.org%2Fen%2Fdownload%2Ffile.srt';
    const decoded = resolveRealUrl(encoded);
    expect(decoded).toBe('https://ensubtitles.org/en/download/file.srt');
  });

  it('returns empty string unchanged', () => {
    expect(resolveRealUrl('')).toBe('');
  });

  it('does not decode URLs without %2F/%3A', () => {
    const u = 'https://example.com/path-with-encoded%20space.srt';
    // Single %20 is normal — should pass through
    expect(resolveRealUrl(u)).toBe(u);
  });
});
