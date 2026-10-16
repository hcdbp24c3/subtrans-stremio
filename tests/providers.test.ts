import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { openaiProvider, OPENAI_DEFAULT_MODEL } from '../src/lib/providers/openai.js';
import { anthropicProvider } from '../src/lib/providers/anthropic.js';
import { deeplProvider } from '../src/lib/providers/deepl.js';
import { googleProvider } from '../src/lib/providers/google.js';
import { geminiProvider } from '../src/lib/providers/gemini.js';
import { libretranslateProvider } from '../src/lib/providers/libretranslate.js';
import { bingProvider } from '../src/lib/providers/bing.js';
import { yandexProvider } from '../src/lib/providers/yandex.js';
import { openaiProvider } from '../src/lib/providers/openai.js';
import { mistralProvider, xaiProvider, ollamaProvider } from '../src/lib/providers/openai-compat.js';
import { buildChatPrompt, parseChatResponse } from '../src/lib/providers/_helpers.js';
import { SubtitleEntry } from '../src/lib/subtitle-parser.js';

type FetchMock = MockInstance<typeof fetch>;

function mockFetchOk(setup: (mock: FetchMock) => void) {
  const mock = vi.fn();
  setup(mock);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const SAMPLE_ENTRIES: SubtitleEntry[] = [
  { start: 0, end: 1, text: 'Hello' },
  { start: 1, end: 2, text: 'How are you' },
];

describe('buildChatPrompt', () => {
  it('numbers lines and embeds source/target langs', () => {
    const p = buildChatPrompt({ sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES });
    expect(p.system).toMatch(/en/i);
    expect(p.system).toMatch(/vi/i);
    expect(p.user).toBe('1. Hello\n2. How are you');
  });
});

describe('parseChatResponse', () => {
  it('parses numbered-dot format', () => {
    const map = parseChatResponse('1. Xin chào\n2. Bạn khỏe không', 2);
    expect(map?.get(1)).toBe('Xin chào');
    expect(map?.get(2)).toBe('Bạn khỏe không');
  });
  it('parses numbered-paren format', () => {
    const map = parseChatResponse('1) Xin\n2) Chao', 2);
    expect(map?.get(1)).toBe('Xin');
  });
  it('returns null on garbage', () => {
    expect(parseChatResponse('', 2)).toBeNull();
    expect(parseChatResponse(null, 2)).toBeNull();
    expect(parseChatResponse(42, 2)).toBeNull();
  });
  it('ignores out-of-range positions', () => {
    const map = parseChatResponse('1. ok\n99. skip', 2);
    expect(map?.size).toBe(1);
    expect(map?.get(1)).toBe('ok');
  });
});

describe('openaiProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends Authorization Bearer + correct URL', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. Xin chào\n2. Bạn khỏe không' } }] }),
        { status: 200 }),
    ));
    const res = await openaiProvider.translate(
      { apiKey: 'sk-test', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(res.ok).toBe(true);
    expect(res.lines.get(1)).toBe('Xin chào');
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe(OPENAI_DEFAULT_MODEL);
    expect(body.messages).toHaveLength(2);
  });

  it('uses custom baseUrl when provided', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. x' } }] }),
        { status: 200 }),
    ));
    await openaiProvider.translate(
      { apiKey: 'k', baseUrl: 'http://localhost:11434/', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url] = (mock.mock.calls[0] ?? []) as [string];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('returns ok=false on HTTP 4xx', async () => {
    mockFetchOk((m) => m.mockResolvedValueOnce(new Response('forbidden', { status: 403 })));
    const res = await openaiProvider.translate(
      { apiKey: 'k', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/403/);
  });

  it('returns ok=false on network error', async () => {
    mockFetchOk((m) => m.mockRejectedValueOnce(new Error('ECONNREFUSED')));
    const res = await openaiProvider.translate(
      { apiKey: 'k', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/network/);
  });
});

describe('anthropicProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends x-api-key + anthropic-version headers (NOT Bearer)', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: '1. Xin\n2. Chao' }] }),
        { status: 200 }),
    ));
    const res = await anthropicProvider.translate(
      { apiKey: 'sk-ant-test', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(res.ok).toBe(true);
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(headers['Authorization']).toBeUndefined();
  });

  it('returns ok=false when no text block', async () => {
    mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    ));
    const res = await anthropicProvider.translate(
      { apiKey: 'k', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(res.ok).toBe(false);
  });
});

describe('deeplProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('picks free base URL for :fx keys', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ translations: [{ text: 'Xin' }, { text: 'Chao' }] }),
        { status: 200 }),
    ));
    await deeplProvider.translate(
      { apiKey: 'abc:fx', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('DeepL-Auth-Key abc:fx');
    const body = JSON.parse(String(init.body)) as { source_lang: string; target_lang: string };
    expect(body.source_lang).toBe('EN');
    expect(body.target_lang).toBe('VI');
  });

  it('picks pro base URL for non-:fx keys', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ translations: [{ text: 'Xin' }] }),
        { status: 200 }),
    ));
    await deeplProvider.translate(
      { apiKey: 'pro-key', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url] = (mock.mock.calls[0] ?? []) as [string];
    expect(url).toBe('https://api.deepl.com/v2/translate');
  });
});

