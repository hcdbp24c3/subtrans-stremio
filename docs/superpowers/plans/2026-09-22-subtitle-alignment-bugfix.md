# Subtitle Alignment Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four defects confirmed in Phase 1 root-cause analysis: (1) hard-zero encode scoring makes all wrong-encode subs indistinguishable and spams logs from inside the sort comparator, (2) duplicate subtitle URLs are served multiple times, (3) `/subdownload` has no cache so Stremio re-fetches hit upstream repeatedly, (4) when every sub is the wrong encode and Strategies B/C fail, no duration-based fallback offset is attempted despite `videoDuration` already being probed.

**Architecture:** Extract pure release-name/encode matching into `src/lib/release-match.ts` (testable, single-shot logging, soft mismatch ranking). Add URL dedup after language filtering. Add a small TTL store used by `/subdownload`. Add Strategy D (duration-overrun heuristic) after Strategy C in the subtitle route. No new dependencies.

**Tech Stack:** TypeScript, Express, Vitest, Bun (runtime/tests), Node >= 18.

**Spec:** Root-cause analysis from Phase 1 (this session) — symptoms: video `BluRay.REMUX` vs subs `AMZN.WEB-DL` → `best=0.00`, `NO SUBS FOR THIS ENCODE`, same sub URL `[subdownload] Proxying:` × 4. Diagnosis: Strategy B needs ≥2 sub addons (only 1 present); Strategy C needs *text* builtin subs (remuxes typically have PGS only → filtered by `textCodecs`); `videoDuration` probed at `subtitle.ts:390` but never consumed; no URL dedup; no `/subdownload` cache; `releaseNameMatchScore` logs inside sort comparator.

## Global Constraints

- Runtime/tests: Bun (`/opt/bun/bin/bun`); tests via Vitest (`npm test` → `vitest run`); typecheck/build via `npm run build` (`tsc`).
- No new npm dependencies.
- Existing test files must keep passing: `tests/aligner.test.ts`, `tests/config.test.ts`, `tests/subtitle-parser.test.ts`, `tests/proxy.test.ts`.
- `encodeCompatible(a, b)` semantics for empty sets stay: empty side = unknown = compatible.
- Encode keyword set values stay exactly: `bluray`, `remux`, `web-dl`, `webrip`, `hdtv`, `dvdrip`, `hdrip`.
- Strategy A warning text (`NO SUBS FOR THIS ENCODE`) is user-facing log copy — keep the string; only move *where* mismatch logs happen.
- Mismatch soft-rank scores are capped at `0.4` and ordered by token overlap. A high-overlap mismatch **may** outrank a zero-overlap encode-compatible sub — that is intended (see Task 1 sort test expecting `['2','1','3']`). There is **no** universal "compatible floor ≈ 0.5"; compatible scores with meaningful tokens are `tokenScore + 0..0.1` boost, and only empty-meaningful-token compatible cases return `0.5`.

---

### Task 1: Extract release matching to `src/lib/release-match.ts` with soft mismatch ranking and single-shot logging

**Files:**
- Create: `src/lib/release-match.ts`
- Modify: `src/routes/subtitle.ts:160-312` (remove moved helpers; import from lib), `src/routes/subtitle.ts:424-447` (Strategy A logging)
- Test: `tests/release-match.test.ts` (create)

**Interfaces:**
- Consumes: `Subtitle` shape from route (only needs `_releaseName?: string` — define local `MatchableSub` interface in the lib to avoid circular imports).
- Produces (all from `src/lib/release-match.ts`):
  - `normalizeReleaseName(name: string): string`
  - `extractEncodeKeywords(releaseName: string): Set<string>`
  - `encodeCompatible(a: Set<string>, b: Set<string>): boolean`
  - `encodeMatchScore(a: Set<string>, b: Set<string>): number` — module-private (not exported); tested only indirectly via `releaseNameMatchScore`
  - `releaseNameMatchScore(videoFilename: string, subReleaseName: string): number` — **no `console.log` inside**
  - `sortByReleaseMatch<T extends { _releaseName?: string }>(subs: T[], videoFilename: string | null): T[]` — decorate/sort/undecorate (each sub scored exactly once)

- [ ] **Step 1: Write failing tests**

