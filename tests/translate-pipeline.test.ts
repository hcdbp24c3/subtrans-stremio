import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { runLingarrPipeline, LingarrSourceSub } from '../src/lib/translate-pipeline.js';
import { AddonConfig } from '../src/config.js';
import { clearTranslationCache } from '../src/lib/translate-cache.js';
import { ProviderRequest, TranslateResult } from '../src/lib/providers/index.js';

type FetchMock = MockInstance<typeof fetch>;

const baseConfig: AddonConfig = {
  streamUrls: ['https://x.com/stream/manifest.json'],
  subUrls: ['https://x.com/sub/manifest.json'],
  languages: '',
  translateProvider: 'openai',
  translateKey: 'sk-test',
  translateBaseUrl: '',
  translateModel: '',
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

type TranslateMockFn = (req: ProviderRequest) => Promise<TranslateResult>;

function makeTranslateMock(
  response: Map<number, string> | ((req: ProviderRequest) => Map<number, string>),
): TranslateMockFn {
  return vi.fn(async (req: ProviderRequest) => {
    const lines = typeof response === 'function' ? response(req) : response;
    return { lines, ok: lines.size > 0 } satisfies TranslateResult;
  }) as unknown as TranslateMockFn;
}

describe('runLingarrPipeline', () => {
  beforeEach(() => { clearTranslationCache(); });
  afterEach(() => { clearTranslationCache(); });

  // Mock global fetch so the pipeline's fetchText() returns SAMPLE_SRT
  // for any upstream sub URL. Avoids real network calls in tests.
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response(SAMPLE_SRT, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns subs unchanged when no provider configured', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, translateProvider: '' }, budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
    expect(out.subs).toEqual([engSource]);
  });

  it('returns subs unchanged when provider is unknown', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, translateProvider: 'not-real' },
      budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
    expect(out.log[0].status).toBe('no-provider');
  });

  it('returns subs unchanged when API key missing for required-key provider', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: { ...baseConfig, translateKey: '' }, budgetMs: 10_000,
    });
    expect(out.translated).toBe(false);
    expect(out.log[0].status).toBe('no-key');
  });

  it('returns subs unchanged when budget is too low', async () => {
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 1_000,
    });
    expect(out.translated).toBe(false);
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
        map.set(i + 1, `[${req.targetLanguage}] ${req.lines[i].text}`);
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
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('uses cache on second request (no upstream call)', async () => {
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) map.set(i + 1, `[vi] line ${i}`);
      return map;
    });

    const first = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate,
    });
    expect(first.translated).toBe(true);
    expect(translate).toHaveBeenCalledTimes(2);

    const second = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate,
    });
    expect(second.translated).toBe(true);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('caches per provider (cache hit only for same provider)', async () => {
    clearTranslationCache();
    const fetchSubContent = vi.fn(async () => SAMPLE_SRT);
    const translate = makeTranslateMock((req) => {
      const map = new Map<number, string>();
      for (let i = 0; i < req.lines.length; i++) map.set(i + 1, `[${req.targetLanguage}] ${i}`);
      return map;
    });
    // First call with openai
    await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000, translate, fetchSubContent,
    });
    // Same source+target but different provider — should NOT hit cache
    const translate2 = makeTranslateMock(new Map());
    const out = await runLingarrPipeline({
      subs: [engSource],
      config: { ...baseConfig, translateProvider: 'google' },
      budgetMs: 10_000, translate: translate2, fetchSubContent,
    });
    // google returned empty, so no translation, but it still called the mock
    expect(translate2).toHaveBeenCalledTimes(2);
    expect(out.translated).toBe(false);
  });

  it('marks source-fetch failure in log and continues with other langs', async () => {
    // Use a non-existent track so pickBestSource skips. Pipeline logs
    // no-source and returns translated=false.
    const translate = makeTranslateMock(new Map());
    const out = await runLingarrPipeline({
      subs: [], config: baseConfig, budgetMs: 10_000,
      translate,
    });
    expect(out.translated).toBe(false);
    expect(out.log.every((l) => l.status === 'no-source' || l.status === 'failed')).toBe(true);
  });

  it('marks provider ok=false as failed', async () => {
    const translate = vi.fn(async () => ({ lines: new Map(), ok: false, reason: 'rate limit' }));
    const out = await runLingarrPipeline({
      subs: [engSource], config: baseConfig, budgetMs: 10_000,
      translate: translate as TranslateMockFn,
    });
    expect(out.translated).toBe(false);
    expect(out.log.every((l) => l.status === 'failed')).toBe(true);
    // The chunked pipeline reports "0/N chunks succeeded" instead of the
    // raw provider reason (which is opaque across chunks). The original
    // rate-limit reason still surfaces in [provider] log output.
    expect(out.log[0].detail).toMatch(/0\/\d+ chunks succeeded/);
  });

  it('normalizes source lang via pickBestSource (eng upstream track → en)', async () => {
    // Provide a synthetic eng upstream sub with 3-letter lang code
    // (matches typical SubSense / OpenSubtitles tagging) and no pre-
    // normalized normLang so the pipeline applies its 639-2 -> 639-1
    // normalization on the way to the provider.
    const syntheticEng: LingarrSourceSub = {
      id: 'synthetic',
      url: 'https://x.com/en.srt',
      lang: 'eng',
      format: 'srt',
      // normLang intentionally omitted — pipeline will derive it
    };
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    await runLingarrPipeline({
      subs: [syntheticEng],
      config: { ...baseConfig, translateTargets: ['vi'] },
      budgetMs: 10_000,
      translate,
    });
    const calls = (translate as unknown as { mock: { calls: [ProviderRequest][] } }).mock.calls;
    expect(calls[0][0].sourceLanguage).toBe('en');
  });

  it('caps language count to MAX_LANGS_PER_REQUEST', async () => {
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    await runLingarrPipeline({
      subs: [engSource],
      config: { ...baseConfig, translateTargets: ['vi', 'ja', 'ko', 'zh', 'th', 'fr', 'de', 'es'] },
      budgetMs: 60_000,
      translate,
    });
    expect(translate).toHaveBeenCalledTimes(5);
  });

  it('deduplicates normalized target languages (e.g. vi and vie)', async () => {
    const translate = makeTranslateMock(new Map([[1, 'x']]));
    await runLingarrPipeline({
      subs: [engSource],
      config: { ...baseConfig, translateTargets: ['vi', 'vie'] },
      budgetMs: 60_000,
      translate,
    });
    expect(translate).toHaveBeenCalledTimes(1);
  });
});
