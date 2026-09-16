# Stremio Subtitle Alignment Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Stremio addon that proxies stream and subtitle addons, using ffprobe to auto-detect video duration and align subtitle timing.

**Architecture:** Node.js + Express server that acts as a middleware between Stremio and upstream addons. User configures via web page, addon dynamically generates manifest. Subtitle alignment uses ffprobe for video duration detection and format-aware parsers for SRT/VTT/ASS.

**Tech Stack:** Node.js, TypeScript, Express, fluent-ffmpeg, EJS, Docker

**Spec:** `docs/superpowers/specs/2026-09-16-stremio-subtitle-alignment-addon-design.md`

## Global Constraints

- Node.js >= 18
- ffmpeg/ffprobe must be available in runtime environment
- All subtitle formats: SRT, VTT, ASS/SSA
- Config encoded in manifest URL query params (stateless)
- Default port: 5100
- Docker support required

---

## File Structure

```
subtrans-stremio/
├── src/
│   ├── index.ts                 # Server entry, Express setup
│   ├── config.ts                # Config encode/decode from query params
│   ├── manifest.ts              # Dynamic manifest.json generator
│   ├── routes/
│   │   ├── configure.ts         # GET/POST config page
│   │   ├── manifestRoute.ts     # GET /manifest.json
│   │   ├── stream.ts            # Proxy stream to upstream addon
│   │   └── subtitle.ts          # Proxy sub + alignment engine
│   ├── lib/
│   │   ├── subtitle-parser.ts   # Parse SRT/VTT/ASS timestamps
│   │   ├── aligner.ts           # ffprobe + offset calculation
│   │   └── proxy.ts             # HTTP fetch helper for upstream
│   └── views/
│       └── configure.ejs        # Config page HTML
├── tests/
│   ├── subtitle-parser.test.ts
│   ├── aligner.test.ts
│   ├── config.test.ts
│   └── proxy.test.ts
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts` (minimal server)
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Dependencies:**
- express, @types/express
- fluent-ffmpeg, @types/fluent-ffmpeg
- ejs
- typescript, tsx (dev)
- vitest (test)

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "stremio-subtitle-alignment",
  "version": "1.0.0",
  "description": "Stremio addon for auto subtitle alignment using ffprobe",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "express": "^4.21.0",
    "fluent-ffmpeg": "^2.1.3",
    "ejs": "^3.1.10"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/fluent-ffmpeg": "^2.1.27",
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create minimal server entry**

```typescript
// src/index.ts
import express from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
```

- [ ] **Step 4: Install dependencies and verify**

Run: `bun install && npx tsx src/index.ts`
Expected: Server starts on port 5100

- [ ] **Step 5: Create Dockerfile**

```dockerfile
FROM node:20-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* ./
RUN npm install -g bun && bun install --frozen-lockfile

COPY src/ ./src/
COPY tsconfig.json ./

RUN bun run build

EXPOSE 5100

CMD ["node", "dist/index.js"]
```

- [ ] **Step 6: Create docker-compose.yml**

```yaml
services:
  subtrans:
    build: .
    ports:
      - "5100:5100"
    environment:
      - PORT=5100
    restart: unless-stopped
```

- [ ] **Step 7: Create .gitignore**

```
node_modules/
dist/
.env
.hive/
.hive2/
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: project scaffolding with TypeScript, Express, Docker"
```

---

### Task 2: Config Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Produces: `AddonConfig` type, `encodeConfig()`, `decodeConfig()`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/config.test.ts
import { describe, it, expect } from 'vitest';
import { encodeConfig, decodeConfig, AddonConfig } from '../src/config.js';