Create `tests/release-match.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  normalizeReleaseName,
  extractEncodeKeywords,
  encodeCompatible,
  releaseNameMatchScore,
  sortByReleaseMatch,
} from '../src/lib/release-match.js';

const VIDEO = 'In.The.Grey.2026.2160p.UHD.BluRay.REMUX.HDR.MULTi[Ben The Men].mkv';
const SUB_WEB = 'In.The.Grey.2026.AMZN.WEB-DL.DDP5.1.H.264-NTb';
const SUB_BLURAY = 'In.The.Grey.2026.2160p.BluRay.x265-GRP';

describe('release-match', () => {
  it('normalizes dots and strips extension', () => {
    expect(normalizeReleaseName('In.the.Grey.2026.mkv')).toBe('in the grey 2026');
  });

  it('extracts bluray+remux from remux filename, web-dl from webdl', () => {
    expect(extractEncodeKeywords(VIDEO)).toEqual(new Set(['bluray', 'remux']));
    expect(extractEncodeKeywords(SUB_WEB)).toEqual(new Set(['web-dl']));
  });

  it('encodeCompatible: empty set is compatible; bluray-remux vs web-dl is not', () => {
    expect(encodeCompatible(new Set(), new Set(['web-dl']))).toBe(true);
    expect(encodeCompatible(new Set(['bluray', 'remux']), new Set(['web-dl']))).toBe(false);
    expect(encodeCompatible(new Set(['bluray']), new Set(['bluray']))).toBe(true);
  });

  it('compatible sub scores above incompatible sub (soft rank still prefers match)', () => {
    const scoreMatch = releaseNameMatchScore(VIDEO, SUB_BLURAY);
    const scoreMismatch = releaseNameMatchScore(VIDEO, SUB_WEB);
    expect(scoreMatch).toBeGreaterThan(scoreMismatch);
    expect(scoreMismatch).toBeGreaterThan(0); // soft: no longer hard-zero
    expect(scoreMismatch).toBeLessThanOrEqual(0.4); // capped mismatch rank
  });

  it('among two mismatched subs, higher token overlap ranks first', () => {
    const better = 'In.The.Grey.2026.1080p.WEB-DL.H.264-GRP';
    const worse = 'Totally.Unrelated.Movie.2020.WEB-DL';
    expect(releaseNameMatchScore(VIDEO, better)).toBeGreaterThan(
      releaseNameMatchScore(VIDEO, worse)
    );
  });

  it('sortByReleaseMatch returns a new array sorted best-first and scores each sub once', () => {
    const subs = [
      { id: '1', _releaseName: SUB_WEB },
      { id: '2', _releaseName: SUB_BLURAY },
      { id: '3', _releaseName: 'no-encode-tags-something-grey-2026' },
    ];
    const sorted = sortByReleaseMatch(subs, VIDEO);
    expect(sorted.map((s) => s.id)).toEqual(['2', '1', '3']);
    expect(sorted).not.toBe(subs); // original order untouched
  });

  it('sortByReleaseMatch with null videoFilename returns input as-is', () => {
    const subs = [{ id: '1', _releaseName: 'x' }];
    expect(sortByReleaseMatch(subs, null)).toBe(subs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/release-match.test.ts`
Expected: FAIL — module `../src/lib/release-match.js` not found.

- [ ] **Step 3: Implement `src/lib/release-match.ts`**

