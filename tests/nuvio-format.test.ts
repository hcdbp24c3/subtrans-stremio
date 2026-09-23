import { describe, it, expect } from 'vitest';
import { detectFormat, sniffFormat, parseSubtitle } from '../src/lib/subtitle-parser.js';
import { detectFileExt } from '../src/routes/subtitle-ext.js';

describe('Nuvio format safety (Android ICU regex)', () => {
  // Nuvio Android crashes on ASS parser: PatternSyntaxException near index 8 \{[^}]*}
  // We must never advertise .ass/.ssa and always convert ASS→SRT.

  it('detectFileExt never returns .ass/.ssa (Nuvio ICU crash)', () => {
    expect(detectFileExt('https://x/file.ssa')).toBe('.srt');
    expect(detectFileExt('https://x/file.ass')).toBe('.srt');
    expect(detectFileExt('https://x/file.srt')).toBe('.srt');
    expect(detectFileExt('https://x/file.vtt')).toBe('.vtt');
    expect(detectFileExt('https://x/file/1962380715')).toBe('.srt');
  });

  it('sniffFormat detects ASS content even without extension', () => {
    const ass = `[Script Info]\nTitle: t\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Hello{\\i0}`;
    expect(sniffFormat(ass, null)).toBe('ass');
    expect(sniffFormat(ass, 'srt')).toBe('ass'); // content wins over wrong ext
    expect(sniffFormat('1\n00:00:01,000 --> 00:00:04,000\nHi', 'srt')).toBe('srt');
    expect(sniffFormat('WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHi', 'vtt')).toBe('vtt');
  });

  it('ASS with override tags converts to SRT with no braces left', () => {
    const ass = `[Script Info]\nTitle: t\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\i1}Biên dịch: X{\\i0}`;
    const entries = parseSubtitle(ass, 'ass');
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('Biên dịch: X');
    expect(entries[0].text).not.toMatch(/[{}]/);
  });
});
