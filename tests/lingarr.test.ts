import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import {
  buildTranslateRequest, parseTranslateResponse,
  translateContent, pingLingarr,
  BatchTranslatedLine, TranslateAbleSubtitleContent,
} from '../src/lib/lingarr.js';
import { SubtitleEntry } from '../src/lib/subtitle-parser.js';

type FetchMock = MockInstance<typeof fetch>;

describe('buildTranslateRequest', () => {
  it('builds 1-based positions; keeps empty text so positions match source sub', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 1, text: 'Hello' },
      { start: 1, end: 2, text: '   ' },       // whitespace-only → kept (position must align)
      { start: 2, end: 3, text: '' },          // empty → kept
      { start: 3, end: 4, text: 'World' },
    ];
    const req = buildTranslateRequest(entries, 'en', 'vi', 'Movie', 'Test');
    expect(req.arrMediaId).toBe(0);
    expect(req.sourceLanguage).toBe('en');
    expect(req.targetLanguage).toBe('vi');
    expect(req.mediaType).toBe('Movie');
    expect(req.title).toBe('Test');
    expect(req.lines).toEqual([
      { position: 1, line: 'Hello' },
      { position: 2, line: '   ' },
      { position: 3, line: '' },
      { position: 4, line: 'World' },
    ]);
  });

  it('defaults mediaType to Movie and title to undefined', () => {
    const req = buildTranslateRequest([{ start: 0, end: 1, text: 'a' }], 'en', 'vi');
    expect(req.mediaType).toBe('Movie');
    expect(req.title).toBeUndefined();
  });

  it('preserves entry order via position', () => {
    const entries: SubtitleEntry[] = Array.from({ length: 5 }, (_, i) => ({
      start: i, end: i + 1, text: `line ${i}`,
    }));
    const req = buildTranslateRequest(entries, 'en', 'ja');
    expect(req.lines.map((l) => l.position)).toEqual([1, 2, 3, 4, 5]);
    expect(req.lines.map((l) => l.line)).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4']);
  });
});

describe('parseTranslateResponse', () => {
  it('parses valid array into position→line map', () => {
    const raw: BatchTranslatedLine[] = [
      { position: 1, line: 'Xin chào' },
      { position: 2, line: 'Thế giới' },
    ];
    const map = parseTranslateResponse(raw);
    expect(map).not.toBeNull();
    expect(map!.get(1)).toBe('Xin chào');
    expect(map!.get(2)).toBe('Thế giới');
    expect(map!.size).toBe(2);
  });

  it('returns null for non-array input', () => {
    expect(parseTranslateResponse({ position: 1, line: 'x' })).toBeNull();
    expect(parseTranslateResponse(null)).toBeNull();
    expect(parseTranslateResponse('string')).toBeNull();
    expect(parseTranslateResponse(undefined)).toBeNull();
  });

  it('returns null when array is empty or all entries are malformed', () => {
    expect(parseTranslateResponse([])).toBeNull();
    // no usable (position,line) pair
    expect(parseTranslateResponse([{ position: 1 }, { line: 'no pos' }])).toBeNull();
  });

  it('skips malformed items but keeps good ones', () => {
    const raw = [
      { position: 1, line: 'good' },
      { line: 'no position' },
      { position: 'x', line: 'bad position' },
      { position: 2 },
      { position: 3, line: 'also good' },
    ];
    const map = parseTranslateResponse(raw);
    expect(map).not.toBeNull();
    expect(map!.size).toBe(2);
    expect(map!.get(1)).toBe('good');
    expect(map!.get(3)).toBe('also good');
  });

  it('keeps last value when duplicate positions arrive (defensive)', () => {
    const raw = [
      { position: 1, line: 'first' },
      { position: 1, line: 'second' },
    ];
    const map = parseTranslateResponse(raw);
    expect(map!.get(1)).toBe('second');
  });
});

describe('translateContent', () => {
  let originalFetch: typeof fetch;
  let mockFetch: FetchMock;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const baseRequest: TranslateAbleSubtitleContent = {
    arrMediaId: 0,
    sourceLanguage: 'en',
    targetLanguage: 'vi',
    mediaType: 'Movie',
    lines: [{ position: 1, line: 'Hello' }],
  };

  function lastCall(): { url: string; init: RequestInit } {
    const calls = mockFetch.mock.calls as Array<[string, RequestInit]>;
    const last = calls[calls.length - 1];
    return { url: last[0], init: last[1] };
  }

  it('POSTs to /api/translate/content and returns parsed map', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ position: 1, line: 'Xin chào' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await translateContent(
      { baseUrl: 'http://lingarr:9876', apiKey: 'k1' },
      baseRequest,
    );
    expect(result.ok).toBe(true);
    expect(result.lines.get(1)).toBe('Xin chào');

    const { url, init } = lastCall();
    expect(url).toBe('http://lingarr:9876/api/translate/content');
    expect(init.method).toBe('POST');
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Api-Key']).toBe('k1');
    const body = JSON.parse(String(init.body)) as { targetLanguage: string };
    expect(body.targetLanguage).toBe('vi');
  });

  it('strips trailing slash from baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ position: 1, line: 'x' }]), { status: 200 }),
    );
    await translateContent({ baseUrl: 'http://h:9876///' }, baseRequest);
    expect(lastCall().url).toBe('http://h:9876/api/translate/content');
  });

  it('omits X-Api-Key when no key provided (Lingarr has auth disabled)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ position: 1, line: 'x' }]), { status: 200 }),
    );
    await translateContent({ baseUrl: 'http://h:9876' }, baseRequest);
    const headers = (lastCall().init.headers ?? {}) as Record<string, string | undefined>;
    expect(headers['X-Api-Key']).toBeUndefined();
  });

  it('returns ok=false on non-OK HTTP', async () => {
    mockFetch.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    const result = await translateContent({ baseUrl: 'http://h:9876' }, baseRequest);
    expect(result.ok).toBe(false);
    expect(result.lines.size).toBe(0);
  });

  it('returns ok=false when fetch throws (network error / timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await translateContent({ baseUrl: 'http://h:9876' }, baseRequest);
    expect(result.ok).toBe(false);
  });

  it('returns ok=false when response body is not a usable array', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'no service configured' }), { status: 200 }),
    );
    const result = await translateContent({ baseUrl: 'http://h:9876' }, baseRequest);
    expect(result.ok).toBe(false);
  });
});

describe('pingLingarr', () => {
  let originalFetch: typeof fetch;
  let mockFetch: FetchMock;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns true when /api/version returns 2xx', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ version: '1.3.0' }), { status: 200 }),
    );
    expect(await pingLingarr('http://h:9876')).toBe(true);
  });

  it('returns false on non-OK', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));
    expect(await pingLingarr('http://h:9876')).toBe(false);
  });

  it('returns false on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('down'));
    expect(await pingLingarr('http://h:9876')).toBe(false);
  });
});
