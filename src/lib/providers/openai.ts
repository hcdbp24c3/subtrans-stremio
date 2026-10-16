/**
 * OpenAI-compatible chat-completion provider.
 *
 * Works with: OpenAI, OpenRouter, Mistral, xAI (Grok), LocalAI, Ollama
 * (when configured with /v1/chat/completions), and any other provider that
 * exposes the same /v1/chat/completions endpoint shape.
 *
 * Request body: { model, messages: [{role, content}], temperature }
 * Response: { choices: [{ message: { content } }], usage: { ... } }
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import {
  bearerHeader, buildChatPrompt, parseChatResponse, readJson, safeFetch,
} from './_helpers.js';

export const OPENAI_DEFAULT_BASE = 'https://api.openai.com';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

export const openaiProvider: TranslationProvider = {
  name: 'openai',
  label: 'OpenAI (also OpenRouter, Mistral, xAI, LocalAI, Ollama)',
  requiresKey: true,
  defaultBaseUrl: OPENAI_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/chat/completions`;
    const model = opts.model ?? OPENAI_DEFAULT_MODEL;
    const { system, user } = buildChatPrompt(req);

    // Local servers (Ollama, LocalAI without auth) accept an empty
    // API key. Sending "Authorization: Bearer " with no token causes
    // some servers to reject with 401. Skip the header when no key.
    const authHeader = opts.apiKey ? bearerHeader(opts.apiKey) : {};

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    }, opts);
    if (!res) return { lines: new Map(), ok: false, reason: 'network error' };
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return { lines: new Map(), ok: false, reason: `HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }
    const json = await readJson(res);
    if (!json || typeof json !== 'object') {
      return { lines: new Map(), ok: false, reason: 'invalid response' };
    }
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { lines: new Map(), ok: false, reason: 'no choices' };
    }
    const content = (choices[0] as { message?: { content?: unknown } }).message?.content;
    if (typeof content !== 'string') {
      return { lines: new Map(), ok: false, reason: 'no content' };
    }
    const lines = parseChatResponse(content, req.lines.length);
    if (!lines) {
      return { lines: new Map(), ok: false, reason: 'parse failed' };
    }
    const usage = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    return {
      lines,
      ok: true,
      usage: {
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
      },
    };
  },
};
