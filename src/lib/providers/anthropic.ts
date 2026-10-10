/**
 * Anthropic Claude provider.
 *
 * Endpoint: POST /v1/messages
 * Auth: x-api-key header (NOT Bearer)
 * Body: { model, max_tokens, system, messages: [{role, content}] }
 * Response: { content: [{ type: "text", text }], usage: { input_tokens, output_tokens } }
 */

import {
  ProviderOptions, ProviderRequest, TranslationProvider, TranslateResult,
} from './types.js';
import {
  buildChatPrompt, parseChatResponse, readJson, safeFetch,
} from './_helpers.js';

export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';
export const ANTHROPIC_VERSION = '2023-06-01';

export const anthropicProvider: TranslationProvider = {
  name: 'anthropic',
  label: 'Anthropic Claude',
  requiresKey: true,
  defaultBaseUrl: ANTHROPIC_DEFAULT_BASE,

  async translate(opts, req): Promise<TranslateResult> {
    const baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE).replace(/\/+$/, '');
    const url = `${baseUrl}/v1/messages`;
    const model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
    const { system, user } = buildChatPrompt(req);

    const res = await safeFetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: Math.max(1024, req.lines.length * 80),
        system,
        messages: [{ role: 'user', content: user }],
      }),
    }, opts);
    if (!res) return { lines: new Map(), ok: false, reason: 'network error' };
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { lines: new Map(), ok: false, reason: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = await readJson(res);
    if (!json || typeof json !== 'object') {
      return { lines: new Map(), ok: false, reason: 'invalid response' };
    }
    const content = (json as { content?: unknown }).content;
    if (!Array.isArray(content) || content.length === 0) {
      return { lines: new Map(), ok: false, reason: 'no content' };
    }
    const text = (content[0] as { type?: string; text?: unknown }).text;
    if (typeof text !== 'string') {
      return { lines: new Map(), ok: false, reason: 'no text block' };
    }
    const lines = parseChatResponse(text, req.lines.length);
    if (!lines) {
      return { lines: new Map(), ok: false, reason: 'parse failed' };
    }
    const usage = (json as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    return {
      lines,
      ok: true,
      usage: { inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens },
    };
  },
};
