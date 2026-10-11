/**
 * Translation providers.
 *
 * Unified interface for any text translation API. The pipeline calls one
 * provider per request; orchestrator code stays the same regardless of
 * which provider is configured.
 *
 * Two flavours:
 * - chat-completion (OpenAI, Anthropic, Gemini, Mistral, xAI, OpenRouter,
 *   LocalAI, Ollama): provider formats a prompt asking the model to
 *   translate one line at a time. Cheap with batched calls.
 * - dedicated-translation (DeepL, Google v2): purpose-built API with
 *   structured request/response, no prompt needed. Better quality but
 *   often pricier or rate-limited.
 *
 * Every provider:
 *   translate(opts, request) → Promise<TranslateResult>
 *   - never throws; returns { ok: false, reason } on any failure
 *   - honors opts.signal / opts.timeoutMs for caller-side cancellation
 */

import { SubtitleEntry } from '../subtitle-parser.js';

export interface ProviderRequest {
  /** Source language, ISO 639-1 (e.g. "en"). */
  sourceLanguage: string;
  /** Target language, ISO 639-1. */
  targetLanguage: string;
  /** Lines to translate, in source order. */
  lines: SubtitleEntry[];
}

export interface TranslateResult {
  /** position (1-based) → translated line. */
  lines: Map<number, string>;
  /** True when provider returned at least one translated line. */
  ok: boolean;
  /** Human-readable failure reason when ok=false. */
  reason?: string;
  /** Provider-reported usage, for diagnostics. */
  usage?: { inputTokens?: number; outputTokens?: number; characters?: number };
}

export interface ProviderOptions {
  /** API key (env-injected by the orchestrator). */
  apiKey: string;
  /** Optional self-host / proxy base URL. */
  baseUrl?: string;
  /** Model name (provider-specific). */
  model?: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

export interface TranslationProvider {
  /** Stable identifier (used in config + logs). */
  readonly name: string;
  /** Display label for the configure UI. */
  readonly label: string;
  /** Whether this provider requires an API key. */
  readonly requiresKey: boolean;
  /** Default base URL. Empty = use provider's own endpoint. */
  readonly defaultBaseUrl: string;
  /**
   * Run the translation. MUST NOT throw — return { ok: false, reason } on
   * any failure (network, auth, rate limit, malformed response).
   */
  translate(opts: ProviderOptions, request: ProviderRequest): Promise<TranslateResult>;
}

/** Stitch translated lines back onto source sub timestamps. */
export function stitchEntries(
  entries: SubtitleEntry[],
  translated: Map<number, string>,
): SubtitleEntry[] {
  return entries.map((e, i) => {
    const line = translated.get(i + 1);
    return { start: e.start, end: e.end, text: line ?? e.text };
  });
}