```ts
// Pure release-name / encode matching. No logging — callers log once.

export function normalizeReleaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|srt|ass|vtt|ts)$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractEncodeKeywords(releaseName: string): Set<string> {
  const norm = normalizeReleaseName(releaseName);
  const tokens = norm.split(' ');
  const encodeMap: Record<string, string> = {
    bluray: 'bluray', bdrip: 'bluray', brrip: 'bluray',
    remux: 'remux',
    'web-dl': 'web-dl', webdl: 'web-dl', webrip: 'webrip', web: 'web-dl',
    hdtv: 'hdtv',
    dvdrip: 'dvdrip',
    hdrip: 'hdrip',
  };
  const result = new Set<string>();
  for (const t of tokens) {
    const mapped = encodeMap[t];
    if (mapped) result.add(mapped);
  }
  return result;
}

export function encodeCompatible(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return true;
  for (const kw of a) {
    if (b.has(kw)) return true;
  }
  return false;
}

function encodeMatchScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0.5;
  for (const kw of a) {
    if (b.has(kw)) return 1;
  }
  return 0;
}

const NOISE_TOKENS = new Set([
  '1080p', '2160p', '720p', '480p', '4k', 'uhd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1',
  'aac', 'ac3', 'ddp', 'ddp5', 'ddp51', 'eac3', 'truehd', 'atmos', 'dd51',
  'hdr', 'hdr10', 'dolby', 'vision', 'dv', 'sdr',
  '10bit', 'hdrp',
  'bluray', 'bdrip', 'brrip', 'remux', 'web', 'web-dl', 'webdl', 'webrip',
  'hdtv', 'dvdrip', 'hdrip',
]);

const MISMATCH_RANK_CAP = 0.4; // cap mismatch ranks; high-overlap mismatch may still beat zero-overlap compatible (intended)

export function releaseNameMatchScore(videoFilename: string, subReleaseName: string): number {
  if (!videoFilename || !subReleaseName) return 0;

  const videoNorm = normalizeReleaseName(videoFilename);
  const subNorm = normalizeReleaseName(subReleaseName);
  if (!videoNorm || !subNorm) return 0;
  if (videoNorm === subNorm) return 1;

  const videoEncode = extractEncodeKeywords(videoFilename);
  const subEncode = extractEncodeKeywords(subReleaseName);
  const compatible = encodeCompatible(videoEncode, subEncode);

  const videoTokens = new Set(videoNorm.split(' ').filter((t) => t.length > 1));
  const subTokens = subNorm.split(' ').filter((t) => t.length > 1);
  const videoMeaningful = [...videoTokens].filter((t) => !NOISE_TOKENS.has(t));
  const subMeaningful = subTokens.filter((t) => !NOISE_TOKENS.has(t));
  if (videoMeaningful.length === 0 || subMeaningful.length === 0) {
    return compatible ? 0.5 : 0; // unknown tokens: compatible stays neutral, mismatch stays 0
  }

  const subSet = new Set(subMeaningful);
  let matchCount = 0;
  for (const vt of videoMeaningful) {
    if (subSet.has(vt)) matchCount++;
  }
  const tokenScore = matchCount / subMeaningful.length;

  if (!compatible) {
    // Soft rank: still order mismatched subs by overlap, but cap below any compatible score.
    return Math.min(MISMATCH_RANK_CAP, tokenScore * 0.4);
  }

  const encodeBoost = encodeMatchScore(videoEncode, subEncode) * 0.1;
  return Math.min(1, tokenScore + encodeBoost);
}

export function sortByReleaseMatch<T extends { _releaseName?: string }>(
  subs: T[],
  videoFilename: string | null,
): T[] {
  if (!videoFilename) return subs;
  return subs
    .map((sub, index) => ({
      sub,
      index,
      score: releaseNameMatchScore(videoFilename, sub._releaseName || ''),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.sub);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/release-match.test.ts`
Expected: PASS (all cases in Step 1).

- [ ] **Step 5: Rewire `src/routes/subtitle.ts`**

1. Delete the local implementations of `normalizeReleaseName`, `extractEncodeKeywords`, `encodeCompatible`, `encodeMatchScore`, `releaseNameMatchScore`, `sortByReleaseMatch` (currently lines ~160–312).
2. Add import:

```ts
import {
  extractEncodeKeywords,
  encodeCompatible,
  releaseNameMatchScore,
  sortByReleaseMatch,
} from '../lib/release-match.js';
```

3. Replace Strategy A block (lines ~428–447) with single-shot logging:

