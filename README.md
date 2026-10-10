# Stremio Subtitle Alignment Addon

Auto-aligns subtitles with video streams using ffprobe duration detection.

## How it works

1. Configure with your stream and subtitle addon URLs
2. Install the generated manifest URL in Stremio
3. Addon automatically detects video duration and aligns subtitles
4. *(Optional)* Configure a [Lingarr](https://github.com/lingarr-translate/lingarr) instance to auto-translate subs into missing target languages

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
4. *(Optional)* Enter a [Lingarr](https://github.com/lingarr-translate/lingarr) URL + API key, then pick target languages to auto-translate
5. Click "Generate Manifest URL"
6. Copy the URL and install in Stremio

## Translation (Lingarr)

Self-host a [Lingarr](https://github.com/lingarr-translate/lingarr) instance and point the configure page at it. The addon will then:

- Detect which target languages (e.g. `vi`, `ja`) are missing from the upstream sub addons
- Pick the best available source sub (English preferred, then first available)
- Translate it via Lingarr's `/api/translate/content` endpoint
- Stitch the translated lines back onto the source sub's timestamps
- Cache the result (7 days) and serve it as if it were a regular sub

Lingarr is **optional**. Without it, the addon behaves exactly as before. The translation tier adds at most one round-trip per missing target language, and never blocks past the existing 14s request budget.

Per-user config (configure page) wins over environment variables.

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
                           → Lingarr (optional, missing target langs)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5100 | Server port |
| BASE_URL | (auto-detect) | External URL, e.g. `https://my-server.com` — used for manifest transport URL behind reverse proxy |
| LINGARR_URL | (empty) | Default Lingarr base URL (e.g. `http://localhost:9876`). Overridden by per-user config in `/configure`. |
| LINGARR_API_KEY | (empty) | Default Lingarr API key sent as `X-Api-Key`. Overridden by per-user config. Leave empty if Lingarr has authentication disabled. |

## License

MIT
