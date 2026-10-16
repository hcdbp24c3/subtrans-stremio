import { describe, it, expect } from 'vitest';
import { translateInChunks } from '../src/lib/translate-chunker.js';
import { SubtitleEntry } from '../src/lib/subtitle-parser.js';

const ENTRIES: SubtitleEntry[] = Array.from({ length: 100 }, (_, i) => ({
  start: i,
  end: i + 1,
  text: `line ${i + 1}`,
}));

describe('translateInChunks', () => {
  it('returns empty for empty input', async () => {
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: [],
      callProvider: async () => new Map(),
      format: 'srt',
    });
    expect(r.totalChunks).toBe(0);
    expect(r.complete).toBe(true);
  });

  it('chunks by 30 and translates each', async () => {
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES,
      callProvider: async (batch) => {
        const m = new Map<number, string>();
        for (let i = 0; i < batch.length; i++) m.set(i + 1, `[vi] ${batch[i].text}`);
        return m;
      },
      format: 'srt',
      chunkSize: 30,
      concurrency: 3,
    });
    expect(r.totalChunks).toBe(4); // 100/30 = 3.33 → 4 chunks
    expect(r.successChunks).toBe(4);
    expect(r.failedChunks).toBe(0);
    expect(r.complete).toBe(true);
    expect(r.lines.size).toBe(100);
    expect(r.lines.get(1)).toBe('[vi] line 1');
    expect(r.lines.get(100)).toBe('[vi] line 100');
  });

  it('counts failed chunks', async () => {
    let callCount = 0;
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES,
      callProvider: async (batch) => {
        callCount++;
        if (callCount === 1) throw new Error('boom');
        const m = new Map<number, string>();
        for (let i = 0; i < batch.length; i++) m.set(i + 1, batch[i].text);
        return m;
      },
      format: 'srt',
      chunkSize: 30,
      concurrency: 2,
    });
    expect(r.totalChunks).toBe(4);
    expect(r.successChunks).toBe(3);
    expect(r.failedChunks).toBe(1);
    expect(r.complete).toBe(false); // 3/4 = 75% < 80% threshold
  });

  it('marks incomplete when too many chunks fail', async () => {
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES,
      callProvider: async () => { throw new Error('always fail'); },
      format: 'srt',
      chunkSize: 30,
    });
    expect(r.totalChunks).toBe(4);
    expect(r.successChunks).toBe(0);
    expect(r.failedChunks).toBe(4);
    expect(r.complete).toBe(false);
  });

  it('preserves global position across chunks', async () => {
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES.slice(0, 65), // 3 chunks: 30, 30, 5
      callProvider: async (batch) => {
        const m = new Map<number, string>();
        for (let i = 0; i < batch.length; i++) m.set(i + 1, batch[i].text);
        return m;
      },
      format: 'srt',
      chunkSize: 30,
    });
    expect(r.totalChunks).toBe(3);
    // Position 1 is in chunk 0, position 35 is in chunk 1, position 65 is in chunk 2
    expect(r.lines.get(1)).toBe('line 1');
    expect(r.lines.get(35)).toBe('line 35');
    expect(r.lines.get(65)).toBe('line 65');
    expect(r.lines.size).toBe(65);
  });

  it('skips already-cached positions and renumbers the batch', async () => {
    // Pre-cache positions 1-60 (chunks 0 and 1 fully translated).
    // Chunks 2-3 (positions 61-100) should be sent to the provider.
    const skip = new Set<number>();
    for (let i = 1; i <= 60; i++) skip.add(i);
    const seenBatchSizes: number[] = [];
    const r = await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES,
      callProvider: async (batch) => {
        seenBatchSizes.push(batch.length);
        const m = new Map<number, string>();
        for (let i = 0; i < batch.length; i++) m.set(i + 1, `[vi] ${batch[i].text}`);
        return m;
      },
      skipPositions: skip,
      format: 'srt',
      chunkSize: 30,
    });
    expect(seenBatchSizes).toEqual([30, 10]); // chunks 2 and 3 only
    expect(r.skippedLines).toBe(60);
    expect(r.totalChunks).toBe(4);
    // successChunks includes fully-cached chunks (no provider call) + new chunks
    expect(r.successChunks).toBe(4);
    expect(r.failedChunks).toBe(0);
    expect(r.lines.get(61)).toBe('[vi] line 61');
    expect(r.lines.get(100)).toBe('[vi] line 100');
  });

  it('invokes onLineTranslated hook for resume', async () => {
    const hooks: Array<[number, string]> = [];
    await translateInChunks({
      sourceLanguage: 'en',
      targetLanguage: 'vi',
      entries: ENTRIES.slice(0, 5),
      callProvider: async (batch) => {
        const m = new Map<number, string>();
        for (let i = 0; i < batch.length; i++) m.set(i + 1, `[vi] ${batch[i].text}`);
        return m;
      },
      onLineTranslated: (pos, text) => hooks.push([pos, text]),
      format: 'srt',
      chunkSize: 30,
    });
    expect(hooks.length).toBe(5);
    expect(hooks[0]).toEqual([1, '[vi] line 1']);
    expect(hooks[4]).toEqual([5, '[vi] line 5']);
  });
});
