import { describe, it, expect } from 'vitest';
import { dedupeSubtitles } from '../src/routes/subtitle.js';

describe('dedupeSubtitles', () => {
  it('keeps first occurrence per URL and preserves order', () => {
    const subs = [
      { id: 'a', url: 'http://x/1.srt', lang: 'en' },
      { id: 'b', url: 'http://x/2.srt', lang: 'en' },
      { id: 'c', url: 'http://x/1.srt', lang: 'vi' }, // duplicate URL
      { id: 'd', url: 'http://x/1.srt', lang: 'en' }, // duplicate URL
    ];
    const out = dedupeSubtitles(subs);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns same reference when no duplicates', () => {
    const subs = [
      { id: 'a', url: 'http://x/1.srt' },
      { id: 'b', url: 'http://x/2.srt' },
    ];
    expect(dedupeSubtitles(subs).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('handles empty array', () => {
    expect(dedupeSubtitles([])).toEqual([]);
  });
});
