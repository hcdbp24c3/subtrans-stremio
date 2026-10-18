import { describe, it, expect } from 'vitest';
import {
  calculateOffsetFromReference, calculateOffsetFromTiming, adjustEntries, parseFfsubsyncOutput,
  parseFfsubsyncBridgeJson, countSrtEntries, parseDurationFromProbeLine, SubtitleEntry,
} from '../src/lib/aligner.js';

describe('parseFfsubsyncOutput', () => {
  it('parses offset and score', () => {
    const out = 'ffsubsync: offset seconds: 2.5\nscore: 0.87';
    expect(parseFfsubsyncOutput(out)).toEqual({ offset: 2.5, score: 0.87 });
  });

  it('parses negative offset, default score 0 when missing', () => {
    expect(parseFfsubsyncOutput('offset seconds: -1.25')).toEqual({ offset: -1.25, score: 0 });
  });

  it('returns null when no offset line', () => {
    expect(parseFfsubsyncOutput('nothing here')).toBeNull();
  });
});

describe('parseFfsubsyncBridgeJson', () => {
  it('parses last-line JSON with ok=true', () => {
    const out = 'noise\n{"offset": 28.8, "score": 19976, "ok": true, "retval": 0}\n';
    expect(parseFfsubsyncBridgeJson(out)).toEqual({ offset: 28.8, score: 19976 });
  });

  it('returns null when ok=false', () => {
    expect(parseFfsubsyncBridgeJson('{"offset": 0, "score": 0, "ok": false}')).toBeNull();
  });

  it('returns offset 0 when ok=true (already synced — cacheable)', () => {
    expect(parseFfsubsyncBridgeJson('{"offset": 0, "score": 100, "ok": true}'))
      .toEqual({ offset: 0, score: 100 });
  });

  it('returns null when no JSON line', () => {
    expect(parseFfsubsyncBridgeJson('no json here')).toBeNull();
  });
});

describe('countSrtEntries', () => {
  it('counts numbered cue indices', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHi\n\n2\n00:00:03,000 --> 00:00:04,000\nYo';
    expect(countSrtEntries(srt)).toBe(2);
  });

  it('returns 0 for empty content', () => {
    expect(countSrtEntries('')).toBe(0);
  });
});

describe('parseDurationFromProbeLine', () => {
  it('parses bare float (csv=p=0 format duration line)', () => {
    expect(parseDurationFromProbeLine('5839.638000')).toBe(5839.638);
  });

  it('parses duration= form', () => {
    expect(parseDurationFromProbeLine('duration=120.5')).toBe(120.5);
    expect(parseDurationFromProbeLine('[FORMAT]\nduration=120.5\n[/FORMAT]'.split('\n')[1])).toBe(120.5);
  });

  it('returns null for stream CSV lines', () => {
    expect(parseDurationFromProbeLine('9,subrip,subtitle,eng,BTM SDH')).toBeNull();
    expect(parseDurationFromProbeLine('0,hevc,video,eng,BEN.THE.MEN')).toBeNull();
  });

  it('returns null for zero or empty', () => {
    expect(parseDurationFromProbeLine('0')).toBeNull();
    expect(parseDurationFromProbeLine('')).toBeNull();
  });
});

