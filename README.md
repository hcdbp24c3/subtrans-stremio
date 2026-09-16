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
