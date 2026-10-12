# Stremio Subtitle Alignment Addon

Auto-aligns subtitles with video streams using ffprobe duration detection.

## How it works

1. Configure with your stream and subtitle addon URLs
2. Install the generated manifest URL in Stremio
3. Addon automatically detects video duration and aligns subtitles
4. *(Optional)* Configure a translation provider to auto-translate subs into missing target languages

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
4. *(Optional)* Pick a translation provider + API key + target languages
5. Click "Generate Manifest URL"
6. Copy the URL and install in Stremio

## Translation (optional)

The addon can fill missing target languages by translating the best source sub via a provider. Pick one in `/configure`:

**Free / cheap:**
- **Google Translate** — 500K chars/month free, [get API key](https://console.cloud.google.com/apis/credentials)
- **DeepL** — 500K chars/month free with `:fx` key (auto-detected), high quality for European langs
- **LibreTranslate** — open-source, self-hostable, free (public instances often rate-limited)
- **Ollama** — local LLM, free, runs on your hardware (`http://localhost:11434`)

**LLM providers (paid):**
- **OpenAI** — `gpt-4o-mini` default
- **Anthropic** — `claude-haiku-4-5` default
- **Google Gemini** — `gemini-2.0-flash` default
- **Mistral AI** — `mistral-small-latest` default
- **xAI (Grok)** — `grok-2-latest` default
- **OpenRouter** — multi-model proxy, requires user-specified model

**Paid / legacy:**
- **Microsoft Bing Translator** — requires Azure subscription
- **Yandex Translate** — requires Yandex Cloud subscription

Self-hosted OpenAI-compatible servers (LocalAI, Ollama, vLLM, LM Studio) all work via the **Base URL** field with the OpenAI / Mistral / xAI / OpenRouter / Ollama / Gemini provider entry.

The pipeline:

- Detects which target languages (e.g. `vi`, `ja`) are missing from the upstream sub addons
- Picks the best available source sub (English first, then first available)
- Translates it via the configured provider
- Stitches the translated lines back onto the source sub's timestamps
- Caches the result (7 days per source+target+provider) and serves it as if it were a regular sub

Translation is **optional**. Without it, the addon behaves exactly as before. The translation tier adds at most one round-trip per missing target language, and never blocks past the existing 14s request budget. **Sub source is always the upstream sub addon** — install a sub addon (OpenSubtitles, Stremio Community Subs, etc.) in `/configure` to enable translation. If no sub addon is configured, the addon returns an empty subtitle list.

Per-user config (configure page) wins over environment variables.

## Supported Formats

- SRT (.srt)
- WebVTT (.vtt)
- ASS/SSA (.ass, .ssa)

## Architecture

```
Stremio → Alignment Addon → Stream Addon (proxy)
                           → Sub Addon (proxy)
                           → ffprobe (video duration + text sub streams)
                           → Sub Parser (SRT/VTT/ASS)
                           → Aligner (auto offset)
                           → ffmpeg (extract built-in text sub, background)
                           → Translation provider (optional, missing target langs)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 5100 | Server port |
| BASE_URL | (auto-detect) | External URL, e.g. `https://my-server.com` — used for manifest transport URL behind reverse proxy |
| TRANSLATE_PROVIDER | (empty) | Default provider: `google` \| `deepl` \| `libretranslate` \| `ollama` \| `openai` \| `anthropic` \| `gemini` \| `mistral` \| `xai` \| `openrouter` \| `bing` \| `yandex`. Overridden by per-user config. |
| TRANSLATE_KEY | (empty) | Generic API key fallback. Overridden by per-user config. |
| TRANSLATE_GOOGLE_KEY | (empty) | Provider-specific fallback for Google. |
| TRANSLATE_DEEPL_KEY | (empty) | Provider-specific fallback for DeepL. |
| TRANSLATE_OPENAI_KEY | (empty) | Provider-specific fallback for OpenAI. |
| TRANSLATE_ANTHROPIC_KEY | (empty) | Provider-specific fallback for Anthropic. |
| TRANSLATE_BASE_URL | (empty) | Default base URL override (for self-hosted OpenAI-compat). |
| TRANSLATE_MODEL | (empty) | Default model name override. |

## License

MIT
