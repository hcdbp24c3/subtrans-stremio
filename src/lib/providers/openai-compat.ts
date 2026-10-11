/**
 * Generic OpenAI-compatible provider.
 *
 * Used by: Mistral AI, xAI (Grok), OpenRouter, Ollama, LocalAI, vLLM,
 * LM Studio, and any other server that exposes /v1/chat/completions
 * with the OpenAI Chat Completions schema.
 *
 * The user picks the provider name from /configure and sets the
 * provider-specific base URL. Model is optional (provider default if
 * blank).
 */

import { openaiProvider, OPENAI_DEFAULT_MODEL } from './openai.js';
import { TranslationProvider } from './types.js';

interface OpenAICompatConfig {
  name: string;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

function makeCompatProvider(cfg: OpenAICompatConfig): TranslationProvider {
  return {
    name: cfg.name,
    label: cfg.label,
    requiresKey: true,
    defaultBaseUrl: cfg.defaultBaseUrl,
    async translate(opts, req) {
      // Reuse the OpenAI provider's translate() — same shape, auth, parsing.
      // If the user gave a custom baseUrl via config or env, pass it through.
      return openaiProvider.translate(
        {
          ...opts,
          baseUrl: opts.baseUrl ?? cfg.defaultBaseUrl,
          model: opts.model ?? cfg.defaultModel,
        },
        req,
      );
    },
  };
}

export const mistralProvider = makeCompatProvider({
  name: 'mistral',
  label: 'Mistral AI',
  defaultBaseUrl: 'https://api.mistral.ai',
  defaultModel: 'mistral-small-latest',
});

export const xaiProvider = makeCompatProvider({
  name: 'xai',
  label: 'xAI (Grok)',
  defaultBaseUrl: 'https://api.x.ai',
  defaultModel: 'grok-2-latest',
});

export const openrouterProvider = makeCompatProvider({
  name: 'openrouter',
  label: 'OpenRouter',
  defaultBaseUrl: 'https://openrouter.ai',
  // OpenRouter requires a model name; we leave a sensible default but
  // the user should override via config.translateModel.
  defaultModel: 'anthropic/claude-3.5-haiku',
});

export const ollamaProvider = makeCompatProvider({
  name: 'ollama',
  label: 'Ollama (local)',
  defaultBaseUrl: 'http://localhost:11434',
  // Ollama has no default model. User must set config.translateModel.
  defaultModel: '',
});

// Re-export so callers can use the OpenAI default if they want.
export { OPENAI_DEFAULT_MODEL };