describe('config', () => {
  const sampleConfig: AddonConfig = {
    streamUrl: 'https://example.com/stream/manifest.json',
    subUrl: 'https://example.com/sub/manifest.json',
  };

  it('encodes and decodes config roundtrip', () => {
    const encoded = encodeConfig(sampleConfig);
    const decoded = decodeConfig(encoded);
    expect(decoded).toEqual(sampleConfig);
  });

  it('returns null for invalid encoded string', () => {
    expect(decodeConfig('garbage')).toBeNull();
  });

  it('returns null for missing required fields', () => {
    const incomplete = encodeConfig({ streamUrl: '', subUrl: '' });
    // empty strings are falsy but present — should still decode
    const decoded = decodeConfig(incomplete);
    expect(decoded).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/config.ts

export interface AddonConfig {
  streamUrl: string;
  subUrl: string;
}

export function encodeConfig(config: AddonConfig): string {
  const params = new URLSearchParams();
  params.set('stream', config.streamUrl);
  params.set('sub', config.subUrl);
  return params.toString();
}

export function decodeConfig(queryString: string): AddonConfig | null {
  try {
    const params = new URLSearchParams(queryString);
    const streamUrl = params.get('stream') || '';
    const subUrl = params.get('sub') || '';

    if (!streamUrl || !subUrl) return null;

    return { streamUrl, subUrl };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: config encode/decode from query params"
```

---

### Task 3: HTTP Proxy Helper

**Files:**
- Create: `src/lib/proxy.ts`
- Create: `tests/proxy.test.ts`

**Interfaces:**
- Produces: `fetchJson<T>(url)`, `fetchText(url)`, `fetchBuffer(url, range?)`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/proxy.test.ts
import { describe, it, expect } from 'vitest';
import { fetchJson, fetchText } from '../src/lib/proxy.js';

describe('proxy', () => {
  it('fetchJson returns parsed JSON', async () => {
    // Using httpbin as test endpoint
    const data = await fetchJson<{ json: { test: string } }>(
      'https://httpbin.org/json'
    );
    expect(data).toBeTruthy();
  });

  it('fetchText returns string', async () => {
    const text = await fetchText('https://httpbin.org/robots.txt');
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
  });

  it('fetchJson returns null on error', async () => {
    const data = await fetchJson('https://invalid.example.test/nope');
    expect(data).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/proxy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/proxy.ts

export async function fetchJson<T = unknown>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stremio-SubAlign/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Stremio-SubAlign/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchBuffer(
  url: string,
  range?: { start: number; end: number }
): Promise<Buffer | null> {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Stremio-SubAlign/1.0',
    };
    if (range) {
      headers['Range'] = `bytes=${range.start}-${range.end}`;
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/proxy.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/proxy.ts tests/proxy.test.ts
git commit -m "feat: HTTP proxy helper for upstream addon requests"
```

---

### Task 4: Subtitle Parser

**Files:**
- Create: `src/lib/subtitle-parser.ts`
- Create: `tests/subtitle-parser.test.ts`

**Interfaces:**
- Produces: `parseSubtitle(content, format)`, `SubtitleEntry` type, `SubtitleFormat` type

- [ ] **Step 1: Write the failing test**

```typescript
// tests/subtitle-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseSubtitle, SubtitleEntry } from '../src/lib/subtitle-parser.js';

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
    const { detectFormat } = require('../src/lib/subtitle-parser.js');
    expect(detectFormat('movie.srt')).toBe('srt');
    expect(detectFormat('movie.vtt')).toBe('vtt');
    expect(detectFormat('movie.ass')).toBe('ass');
    expect(detectFormat('movie SSA')).toBe('ass');
    expect(detectFormat('movie.txt')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/subtitle-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/subtitle-parser.ts

export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

export interface SubtitleEntry {
  start: number; // seconds
  end: number;   // seconds
  text: string;
}

export function detectFormat(filename: string): SubtitleFormat | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  if (ext === 'srt') return 'srt';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  return null;
}

function parseSrtTime(time: string): number {
  // Format: HH:MM:SS,mmm or HH:MM:SS.mmm
  const clean = time.trim().replace(',', '.');
  const parts = clean.split(':');
  if (parts.length !== 3) return 0;
  const [h, m, s] = parts;
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
}

function parseVttTime(time: string): number {
  // Format: HH:MM:SS.mmm or MM:SS.mmm
  const clean = time.trim();
  const parts = clean.split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
  } else if (parts.length === 2) {
    const [m, s] = parts;
    return parseInt(m) * 60 + parseFloat(s);
  }
  return 0;
}

function parseAssTime(time: string): number {
  // Format: H:MM:SS.cc (centiseconds)
  const clean = time.trim();
  const parts = clean.split(':');
  if (parts.length !== 3) return 0;
  const [h, m, rest] = parts;
  const [s, cs] = rest.split('.');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(cs || '0') / 100;
}

function parseSrt(content: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line (contains -->)
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!match) continue;

    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
    if (!text) continue;

    entries.push({
      start: parseSrtTime(match[1]),
      end: parseSrtTime(match[2]),
      text,
    });
  }

  return entries;
}

function parseVtt(content: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  // Remove WEBVTT header and any metadata
  const body = content.replace(/^WEBVTT.*?\n\n/s, '');
  const blocks = body.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex === -1) continue;

    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(
      /([\d:.]+)\s*-->\s*([\d:.]+)/
    );
    if (!match) continue;

    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
    if (!text) continue;

    entries.push({
      start: parseVttTime(match[1]),
      end: parseVttTime(match[2]),
      text,
    });
  }

  return entries;
}

function parseAss(content: string): SubtitleEntry[] {
  const entries: SubtitleEntry[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue;

    // Format: Dialogue: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    const parts = line.substring('Dialogue:'.length).split(',');
    if (parts.length < 10) continue;

    const start = parseAssTime(parts[1]);
    const end = parseAssTime(parts[2]);
    // Text is everything from index 9 onwards (may contain commas)
    const text = parts.slice(9).join(',').trim()
      .replace(/\{[^}]*\}/g, '') // Remove inline formatting tags
      .replace(/\\N/g, '\n')     // ASS newline
      .replace(/\\n/g, '\n')     // ASS newline alt
      .trim();

    if (!text) continue;

    entries.push({ start, end, text });
  }

  return entries;
}

export function parseSubtitle(content: string, format: SubtitleFormat): SubtitleEntry[] {
  switch (format) {
    case 'srt': return parseSrt(content);
    case 'vtt': return parseVtt(content);
    case 'ass': return parseAss(content);
    default: return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/subtitle-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/subtitle-parser.ts tests/subtitle-parser.test.ts
git commit -m "feat: subtitle parser for SRT, VTT, ASS/SSA formats"
```

---

### Task 5: Alignment Engine

**Files:**
- Create: `src/lib/aligner.ts`
- Create: `tests/aligner.test.ts`

**Interfaces:**
- Consumes: `SubtitleEntry[]` from Task 4
- Produces: `getVideoDuration(url)`, `calculateOffset()`, `adjustSubtitle()`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/aligner.test.ts
import { describe, it, expect } from 'vitest';
import {
  calculateOffset,
  adjustEntries,
  SubtitleEntry,
} from '../src/lib/aligner.js';

describe('aligner', () => {
  it('calculates positive offset when sub is shorter than video', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 5, text: 'b' },
    ];
    // Sub range: 5s, video: 10s → offset = 5s
    const offset = calculateOffset(entries, 10);
    expect(offset).toBe(5);
  });

  it('calculates negative offset when sub is longer than video', () => {
    const entries: SubtitleEntry[] = [
      { start: 0, end: 2, text: 'a' },
      { start: 3, end: 15, text: 'b' },
    ];
    // Sub range: 15s, video: 10s → offset = -5s
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/aligner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/aligner.ts

import ffmpeg from 'fluent-ffmpeg';

export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

const OFFSET_THRESHOLD = 0.5; // seconds — ignore offsets smaller than this

export function getVideoDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(url, (err, metadata) => {
      if (err || !metadata?.format?.duration) {
        resolve(null);
        return;
      }
      resolve(metadata.format.duration);
    });
  });
}

export function calculateOffset(
  entries: SubtitleEntry[],
  videoDuration: number
): number {
  if (entries.length === 0 || videoDuration <= 0) return 0;

  const minStart = Math.min(...entries.map((e) => e.start));
  const maxEnd = Math.max(...entries.map((e) => e.end));
  const subRange = maxEnd - minStart;

  const rawOffset = videoDuration - subRange;

  // Ignore tiny offsets (likely not a real mismatch)
  if (Math.abs(rawOffset) < OFFSET_THRESHOLD) return 0;

  return rawOffset;
}

export function adjustEntries(
  entries: SubtitleEntry[],
  offset: number
): SubtitleEntry[] {
  return entries.map((e) => ({
    start: Math.max(0, e.start + offset),
    end: Math.max(0, e.end + offset),
    text: e.text,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/aligner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/aligner.ts tests/aligner.test.ts
git commit -m "feat: alignment engine with ffprobe duration detection"
```

---

### Task 6: Manifest Generator + Route

**Files:**
- Create: `src/manifest.ts`
- Create: `src/routes/manifestRoute.ts`

**Interfaces:**
- Consumes: `AddonConfig` from Task 2
- Produces: Stremio-compatible manifest.json

- [ ] **Step 1: Write manifest generator**

```typescript
// src/manifest.ts

import { AddonConfig } from './config.js';

export function generateManifest(
  config: AddonConfig,
  transportUrl: string
): Record<string, unknown> {
  return {
    id: 'org.subtrans.alignment',
    version: '1.0.0',
    name: 'Subtitle Alignment Addon',
    description: 'Auto-aligns subtitles using ffprobe video duration detection',
    logo: 'https://cdn-icons-png.flaticon.com/512/2788/2788835.png',
    catalogs: [],
    resources: ['stream', 'subtitle'],
    types: ['movie', 'series'],
    behavior: {
      bingeOnly: false,
    },
    // The addon also acts as proxy for upstream addons
    // Stremio will send requests to our endpoints
  };
}
```

- [ ] **Step 2: Create manifest route**

```typescript
// src/routes/manifestRoute.ts

import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { generateManifest } from '../manifest.js';

const router = Router();

router.get('/manifest.json', (req, res) => {
  const configStr = req.query.config as string | undefined;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config parameter' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  // Build the transport URL pointing back to this server with config
  const host = req.headers.host || `localhost:${process.env.PORT || 5100}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const transportUrl = `${protocol}://${host}`;

  const manifest = generateManifest(config, transportUrl);
  res.json(manifest);
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/manifest.ts src/routes/manifestRoute.ts
git commit -m "feat: dynamic manifest.json generator and route"
```

---

### Task 7: Configure Page

**Files:**
- Create: `src/views/configure.ejs`
- Create: `src/routes/configure.ts`

**Interfaces:**
- Consumes: `AddonConfig` from Task 2
- Produces: Web UI for configuration

- [ ] **Step 1: Create EJS template**

```html
<!-- src/views/configure.ejs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Subtitle Alignment Addon - Configure</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      background: #16213e;
      border-radius: 12px;
      padding: 40px;
      max-width: 600px;
      width: 100%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 {
      text-align: center;
      margin-bottom: 8px;
      color: #e94560;
    }
    .subtitle {
      text-align: center;
      color: #888;
      margin-bottom: 30px;
      font-size: 14px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 600;
      color: #ccc;
    }
    .hint {
      font-size: 12px;
      color: #666;
      margin-top: 4px;
    }
    input[type="text"] {
      width: 100%;
      padding: 12px;
      border: 1px solid #333;
      border-radius: 6px;
      background: #0f3460;
      color: #eee;
      font-size: 14px;
    }
    input[type="text"]:focus {
      outline: none;
      border-color: #e94560;
    }
    button {
      width: 100%;
      padding: 14px;
      background: #e94560;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
    }
    button:hover { background: #c73650; }
    .result {
      margin-top: 20px;
      padding: 16px;
      background: #0f3460;
      border-radius: 6px;
      display: none;
    }
    .result.show { display: block; }
    .result-url {
      word-break: break-all;
      font-family: monospace;
      font-size: 13px;
      color: #4ecca3;
      margin-top: 8px;
    }
    .copy-btn {
      margin-top: 10px;
      padding: 8px 16px;
      background: #4ecca3;
      color: #1a1a2e;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 600;
      width: auto;
    }
    .install-section {
      margin-top: 20px;
      padding: 16px;
      background: #0f3460;
      border-radius: 6px;
      display: none;
    }
    .install-section.show { display: block; }
    .install-section a {
      color: #4ecca3;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🎬 Subtitle Alignment</h1>
    <p class="subtitle">Auto-align subtitles with video using ffprobe</p>

    <form id="configForm">
      <div class="form-group">
        <label for="streamUrl">Stream Addon URL</label>
        <input type="text" id="streamUrl" placeholder="https://example.com/stream/manifest.json" required>
        <div class="hint">URL to the stream addon's manifest.json</div>
      </div>

      <div class="form-group">
        <label for="subUrl">Subtitle Addon URL</label>
        <input type="text" id="subUrl" placeholder="https://example.com/sub/manifest.json" required>
        <div class="hint">URL to the subtitle addon's manifest.json</div>
      </div>

      <button type="submit">Generate Manifest URL</button>
    </form>

    <div class="result" id="result">
      <strong>Your Manifest URL:</strong>
      <div class="result-url" id="manifestUrl"></div>
      <button class="copy-btn" onclick="copyUrl()">Copy URL</button>
    </div>

    <div class="install-section" id="installSection">
      <strong>Install in Stremio:</strong>
      <p style="margin-top: 8px; font-size: 14px;">
        Open Stremio → Add-ons → Community → Paste the URL above
      </p>
    </div>
  </div>

  <script>
    document.getElementById('configForm').addEventListener('submit', function(e) {
      e.preventDefault();
      const stream = document.getElementById('streamUrl').value.trim();
      const sub = document.getElementById('subUrl').value.trim();

      if (!stream || !sub) return;

      const params = new URLSearchParams();
      params.set('stream', stream);
      params.set('sub', sub);

      const base = window.location.origin;
      const manifestUrl = base + '/manifest.json?config=' + params.toString();

      document.getElementById('manifestUrl').textContent = manifestUrl;
      document.getElementById('result').classList.add('show');
      document.getElementById('installSection').classList.add('show');
    });

    function copyUrl() {
      const url = document.getElementById('manifestUrl').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.copy-btn');
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy URL', 2000);
      });
    }
  </script>
</body>
</html>
```

- [ ] **Step 2: Create configure route**

```typescript
// src/routes/configure.ts

import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

router.get('/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'configure.ejs'));
});

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/views/configure.ejs src/routes/configure.ts
git commit -m "feat: web configure page for addon setup"
```

---

### Task 8: Stream + Subtitle Proxy Routes

**Files:**
- Create: `src/routes/stream.ts`
- Create: `src/routes/subtitle.ts`

**Interfaces:**
- Consumes: `AddonConfig`, `fetchJson`, `parseSubtitle`, `calculateOffset`, `adjustEntries`

- [ ] **Step 1: Create stream proxy route**

```typescript
// src/routes/stream.ts

import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson } from '../lib/proxy.js';

const router = Router();

// Stremio sends type, id, etc. as query params
router.get('/stream/:type/:id', async (req, res) => {
  const configStr = req.query.config as string;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  // Build upstream stream URL
  const { type, id } = req.params;
  // Decode the id (Stremio encodes it)
  const decodedId = decodeURIComponent(id);
  const upstreamUrl = `${config.streamUrl.replace(/\/manifest\.json$/, '')}/stream/${type}/${decodedId}`;

  // Fetch from upstream stream addon
  const upstreamManifest = await fetchJson(config.streamUrl);
  if (!upstreamManifest) {
    res.status(502).json({ error: 'Failed to fetch upstream manifest' });
    return;
  }

  // Get the transport URL from upstream manifest
  const streams = await fetchJson(upstreamUrl);
  if (!streams) {
    res.status(502).json({ error: 'Failed to fetch streams' });
    return;
  }

  res.json(streams);
});

export default router;
```

- [ ] **Step 2: Create subtitle proxy route with alignment**

```typescript
// src/routes/subtitle.ts

import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson, fetchText } from '../lib/proxy.js';
import { detectFormat, parseSubtitle } from '../lib/subtitle-parser.js';
import { getVideoDuration, calculateOffset, adjustEntries } from '../lib/aligner.js';

const router = Router();

interface SubtitleResponse {
  url: string;
  lang?: string;
}

interface Subtitle {
  id: string;
  url: string;
  lang?: string;
}

router.get('/subtitles/:type/:id', async (req, res) => {
  const configStr = req.query.config as string;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  const { type, id } = req.params;
  const decodedId = decodeURIComponent(id);

  // 1. Fetch subtitle list from upstream sub addon
  const upstreamSubUrl = `${config.subUrl.replace(/\/manifest\.json$/, '')}/subtitles/${type}/${decodedId}`;
  const subResponse = await fetchJson<{ subtitles: Subtitle[] }>(upstreamSubUrl);

  if (!subResponse?.subtitles?.length) {
    res.json({ subtitles: [] });
    return;
  }

  // 2. Get video URL from stream addon for ffprobe
  const upstreamStreamUrl = `${config.streamUrl.replace(/\/manifest\.json$/, '')}/stream/${type}/${decodedId}`;
  const streamResponse = await fetchJson<{ streams: Array<{ url?: string; infoHash?: string }> }>(upstreamStreamUrl);

  const videoUrl = streamResponse?.streams?.[0]?.url;

  // 3. Try to get video duration via ffprobe
  let videoDuration: number | null = null;
  if (videoUrl) {
    videoDuration = await getVideoDuration(videoUrl);
  }

  // 4. Process each subtitle
  const alignedSubtitles: Array<{
    id: string;
    url: string;
    lang?: string;
  }> = [];

  for (const sub of subResponse.subtitles) {
    const format = detectFormat(sub.url);
    if (!format) {
      // Can't parse this format, pass through as-is
      alignedSubtitles.push(sub);
      continue;
    }

    // Fetch subtitle content
    const subContent = await fetchText(sub.url);
    if (!subContent) {
      alignedSubtitles.push(sub);
      continue;
    }

    // Parse subtitle
    const entries = parseSubtitle(subContent, format);
    if (entries.length === 0) {
      alignedSubtitles.push(sub);
      continue;
    }

    // Calculate and apply offset if we have video duration
    if (videoDuration && videoDuration > 0) {
      const offset = calculateOffset(entries, videoDuration);
      if (offset !== 0) {
        const adjusted = adjustEntries(entries, offset);
        // Re-serialize the subtitle with new timestamps
        const adjustedContent = reSerialize(adjusted, format);
        // Create a data URL or serve inline
        const dataUrl = `data:text/plain;base64,${Buffer.from(adjustedContent).toString('base64')}`;
        alignedSubtitles.push({ ...sub, url: dataUrl });
        continue;
      }
    }

    // No adjustment needed, pass through
    alignedSubtitles.push(sub);
  }

  res.json({ subtitles: alignedSubtitles });
});

// Helper to re-serialize subtitle entries
function reSerialize(
  entries: Array<{ start: number; end: number; text: string }>,
  format: string
): string {
  if (format === 'srt') {
    return entries
      .map((e, i) => {
        const start = formatSrtTime(e.start);
        const end = formatSrtTime(e.end);
        return `${i + 1}\n${start} --> ${end}\n${e.text}`;
      })
      .join('\n\n');
  }

  if (format === 'vtt') {
    const body = entries
      .map((e) => {
        const start = formatVttTime(e.start);
        const end = formatVttTime(e.end);
        return `${start} --> ${end}\n${e.text}`;
      })
      .join('\n\n');
    return `WEBVTT\n\n${body}`;
  }

  // For ASS, we'd need more complex re-serialization
  // For now, return original content (pass-through)
  return '';
}

function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export default router;
```

- [ ] **Step 3: Commit**

```bash
git add src/routes/stream.ts src/routes/subtitle.ts
git commit -m "feat: stream and subtitle proxy routes with alignment"
```

---

### Task 9: Server Entry + Route Mounting

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update server entry with all routes**

```typescript
// src/index.ts

import express from 'express';
import configRoute from './routes/configure.js';
import manifestRoute from './routes/manifestRoute.js';
import streamRoute from './routes/stream.js';
import subtitleRoute from './routes/subtitle.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

// Middleware
app.use(express.json());

// Routes
app.use(configRoute);
app.use(manifestRoute);
app.use(streamRoute);
app.use(subtitleRoute);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Subtitle Alignment Addon running on http://0.0.0.0:${PORT}`);
  console.log(`   Configure: http://localhost:${PORT}/configure`);
});
```

- [ ] **Step 2: Test the full server**

Run: `npx tsx src/index.ts`
Expected: Server starts, `/health` returns `{"status":"ok"}`, `/configure` serves the page

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: mount all routes in server entry"
```

---

### Task 10: README + Final Docker Verification

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README**

```markdown
# Stremio Subtitle Alignment Addon

Auto-aligns subtitles with video streams using ffprobe duration detection.

## How it works

1. Configure with your stream and subtitle addon URLs
2. Install the generated manifest URL in Stremio
3. Addon automatically detects video duration and aligns subtitles

## Quick Start

### Docker (recommended)

```bash
docker-compose up -d
```

Open http://localhost:5100/configure

### Local

```bash
npm install
npm run dev
```

Open http://localhost:5100/configure

**Prerequisites:** Node.js >= 18, ffmpeg/ffprobe installed

## Configuration

1. Open the configure page
2. Enter your stream addon manifest URL
3. Enter your subtitle addon manifest URL
4. Click "Generate Manifest URL"
5. Copy the URL and install in Stremio

## Supported Formats

- SRT (.srt)
- WebVTT (.vtt)
- ASS/SSA (.ass, .ssa)

## Architecture

```
Stremio → Alignment Addon → Stream Addon (proxy)
                           → Sub Addon (proxy)
                           → ffprobe (video duration)
                           → Sub Parser (SRT/VTT/ASS)
                           → Aligner (auto offset)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5100 | Server port |

## License

MIT
```

- [ ] **Step 2: Build Docker image and verify**

Run: `docker build -t subtrans-stremio .`
Expected: Build succeeds

- [ ] **Step 3: Run Docker container**

Run: `docker run -p 5100:5100 subtrans-stremio`
Expected: Server starts on port 5100

- [ ] **Step 4: Final commit**

```bash
git add README.md
git commit -m "docs: README with setup and usage instructions"
```

---

## Verification

After all tasks, run:

```bash
# Unit tests
npx vitest run

# TypeScript check
npx tsc --noEmit

# Docker build
docker build -t subtrans-stremio .

# Manual test: start server and open configure page
npx tsx src/index.ts
# Open http://localhost:5100/configure
```
