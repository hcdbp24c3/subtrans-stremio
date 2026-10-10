/**
 * Provider registry.
 *
 * Maps provider name → TranslationProvider, plus a small helper that
 * resolves a configured provider from AddonConfig.
 */

import { TranslationProvider } from './types.js';
import { openaiProvider } from './openai.js';
import { anthropicProvider } from './anthropic.js';
import { deeplProvider } from './deepl.js';
import { googleProvider } from './google.js';

export const PROVIDERS: Record<string, TranslationProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
  deepl: deeplProvider,
  google: googleProvider,
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>;

export function getProvider(name: string): TranslationProvider | null {
  return PROVIDERS[name] ?? null;
}

/** Default provider list for the configure UI dropdown. */
export const PROVIDER_OPTIONS: Array<{ value: string; label: string; needsKey: boolean }> = [
  { value: 'google', label: 'Google Translate (500K free/month)', needsKey: true },
  { value: 'deepl', label: 'DeepL (500K free/month with :fx key)', needsKey: true },
  { value: 'openai', label: 'OpenAI (also OpenRouter/Mistral/xAI/LocalAI/Ollama)', needsKey: true },
  { value: 'anthropic', label: 'Anthropic Claude', needsKey: true },
];
