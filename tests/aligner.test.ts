import { describe, it, expect } from 'vitest';
import { calculateOffsetFromReference, adjustEntries, SubtitleEntry } from '../src/lib/aligner.js';

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
});