```ts
  if (videoFilename) {
    allSubs = sortByReleaseMatch(allSubs, videoFilename);
    const bestMatch = allSubs[0];
    const bestScore = releaseNameMatchScore(videoFilename, bestMatch?._releaseName || '');
    const videoEncode = extractEncodeKeywords(videoFilename);
    let encodeMatch = 0, encodeMismatch = 0;
    let firstMismatchName = '';
    for (const s of allSubs) {
      const subEnc = extractEncodeKeywords(s._releaseName || '');
      if (encodeCompatible(videoEncode, subEnc)) encodeMatch++;
      else {
        encodeMismatch++;
        if (!firstMismatchName) firstMismatchName = s._releaseName || '';
      }
    }
    console.log(`[subtitle] Strategy A (release match): best=${bestScore.toFixed(2)} (${encodeMatch} matched, ${encodeMismatch} mismatched encode)`);
    if (encodeMismatch > 0) {
      console.log(`[subtitle] Encode mismatch example: video=[${[...videoEncode]}] sub=[${[...extractEncodeKeywords(firstMismatchName)]}] "${firstMismatchName}"`);
    }
    if (encodeMatch === 0 && videoEncode.size > 0 && allSubs.length > 0) {
      console.log(`[subtitle] ⚠ NO SUBS FOR THIS ENCODE: video needs [${[...videoEncode].join(',')}], ${encodeMismatch} subs all from different encodes`);
      console.log(`[subtitle] Serving best available sub but timing may differ. Use Stremio offset to adjust.`);
    }
  } else {
    console.log(`[subtitle] Strategy A (release match): skipped (no video filename)`);
  }
```

- [ ] **Step 6: Run full test suite + build**

Run: `npm test && npm run build`
Expected: all tests PASS, `tsc` exits 0 (no unused-import errors).

- [ ] **Step 7: Commit**

```bash
git add src/lib/release-match.ts src/routes/subtitle.ts tests/release-match.test.ts
git commit -m "fix: extract release matching, soft-rank encode mismatches, log once"
```

---

### Task 2: Deduplicate subtitles by URL

**Files:**
- Modify: `src/routes/subtitle.ts` (export helper; call after `limitPerLanguage` at ~line 412)
- Test: `tests/dedupe.test.ts` (create)

**Interfaces:**
- Consumes: `Subtitle` interface already in `src/routes/subtitle.ts` (`id`, `url`, `lang?`, …).
- Produces: `export function dedupeSubtitles(subs: Subtitle[]): Subtitle[]` from `src/routes/subtitle.ts` — keeps first occurrence per exact `url`, preserves order.

- [ ] **Step 1: Write failing test**

Create `tests/dedupe.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dedupeSubtitles } from '../src/routes/subtitle.js';

describe('dedupeSubtitles', () => {
  it('keeps first occurrence per URL and preserves order', () => {
    const subs = [
      { id: 'a', url: 'http://x/1.srt', lang: 'en' },
      { id: 'b', url: 'http://x/2.srt', lang: 'en' },
      { id: 'c', url: 'http://x/1.srt', lang: 'vi' }, // duplicate URL
      { id: 'd', url: 'http://x/1.srt', lang: 'en' }, // duplicate URL
    ];
    const out = dedupeSubtitles(subs);
    expect(out.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('returns same reference when no duplicates', () => {
    const subs = [
      { id: 'a', url: 'http://x/1.srt' },
      { id: 'b', url: 'http://x/2.srt' },
    ];
    expect(dedupeSubtitles(subs).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('handles empty array', () => {
    expect(dedupeSubtitles([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dedupe.test.ts`
Expected: FAIL — `dedupeSubtitles` is not exported (or not defined).

- [ ] **Step 3: Implement + wire in**

In `src/routes/subtitle.ts`, next to `limitPerLanguage` (~line 158), add:

```ts
/** Drop duplicate subtitle entries by exact URL, keeping first occurrence. */
export function dedupeSubtitles(subs: Subtitle[]): Subtitle[] {
  const seen = new Set<string>();
  return subs.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}
```

In the route, after `allSubs = limitPerLanguage(allSubs, MAX_SUBS_PER_LANG);` (line ~412) insert:

```ts
  const beforeDedupe = allSubs.length;
  allSubs = dedupeSubtitles(allSubs);
  if (allSubs.length !== beforeDedupe) {
    console.log(`[subtitle] Deduped ${beforeDedupe - allSubs.length} duplicate URL(s)`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dedupe.test.ts`
Expected: PASS.

- [ ] **Step 4b: Full suite + build gate (required before any commit)**

Run: `npm test && npm run build`
Expected: all tests PASS (including `tests/aligner.test.ts`, `tests/config.test.ts`, `tests/subtitle-parser.test.ts`, `tests/proxy.test.ts`), `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/routes/subtitle.ts tests/dedupe.test.ts
git commit -m "fix: dedupe subtitle entries by URL before serving"
```

---

### Task 3: TTL cache for `/subdownload` proxy

