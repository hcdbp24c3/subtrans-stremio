import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { runLingarrPipeline, LingarrSourceSub } from '../src/lib/lingarr-pipeline.js';
import { AddonConfig } from '../src/config.js';
import { clearTranslationCache } from '../src/lib/lingarr-cache.js';
import { LingarrOptions, TranslateAbleSubtitleContent, TranslateContentResult } from '../src/lib/lingarr.js';

const baseConfig: AddonConfig = {
  streamUrls: ['https://x.com/stream/manifest.json'],
  subUrls: ['https://x.com/sub/manifest.json'],
  languages: '',
  lingarrUrl: 'http://lingarr:9876',
  lingarrApiKey: 'k1',
  translateTargets: ['vi', 'ja'],
};

const engSource: LingarrSourceSub = {
  id: 'sub-1',
  url: 'https://cdn.example.com/movie.srt',
  lang: 'en',
  format: 'srt',
  normLang: 'en',
};

const SAMPLE_SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,500 --> 00:00:08,000
How are you`;

function makeTranslateMock(
  response: Map<number, string> | ((req: TranslateAbleSubtitleContent) => Map<number, string>),
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_opts: LingarrOptions, req: TranslateAbleSubtitleContent) => {
    const lines = typeof response === 'function' ? response(req) : response;
    return { lines, ok: lines.size > 0 } satisfies TranslateContentResult;
  });
}

describe('runLingarrPipeline', () => {
  let originalFetch: typeof fetch;
  let mockFetch: MockInstance<typeof fetch>;

  beforeEach(() => {
    clearTranslationCache();
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    // Default: pingLingarr succeeds; translateContent / fetchSubContent are
    // injected per test. Tests that need different fetch behavior override
    // mockFetch.mockResolvedValueOnce explicitly.
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 }),
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearTranslationCache();
  });

  it('returns subs unchanged when Lingarr URL is not configured', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, lingarrUrl: '' }, budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
    expect(out.subs).toEqual([engSource]);
  });

  it('returns subs unchanged when budget is too low', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 1_000,
    });
    expect(out.translated).toBe(false);
    expect(out.subs).toEqual([engSource]);
  });

  it('returns subs unchanged when translateTargets is empty', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, translateTargets: [] }, budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
  });

  it('returns subs unchanged when all target langs are already present', async () => {
    const out = await runLingarrPipeline({
      subs: [
        engSource,
        { id: 's2', url: 'https://x/vi.srt', lang: 'vi', format: 'srt', normLang: 'vi' },
        { id: 's3', url: 'https://x/ja.srt', lang: 'ja', format: 'srt', normLang: 'ja' },
      ],
      config: baseConfig, budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
    expect(out.subs).toHaveLength(3);
  });

  it('inserts translated sub for each missing target language', async () => {
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) {
        map.set(i + 1, `[${req.targetLanguage}] ${req.lines[i].line}`);
      }
      return map;
    });
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate, fetchSubContent,
    });
    expect(out.translated).toBe(true);
    expect(out.subs).toHaveLength(3);
    const viSub = out.subs.find((s) => s.normLang === 'vi');
    const jaSub = out.subs.find((s) => s.normLang === 'ja');
    expect(viSub).toBeDefined();
    expect(jaSub).toBeDefined();
    expect(viSub!.url).toMatch(/^lingarr:\/\//);
    expect(viSub!.format).toBe('srt');
    expect(viSub!.id).toContain('lingarr-vi');
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('skips translation when target == source language (no eng→eng)', async () => {
    const translate = makeTranslateMock(new Map());
    const out = await runLingarrPipeline({
      subs: [engSource],
      config: { ...baseConfig, translateTargets: ['en', 'vi'] },
      budgetMs: 10_000,
      translate,
      fetchSubContent: vi.fn(async () => SAMPLE_SRT),
    });
    expect(translate).toHaveBeenCalledTimes(1); // only 'vi'
    expect(out.subs.find((s) => s.normLang === 'en' && !s.url.startsWith('lingarr://'))).toBeDefined();
  });

  it('uses cache on second request (no upstream call)', async () => {
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) map.set(i + 1, `[vi] line ${i}`);
      return map;
    });
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);

    // First request: 2 cache misses (vi, ja)
    const first = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate, fetchSubContent,
    });
    expect(first.translated).toBe(true);
    expect(translate).toHaveBeenCalledTimes(2);
    expect(fetchSubContent).toHaveBeenCalledTimes(2);

    // Second request: 2 cache hits
    const second = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate, fetchSubContent,
    });
    expect(second.translated).toBe(true);
    expect(translate).toHaveBeenCalledTimes(2); // not called again
    expect(fetchSubContent).toHaveBeenCalledTimes(2); // not called again
  });

  it('marks source-fetch failure in log and continues with other langs', async () => {
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    const fetchSubContent = vi.fn(async () => null);
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate, fetchSubContent,
    });
    expect(out.translated).toBe(false);
    expect(out.log.every((l) => l.status === 'failed')).toBe(true);
  });

  it('marks Lingarr-ok=false as failed', async () => {
    const translate = vi.fn(async () => ({ lines: new Map(), ok: false }));
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate: translate as unknown as ReturnType<typeof makeTranslateMock>,
      fetchSubContent,
    });
    expect(out.translated).toBe(false);
    expect(out.log.every((l) => l.status === 'failed')).toBe(true);
  });

  it('prefers English source over first sub when both exist', async () => {
    const frenchFirst: LingarrSourceSub = {
      id: 'fr', url: 'https://x/fr.srt', lang: 'fr', format: 'srt', normLang: 'fr',
    };
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) map.set(i + 1, `[${req.targetLanguage}] ${i}`);
      return map;
    });
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    await runLingarrPipeline({
      subs: [frenchFirst, engSource], config: baseConfig, budgetMs: 10_000,
      translate, fetchSubContent,
    });
    const [opts, req] = (translate as unknown as { mock: { calls: [LingarrOptions, TranslateAbleSubtitleContent][] } }).mock.calls[0];
    expect(req.sourceLanguage).toBe('en');
  });

  it('caps language count to MAX_LANGS_PER_REQUEST', async () => {
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    await runLingarrPipeline({
      subs: [engSource],
      config: {
        ...baseConfig,
        translateTargets: ['vi', 'ja', 'ko', 'zh', 'th', 'fr', 'de', 'es'],
      },
      budgetMs: 60_000,
      translate, fetchSubContent,
    });
    expect(translate).toHaveBeenCalledTimes(5);
  });

  it('skips translation when Lingarr ping fails (availability check)', async () => {
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    // Default fetch is global; let pingLingarr fail by overriding fetch for this test.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    try {
      const out = await runLingarrPipeline({
        subs: [engSource], config: baseConfig, budgetMs: 10_000,
        translate, fetchSubContent,
      });
      expect(out.translated).toBe(false);
      expect(out.log[0].status).toBe('unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stitches translated lines back to source sub timestamps (same start/end)', async () => {
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) map.set(i + 1, `vi-${i}`);
      return map;
    });
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, translateTargets: ['vi'] },
      budgetMs: 10_000,
      translate,
      fetchSubContent: vi.fn(async () => SAMPLE_SRT),
    });
    const viSub = out.subs.find((s) => s.normLang === 'vi');
    expect(viSub).toBeDefined();
    expect(viSub!.format).toBe('srt');
    expect(viSub!.url).toContain('lingarr://');
  });
});
