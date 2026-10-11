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
import { geminiProvider } from './gemini.js';
import {
  mistralProvider, xaiProvider, openrouterProvider, ollamaProvider,
} from './openai-compat.js';
import { libretranslateProvider } from './libretranslate.js';
import { bingProvider } from './bing.js';
import { yandexProvider } from './yandex.js';

export const PROVIDERS: Record<string, TranslationProvider> = {
  // Free / cheap (no OpenAI-compat server needed)
  google: googleProvider,
  deepl: deeplProvider,
  libretranslate: libretranslateProvider,
  // LLM providers (OpenAI-compat)
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  mistral: mistralProvider,
  xai: xaiProvider,
  openrouter: openrouterProvider,
  ollama: ollamaProvider,
  // Paid / legacy
  bing: bingProvider,
  yandex: yandexProvider,
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>;

export function getProvider(name: string): TranslationProvider | null {
  return PROVIDERS[name] ?? null;
}

export type { TranslationProvider, ProviderRequest, TranslateResult } from './types.js';
export { stitchEntries } from './types.js';

/**
 * Default provider list for the configure UI dropdown. Sorted with
 * free / cheap options first, then LLM providers, then paid.
 */
export const PROVIDER_OPTIONS: Array<{ value: string; label: string; needsKey: boolean }> = [
  { value: 'google', label: 'Google Translate (500K chars free/month)', needsKey: true },
  { value: 'deepl', label: 'DeepL (500K chars free with :fx key)', needsKey: true },
  { value: 'libretranslate', label: 'LibreTranslate (self-host, free)', needsKey: false },
  { value: 'ollama', label: 'Ollama (local, free)', needsKey: false },
  { value: 'openai', label: 'OpenAI (gpt-4o-mini)', needsKey: true },
  { value: 'anthropic', label: 'Anthropic Claude (haiku-4-5)', needsKey: true },
  { value: 'gemini', label: 'Google Gemini (gemini-2.0-flash)', needsKey: true },
  { value: 'mistral', label: 'Mistral AI (mistral-small)', needsKey: true },
  { value: 'xai', label: 'xAI Grok', needsKey: true },
  { value: 'openrouter', label: 'OpenRouter (multi-model)', needsKey: true },
  { value: 'bing', label: 'Microsoft Bing Translator', needsKey: true },
  { value: 'yandex', label: 'Yandex Translate', needsKey: true },
];