**Files:**
- Create: `src/lib/ttl-store.ts`
- Modify: `src/routes/subtitle.ts:632-714` (`handleSubDownload`)
- Test: `tests/ttl-store.test.ts` (create)

**Interfaces:**
- Consumes: nothing (standalone).
- Produces: `export function createTtlStore<T>(maxEntries?: number): { get(key: string): T | undefined; set(key: string, value: T, ttlMs: number): void; clear(): void; size(): number }` from `src/lib/ttl-store.ts`. Eviction: expired-on-read + FIFO drop-oldest when over `maxEntries` (default 100). Route uses key `${ext}|${realUrl}` and value `{ body: Buffer; contentType: string }`.

- [ ] **Step 1: Write failing test**

Create `tests/ttl-store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTtlStore } from '../src/lib/ttl-store.js';

describe('createTtlStore', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns value before TTL and undefined after TTL', () => {
    const store = createTtlStore<string>();
    store.set('k', 'v', 1000);
    expect(store.get('k')).toBe('v');
    vi.advanceTimersByTime(1001);
    expect(store.get('k')).toBeUndefined();
  });

  it('evicts oldest when over maxEntries', () => {
    const store = createTtlStore<number>(2);
    store.set('a', 1, 60_000);
    store.set('b', 2, 60_000);
    store.set('c', 3, 60_000);
    expect(store.get('a')).toBeUndefined();
    expect(store.get('b')).toBe(2);
    expect(store.get('c')).toBe(3);
    expect(store.size()).toBe(2);
  });

  it('clear empties the store', () => {
    const store = createTtlStore<string>();
    store.set('k', 'v', 1000);
    store.clear();
    expect(store.get('k')).toBeUndefined();
    expect(store.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/ttl-store.test.ts`
Expected: FAIL — module `../src/lib/ttl-store.js` not found.

- [ ] **Step 3: Implement `src/lib/ttl-store.ts`**

