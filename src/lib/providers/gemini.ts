/**
 * Google Gemini provider (OpenAI-compatible mode).
 *
 * Endpoint: POST /v1beta/openai/chat/completions
 * Works with the OpenAI Chat Completions schema. Auth: Bearer API key
 * (from Google AI Studio: https://aistudio.google.com/apikey).
 *
 * Default model: gemini-2.0-flash (cheap, fast). For higher quality,
 * override via config.translateModel (e.g. "gemini-2.5-pro").
 *
 * Note: Google also offers a native Gemini SDK with different request
 * shape. We use OpenAI-compat mode for two reasons: (1) one less SDK
 * dependency, (2) request shape stays identical to OpenAI, so retries
 * and prompt templates are shared.
 */

import { openaiProvider } from './openai.js';
import { TranslationProvider } from './types.js';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';

export const geminiProvider: TranslationProvider = {
  name: 'gemini',
  label: 'Google Gemini',
  requiresKey: true,
  defaultBaseUrl: GEMINI_DEFAULT_BASE,

  async translate(opts, req) {
    // Reuse the OpenAI provider — same wire format, same parsing.
    // The Gemini OpenAI-compat endpoint accepts Bearer auth, same as OpenAI.
    return openaiProvider.translate(
      {
        ...opts,
        baseUrl: opts.baseUrl ?? GEMINI_DEFAULT_BASE,
        model: opts.model ?? GEMINI_DEFAULT_MODEL,
      },
      req,
    );
  },
};