describe('aligner', () => {
  // ── calculateOffsetFromReference ──────────────────────────────────

  it('detects positive offset (target starts early)', () => {
    // Reference subs start at 10s, target starts at 5s → offset = +5s
    const reference: SubtitleEntry[] = [
      { start: 10, end: 12, text: 'Hello world' },
      { start: 20, end: 22, text: 'How are you' },
      { start: 30, end: 32, text: 'Good morning' },
      { start: 40, end: 42, text: 'Thank you' },
      { start: 50, end: 52, text: 'Goodbye' },
    ];
    const target: SubtitleEntry[] = [
      { start: 5, end: 7, text: 'Hello world' },
      { start: 15, end: 17, text: 'How are you' },
      { start: 25, end: 27, text: 'Good morning' },
      { start: 35, end: 37, text: 'Thank you' },
      { start: 45, end: 47, text: 'Goodbye' },
    ];
    const offset = calculateOffsetFromReference(reference, target);
    expect(offset).toBe(5);
  });

  it('detects negative offset (target starts late)', () => {
    // Reference subs start at 5s, target starts at 10s → offset = -5s
    const reference: SubtitleEntry[] = [
      { start: 5, end: 7, text: 'Hello world' },
      { start: 15, end: 17, text: 'How are you' },
      { start: 25, end: 27, text: 'Good morning' },
      { start: 35, end: 37, text: 'Thank you' },
      { start: 45, end: 47, text: 'Goodbye' },
    ];
    const target: SubtitleEntry[] = [
      { start: 10, end: 12, text: 'Hello world' },
      { start: 20, end: 22, text: 'How are you' },
      { start: 30, end: 32, text: 'Good morning' },
      { start: 40, end: 42, text: 'Thank you' },
      { start: 50, end: 52, text: 'Goodbye' },
    ];
    const offset = calculateOffsetFromReference(reference, target);
    expect(offset).toBe(-5);
  });

  it('returns 0 when entries are identical', () => {
    const entries: SubtitleEntry[] = [
      { start: 5, end: 7, text: 'Hello' },
      { start: 10, end: 12, text: 'World' },
      { start: 15, end: 17, text: 'Foo' },
      { start: 20, end: 22, text: 'Bar' },
      { start: 25, end: 27, text: 'Baz' },
    ];
    const offset = calculateOffsetFromReference(entries, [...entries]);
    expect(offset).toBe(0);
  });

  it('returns 0 when entries are empty', () => {
    expect(calculateOffsetFromReference([], [])).toBe(0);
  });

  it('returns 0 when no matching text found', () => {
    const reference: SubtitleEntry[] = [
      { start: 10, end: 12, text: 'Apple banana cherry' },
      { start: 20, end: 22, text: 'Dog cat fish bird' },
      { start: 30, end: 32, text: 'Red green blue yellow' },
      { start: 40, end: 42, text: 'One two three four five' },
      { start: 50, end: 52, text: 'Alpha beta gamma delta' },
    ];
    const target: SubtitleEntry[] = [
      { start: 10, end: 12, text: 'XXXX YYYY ZZZZ' },
      { start: 20, end: 22, text: 'AAAA BBBB CCCC' },
      { start: 30, end: 32, text: 'DDDD EEEE FFFF' },
    ];
    const offset = calculateOffsetFromReference(reference, target);
    expect(offset).toBe(0);
  });

  it('ignores offsets larger than 10 minutes', () => {
    const reference: SubtitleEntry[] = [
      { start: 10, end: 12, text: 'Hello' },
      { start: 20, end: 22, text: 'World' },
      { start: 30, end: 32, text: 'Foo' },
      { start: 40, end: 42, text: 'Bar' },
      { start: 50, end: 52, text: 'Baz' },
    ];
    // 20 minutes offset → should return 0
    const target: SubtitleEntry[] = [
      { start: -1190, end: -1188, text: 'Hello' },
      { start: -1180, end: -1178, text: 'World' },
      { start: -1170, end: -1168, text: 'Foo' },
      { start: -1160, end: -1158, text: 'Bar' },
      { start: -1150, end: -1148, text: 'Baz' },
    ];
    const offset = calculateOffsetFromReference(reference, target);
    expect(offset).toBe(0);
  });

  // ── adjustEntries ─────────────────────────────────────────────────

  it('adjusts entries with given offset', () => {
    const entries: SubtitleEntry[] = [
      { start: 5, end: 8, text: 'hello' },
      { start: 10, end: 13, text: 'world' },
    ];
    const adjusted = adjustEntries(entries, 2.5);
    expect(adjusted[0].start).toBe(7.5);
    expect(adjusted[0].end).toBe(10.5);
    expect(adjusted[1].start).toBe(12.5);
    expect(adjusted[1].end).toBe(15.5);
  });

  it('clamps negative timestamps to 0', () => {
    const entries: SubtitleEntry[] = [
      { start: 1, end: 3, text: 'early' },
    ];
    const adjusted = adjustEntries(entries, -5);
    expect(adjusted[0].start).toBe(0);
    expect(adjusted[0].end).toBe(0);
  });

  // ── calculateOffsetFromTiming ──────────────────────────────────────

  it('detects offset between subtitles of different languages based on speech pauses', () => {
    // English reference
    const ref: SubtitleEntry[] = [
      { start: 12.5, end: 14.5, text: 'Welcome to the show.' },
      { start: 18.0, end: 20.0, text: 'We have a great guest tonight.' },
      { start: 25.5, end: 27.5, text: 'Please give a warm welcome.' },
      { start: 35.0, end: 37.0, text: 'Thank you everyone!' },
      { start: 45.0, end: 47.0, text: 'Let us begin.' },
    ];
    // Vietnamese target with 2.5s early shift (start - 2.5s)
    const target: SubtitleEntry[] = [
      { start: 10.0, end: 12.0, text: 'Chào mừng các bạn đến với chương trình.' },
      { start: 15.5, end: 17.5, text: 'Tối nay chúng ta có một vị khách tuyệt vời.' },
      { start: 23.0, end: 25.0, text: 'Hãy cùng cho một tràng pháo tay.' },
      { start: 32.5, end: 34.5, text: 'Cảm ơn mọi người!' },
      { start: 42.5, end: 44.5, text: 'Hãy bắt đầu thôi.' },
    ];

    const result = calculateOffsetFromTiming(ref, target);
    expect(result.score).toBeGreaterThanOrEqual(0.8);
    expect(Math.round(result.offset * 10) / 10).toBe(2.5);
  });

  it('detects zero offset when speech cues already align', () => {
    const ref: SubtitleEntry[] = [
      { start: 10.0, end: 12.0, text: 'Hello' },
      { start: 20.0, end: 22.0, text: 'World' },
      { start: 30.0, end: 32.0, text: 'How are you' },
      { start: 40.0, end: 42.0, text: 'Fine' },
      { start: 50.0, end: 52.0, text: 'Bye' },
    ];
    const target: SubtitleEntry[] = [
      { start: 10.0, end: 12.0, text: 'Xin chào' },
      { start: 20.0, end: 22.0, text: 'Thế giới' },
      { start: 30.0, end: 32.0, text: 'Bạn khỏe không' },
      { start: 40.0, end: 42.0, text: 'Khỏe' },
      { start: 50.0, end: 52.0, text: 'Tạm biệt' },
    ];

    const result = calculateOffsetFromTiming(ref, target);
    expect(result.offset).toBe(0);
    expect(result.score).toBe(1.0);
  });
});
