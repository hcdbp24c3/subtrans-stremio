import { describe, it, expect } from 'vitest';
import { calculateOffset, adjustEntries, SubtitleEntry } from '../src/lib/aligner.js';

describe('aligner', () => {
  it('calculates positive offset when sub is shorter than video', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 5, text: 'b' },
    ];
    const offset = calculateOffset(entries, 10);
    expect(offset).toBe(5);
  });

  it('calculates negative offset when sub is longer than video', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 15, text: 'b' },
    ];
    const offset = calculateOffset(entries, 10);
    expect(offset).toBe(-5);
  });

  it('returns 0 when sub timing matches video', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 5, text: 'a' },
      { start: 5, end: 10, text: 'b' },
    ];
    const offset = calculateOffset(entries, 10);
    expect(offset).toBe(0);
  });

  it('returns 0 when entries are empty', () => {
    const offset = calculateOffset([], 100);
    expect(offset).toBe(0);
  });

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