describe('googleProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends API key in query string, body contains q as array', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { translations: [{ translatedText: 'Xin' }, { translatedText: 'Chao' }] } }),
        { status: 200 }),
    ));
    await googleProvider.translate(
      { apiKey: 'AIza-test', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toContain('key=AIza-test');
    expect(url).toContain('/language/translate/v2');
    const body = JSON.parse(String(init.body)) as { q: string[]; source: string; target: string };
    expect(body.q).toEqual(['Hello', 'How are you']);
    expect(body.source).toBe('en');
    expect(body.target).toBe('vi');
  });
});

describe('geminiProvider (OpenAI-compat)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('delegates to OpenAI with default Gemini base + model', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. Xin' } }] }), { status: 200 }),
    ));
    await geminiProvider.translate(
      { apiKey: 'AIza-gemini', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1/chat/completions');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer AIza-gemini');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('gemini-2.0-flash');
  });
});

describe('openai-compat providers (Mistral, xAI)', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('mistralProvider uses its default base + model', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. x' } }] }), { status: 200 }),
    ));
    await mistralProvider.translate(
      { apiKey: 'msk', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('mistral-small-latest');
  });

  it('xaiProvider uses its default base + model', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. x' } }] }), { status: 200 }),
    ));
    await xaiProvider.translate(
      { apiKey: 'xai-key', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://api.x.ai/v1/chat/completions');
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe('grok-2-latest');
  });

  it('ollamaProvider does not require an API key', () => {
    expect(ollamaProvider.requiresKey).toBe(false);
    expect(ollamaProvider.defaultBaseUrl).toBe('http://localhost:11434');
  });

  it('openaiProvider skips Authorization header when apiKey is empty (Ollama/LocalAI)', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: '1. x' } }] }), { status: 200 }),
    ));
    await openaiProvider.translate(
      { apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    const [, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('libretranslateProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends array body with one entry per text and parses object response', async () => {
    const mock = mockFetchOk((m) => m.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { q: string } : { q: '' };
      const text = body.q === 'Hello' ? 'Xin' : 'Chao';
      return new Response(JSON.stringify({ translatedText: text }), { status: 200 });
    }));
    const result = await libretranslateProvider.translate(
      { apiKey: '', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(result.ok).toBe(true);
    expect(result.lines.get(1)).toBe('Xin');
    expect(result.lines.get(2)).toBe('Chao');
    expect(mock.mock.calls.length).toBe(2);
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toContain('libretranslate.com/translate');
    // source/target are in the body, not query string
    const firstBody = JSON.parse(String(init.body)) as { q: string; format: string; source: string; target: string };
    expect(firstBody.q).toBe('Hello');
    expect(firstBody.format).toBe('text');
    expect(firstBody.source).toBe('en');
    expect(firstBody.target).toBe('vi');
  });

  it('passes api_key in body when set', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValue(
      new Response(JSON.stringify({ translatedText: 'x' }), { status: 200 }),
    ));
    await libretranslateProvider.translate(
      { apiKey: 'lt-key', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(mock.mock.calls.length).toBeGreaterThan(0);
    const init = (mock.mock.calls[0]?.[1] ?? {}) as RequestInit;
    const body = JSON.parse(String(init.body)) as { api_key?: string };
    expect(body.api_key).toBe('lt-key');
  });

  it('returns ok=false when all requests fail', async () => {
    mockFetchOk((m) => m.mockResolvedValue(new Response('forbidden', { status: 403 })));
    const result = await libretranslateProvider.translate(
      { apiKey: '', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/403/);
  });
});

describe('bingProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends Ocp-Apim-Subscription-Key + array body', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify([
        { translations: [{ text: 'Xin chào', to: 'vi' }] },
        { translations: [{ text: 'Bạn khỏe không', to: 'vi' }] },
      ]), { status: 200 }),
    ));
    const result = await bingProvider.translate(
      { apiKey: 'bing-key', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(result.ok).toBe(true);
    expect(result.lines.get(1)).toBe('Xin chào');
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toContain('api-version=3.0');
    expect(url).toContain('from=en&to=vi');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('bing-key');
    const body = JSON.parse(String(init.body)) as { Text: string }[];
    expect(body[0].Text).toBe('Hello');
    expect(body[1].Text).toBe('How are you');
  });
});

describe('yandexProvider', () => {
  let originalFetch: typeof fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('sends Api-Key header + texts array', async () => {
    const mock = mockFetchOk((m) => m.mockResolvedValueOnce(
      new Response(JSON.stringify({
        translations: [{ text: 'Xin' }, { text: 'Chao' }],
      }), { status: 200 }),
    ));
    const result = await yandexProvider.translate(
      { apiKey: 'yc-key', timeoutMs: 5000 },
      { sourceLanguage: 'en', targetLanguage: 'vi', lines: SAMPLE_ENTRIES },
    );
    expect(result.ok).toBe(true);
    expect(result.lines.get(1)).toBe('Xin');
    const [url, init] = (mock.mock.calls[0] ?? []) as [string, RequestInit];
    expect(url).toBe('https://translate.api.cloud.yandex.net/translate/v2/translate');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Api-Key yc-key');
    const body = JSON.parse(String(init.body)) as { sourceLanguageCode: string; texts: string[] };
    expect(body.sourceLanguageCode).toBe('en');
    expect(body.texts).toEqual(['Hello', 'How are you']);
  });
});
