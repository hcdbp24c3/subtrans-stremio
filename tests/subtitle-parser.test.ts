import { describe, it, expect } from 'vitest';
import { parseSubtitle, detectFormat, SubtitleEntry } from '../src/lib/subtitle-parser.js';

const srtContent = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
Second subtitle`;

const vttContent = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.500 --> 00:00:08.000
Second subtitle`;

const assContent = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world
Dialogue: 0,0:00:05.50,0:00:08.00,Default,,0,0,0,,Second subtitle`;

describe('subtitle-parser', () => {
  it('parses SRT format', () => {
    const entries = parseSubtitle(srtContent, 'srt');
    expect(entries).toHaveLength(2);
    expect(entries[0].start).toBe(1.0);
    expect(entries[0].end).toBe(4.0);
    expect(entries[0].text).toBe('Hello world');
    expect(entries[1].start).toBe(5.5);
  });

  it('parses VTT format', () => {
    const entries = parseSubtitle(vttContent, 'vtt');
    expect(entries).toHaveLength(2);
    expect(entries[0].start).toBe(1.0);
    expect(entries[0].end).toBe(4.0);
  });

  it('parses ASS format', () => {
    const entries = parseSubtitle(assContent, 'ass');
    expect(entries).toHaveLength(2);
    expect(entries[0].start).toBe(1.0);
    expect(entries[0].end).toBe(4.0);
    expect(entries[0].text).toBe('Hello world');
  });

  it('returns empty array for invalid content', () => {
    const entries = parseSubtitle('not a subtitle', 'srt');
    expect(entries).toHaveLength(0);
  });

  it('detects format from extension', () => {
    expect(detectFormat('movie.srt')).toBe('srt');
    expect(detectFormat('movie.vtt')).toBe('vtt');
    expect(detectFormat('movie.ass')).toBe('ass');
    expect(detectFormat('movie.ssa')).toBe('ass');
    expect(detectFormat('movie.txt')).toBeNull();
  });
});