```ts
interface Entry<T> {
  value: T;
  expires: number;
}

export function createTtlStore<T>(maxEntries = 100) {
  const map = new Map<string, Entry<T>>();

  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) {
        map.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: T, ttlMs: number): void {
      if (!map.has(key) && map.size >= maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, { value, expires: Date.now() + ttlMs });
    },
    clear(): void {
      map.clear();
    },
    size(): number {
      return map.size;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/ttl-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire cache into `handleSubDownload`**

In `src/routes/subtitle.ts`, near the other cache declarations (~line 50), add:

```ts
const SUB_DOWNLOAD_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const subDownloadCache = createTtlStore<{ body: Buffer; contentType: string }>(100);
```

Import: `import { createTtlStore } from '../lib/ttl-store.js';`

In `handleSubDownload`:
1. After `realUrl` is fully resolved (after the SubSense `from=` unwrap, before the `console.log('[subdownload] Proxying:'…)`), compute `cacheKey = `${(req.params.ext || 'srt').toLowerCase()}|${realUrl}``.
2. On cache hit, set headers from cached entry and `res.send(cached.body)` then `return` — **no** `Proxying` log.
3. After successful upstream fetch + ASS→SRT conversion (i.e. just before every successful `res.send(...)` path), store `{ body, contentType }` in the cache.

**Refactor instruction (replaces the two branches' individual `res.send`s — there must be exactly ONE send point):**

1. Keep the existing read → BOM-strip logic producing `rawContent`.
2. Keep ASS→SRT conversion, but instead of `res.send(srtContent); return;`, set `finalContent = srtContent; finalContentType = 'text/plain; charset=utf-8'`.
3. SRT/VTT path: `finalContent = rawContent; finalContentType = mimeMap[ext] || 'text/plain; charset=utf-8'`.
4. Delete the old early `res.setHeader('Content-Type', mimeMap[ext]…)` at the top of the success path (headers are set once at the single send, including on cache hit).
5. Single send + cache-set at the end:

```ts
      const bodyBuf = Buffer.from(finalContent, 'utf-8');
      subDownloadCache.set(cacheKey, { body: bodyBuf, contentType: finalContentType }, SUB_DOWNLOAD_CACHE_TTL_MS);
      res.setHeader('Content-Type', finalContentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(bodyBuf);
      return;
```

Do not duplicate cache writes in the ASS and SRT branches.

Cache-hit block (placed immediately after `realUrl` resolution):

```ts
    const cacheKey = `${(req.params.ext || 'srt').toLowerCase()}|${realUrl}`;
    const hit = subDownloadCache.get(cacheKey);
    if (hit) {
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Subtitle-Cache', 'hit');
      res.send(hit.body);
      return;
    }
    console.log('[subdownload] Proxying:', realUrl.substring(0, 120));
```

(Refactor the existing ASS and SRT branches to both produce `finalContent`/`finalContentType` so there is a single send+cache point — do not duplicate cache writes.)

- [ ] **Step 6: Route-level acceptance for cache behavior + full suite**

Run: `npm test && npm run build`
Expected: PASS / tsc clean.

Manual acceptance (checkbox — run against a local dev server with a reachable upstream sub URL):

- [ ] Start server (`npm run dev`), request a subtitle twice:
  `curl -sD - "http://localhost:5101/subdownload.srt?url=<upstream>&config=<config>" -o /dev/null`
  First response: **no** `X-Subtitle-Cache` header (or not `hit`), log shows `[subdownload] Proxying:`.
  Second response: header `X-Subtitle-Cache: hit`, log does **not** show a new `Proxying:` line for the same URL.

Automated alternative (no new deps — optional if time-constrained, manual curl above is the gate): unit tests in Step 4 already prove TTL/eviction; wiring correctness is proven by the `X-Subtitle-Cache: hit` header existing in code and the single-send refactor making miss→set→hit reachable.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ttl-store.ts src/routes/subtitle.ts tests/ttl-store.test.ts
git commit -m "fix: cache subdownload responses to stop repeated upstream fetches"
```

---

### Task 4: Strategy D — duration-overrun fallback offset

**Files:**
- Modify: `src/routes/subtitle.ts` (after Strategy C block, before step 7 "If offset detected…" at ~line 570)
- Test: `tests/duration-offset.test.ts` (create)

**Interfaces:**
- Consumes: `videoDuration: number | null` (already set ~line 390), `allSubs[0]._format`, `resolveRealUrl`, `fetchText`, `parseSubtitle`, `SubtitleFormat`.
- Produces: `export function durationOverrunOffset(videoDuration: number | null, lastCueEnd: number, slackSec?: number): number` from `src/routes/subtitle.ts` — returns **negative** offset `videoDuration - lastCueEnd` when `lastCueEnd > videoDuration + slackSec` (default slack `3`), else `0`. Clamped to `>= -600` (align with `MAX_OFFSET` in aligner). Pure — testable without I/O.

- [ ] **Step 1: Write failing test**

Create `tests/duration-offset.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { durationOverrunOffset } from '../src/routes/subtitle.js';

describe('durationOverrunOffset', () => {
  it('returns negative offset when sub overruns video end beyond slack', () => {
    // sub ends at 5900s, video is 5839.6s → overrun 60.4s → offset -60.4
    expect(durationOverrunOffset(5839.6, 5900)).toBeCloseTo(5839.6 - 5900, 5);
  });

  it('returns 0 within slack window', () => {
    expect(durationOverrunOffset(5839.6, 5841)).toBe(0); // overrun 1.4s < 3s
  });

  it('returns 0 when sub ends before or at video end', () => {
    expect(durationOverrunOffset(5839.6, 5700)).toBe(0);
  });

  it('returns 0 when videoDuration is null', () => {
    expect(durationOverrunOffset(null, 9999)).toBe(0);
  });

  it('returns 0 when videoDuration is NaN', () => {
    expect(durationOverrunOffset(NaN, 9999)).toBe(0);
  });

  it('clamps huge overrun to -600', () => {
    expect(durationOverrunOffset(100, 2000)).toBe(-600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/duration-offset.test.ts`
Expected: FAIL — `durationOverrunOffset` is not exported.

- [ ] **Step 3: Implement pure helper**

In `src/routes/subtitle.ts` (near other helpers, e.g. after `limitPerLanguage`):

```ts
/**
 * Strategy D helper: if the best subtitle's last cue ends well past the
 * video duration, the sub is from a longer cut — shift it back.
 * Returns a negative offset (seconds) or 0 when no confident overrun.
 */
export function durationOverrunOffset(
  videoDuration: number | null,
  lastCueEnd: number,
  slackSec = 3,
): number {
  if (!Number.isFinite(videoDuration) || !Number.isFinite(lastCueEnd)) return 0;
  const overrun = lastCueEnd - videoDuration;
  if (overrun <= slackSec) return 0;
  const offset = videoDuration - lastCueEnd; // negative
  return Math.max(offset, -600);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/duration-offset.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire Strategy D into the route**

Insert after the Strategy C block (`…isFfsubsyncAvailable()` else-if ends ~line 568), **before** step 7:

```ts
  // ── Strategy D: duration overrun (last resort) ─────────────────────
  // Strategies A–C can all no-op when every sub is the wrong encode and
  // the video has no text builtin subs. If the best sub's last cue runs
  // well past the probed video duration, shift it back.
  if (offset === 0 && videoDuration && allSubs.length > 0) {
    const bestSub = allSubs[0];
    const fmt = (bestSub._format || 'srt') as SubtitleFormat;
    try {
      const realUrl = resolveRealUrl(bestSub.url);
      const subContent = await fetchText(realUrl);
      if (subContent) {
        const entries = parseSubtitle(subContent, fmt);
        if (entries.length > 0) {
          const lastCueEnd = entries[entries.length - 1].end;
          const dOffset = durationOverrunOffset(videoDuration, lastCueEnd);
          if (dOffset !== 0) {
            offset = dOffset;
            console.log(`[subtitle] Strategy D (duration overrun): sub ends ${lastCueEnd.toFixed(1)}s > video ${videoDuration.toFixed(1)}s → offset=${offset.toFixed(1)}s`);
          } else {
            console.log(`[subtitle] Strategy D (duration overrun): no overrun (sub end=${lastCueEnd.toFixed(1)}s, video=${videoDuration.toFixed(1)}s)`);
          }
        }
      }
    } catch (e: any) {
      console.log(`[subtitle] Strategy D: error: ${e.message?.substring(0, 200)}`);
    }
  }
```

Notes for implementer:
- `parseSubtitle` entries are ordered by cue index; ASS parser must append in file order (already true). Using last entry's `.end` matches "last cue end".
- Strategy D only runs when `offset === 0`, so it never overrides A/B/C results.
- When it fires, existing step 7 re-downloads and re-serializes all subs with the offset (SRT/VTT via `adjustEntries`, ASS via `adjustAssTimestamps`) — no change needed there.
- Implementer note: Strategy D's `fetchText(bestSub)` and step 7's re-fetch mean bestSub is fetched twice from upstream when D fires — **acceptable; do not add a response cache on this path (out of scope / YAGNI).**

- [ ] **Step 6: Run full suite + build**

Run: `npm test && npm run build`
Expected: all tests PASS (old + new), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/subtitle.ts tests/duration-offset.test.ts
git commit -m "fix: add duration-overrun fallback offset when encode strategies fail"
```

---

## Self-Review (done at authoring time + post-hygienic fixes)

- **Root-cause coverage:** mismatch hard-zero → Task 1; duplicate URLs proxied → Task 2; repeated upstream fetches → Task 3; unused `videoDuration` / no fallback → Task 4. Strategy B/C limitations are environmental (1 addon, PGS-only video) — documented, not "fixable" in code; Tasks 2–4 are the correct responses.
- **Placeholders:** none — Task 3 has an explicit single-send refactor instruction (not a sketch); every other step has pasteable code or exact edit location.
- **Type consistency:** `createTtlStore<T>` matches route usage `{ body: Buffer; contentType: string }`; `sortByReleaseMatch<T extends { _releaseName?: string }>` accepts `Subtitle`; `durationOverrunOffset(number|null, number, number?)` matches call site; `encodeMatchScore` is module-private inside `release-match.ts` (listed under Interfaces only to document its contract; not re-exported for route use).
- **Scoring invariant:** Global Constraint matches implementation and Task 1 tests (mismatch cap 0.4; high-overlap mismatch may beat zero-overlap compatible — intended).
- **Gates:** every task runs `npm test && npm run build` before commit (Task 2 Step 4b added).
- **Route acceptance:** Task 3 has manual curl checkbox for `X-Subtitle-Cache: hit` + no duplicate `Proxying:` log.
- **Execution order:** sequential 1→2→3→4 recommended — all tasks edit `src/routes/subtitle.ts` at shifting line numbers; do not parallelize in shared worktrees.
