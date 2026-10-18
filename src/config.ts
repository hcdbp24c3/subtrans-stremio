export interface AddonConfig {
  /** Stream addon manifest URLs (supports multiple) */
  streamUrls: string[];
  /** Subtitle addon manifest URLs (supports multiple) */
  subUrls: string[];
  /** Comma-separated language codes, e.g. "en,vi,ja" — empty = all languages */
  languages: string;
  /**
   * Translation provider name. One of: 'google' | 'deepl' | 'openai' |
   * 'anthropic'. When set, the addon fills missing target languages by
   * translating the best source sub via the chosen provider.
   * Falls back to env `TRANSLATE_PROVIDER` when empty.
   */
  translateProvider: string;
  /** API key for the translation provider. */
  translateKey: string;
  /**
   * Optional provider base URL override (for self-hosted OpenAI-compat
   * servers, LocalAI, Ollama, etc.). Falls back to env `TRANSLATE_BASE_URL`.
   */
  translateBaseUrl: string;
  /**
   * Optional model name override (provider-specific). Falls back to the
   * provider's default model when empty.
   */
  translateModel: string;
  /**
   * ISO 639-1 language codes the user wants available, e.g. ["vi","ja"].
   * If a target language is missing from upstream sub addons, the addon will
   * translate a source sub via the configured provider and inject it.
   * Empty = do not auto-translate.
   */
  translateTargets: string[];
}

export function encodeConfig(config: AddonConfig): string {
  const params = new URLSearchParams();
  for (const url of config.streamUrls) {
    if (url) params.append('stream', url);
  }
  for (const url of config.subUrls) {
    if (url) params.append('sub', url);
  }
  if (config.languages) params.set('lang', config.languages);
  if (config.translateProvider) params.set('tp', config.translateProvider);
  if (config.translateKey) params.set('tk', config.translateKey);
  if (config.translateBaseUrl) params.set('tbu', config.translateBaseUrl);
  if (config.translateModel) params.set('tm', config.translateModel);
  for (const code of config.translateTargets) {
    if (code) params.append('translate', code);
  }
  return params.toString();
}

function normalizeTargetLang(code: string): string {
  const c = code.trim().toLowerCase();
  if (c.length <= 2) return c;
  const m: Record<string, string> = {
    eng: 'en', vie: 'vi', jpn: 'ja', kor: 'ko', zho: 'zh', tha: 'th',
    ind: 'id', msa: 'ms', fra: 'fr', deu: 'de', spa: 'es', por: 'pt',
    ita: 'it', rus: 'ru', ara: 'ar', hin: 'hi', tur: 'tr', pol: 'pl',
  };
  return m[c] ?? c;
}

export function decodeConfig(queryString: string): AddonConfig | null {
  try {
    const params = new URLSearchParams(queryString);
    const streamUrls = params.getAll('stream').filter(Boolean);
    const subUrls = params.getAll('sub').filter(Boolean);
    if (streamUrls.length === 0 || subUrls.length === 0) return null;
    return {
      streamUrls,
      subUrls,
      languages: params.get('lang') || '',
      translateProvider: (params.get('tp') || '').trim(),
      translateKey: (params.get('tk') || '').trim(),
      translateBaseUrl: (params.get('tbu') || '').trim(),
      translateModel: (params.get('tm') || '').trim(),
      translateTargets: Array.from(new Set(params.getAll('translate').map(normalizeTargetLang).filter(Boolean))),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective translation provider. Per-user config wins; falls
 * back to env `TRANSLATE_PROVIDER`. Returns null when neither is set.
 */
export function resolveTranslateProvider(config: AddonConfig): string | null {
  const raw = (config.translateProvider || process.env.TRANSLATE_PROVIDER || '').trim();
  return raw || null;
}

/**
 * Resolve the translation API key. Per-user config wins; falls back to
 * env. Env keys are provider-specific: TRANSLATE_GOOGLE_KEY,
 * TRANSLATE_DEEPL_KEY, TRANSLATE_OPENAI_KEY, TRANSLATE_ANTHROPIC_KEY.
 * Generic TRANSLATE_KEY is also accepted as a fallback.
 */
export function resolveTranslateKey(
  config: AddonConfig,
  provider: string,
): string | undefined {
  const explicit = (config.translateKey || '').trim();
  if (explicit) return explicit;
  const generic = process.env.TRANSLATE_KEY?.trim();
  if (generic) return generic;
  const specific = process.env[`TRANSLATE_${provider.toUpperCase()}_KEY`]?.trim();
  return specific || undefined;
}

/** Resolve the optional base URL override. */
export function resolveTranslateBaseUrl(config: AddonConfig): string | undefined {
  const raw = (config.translateBaseUrl || process.env.TRANSLATE_BASE_URL || '').trim();
  return raw || undefined;
}

/** Resolve the optional model name override. */
export function resolveTranslateModel(config: AddonConfig): string | undefined {
  const raw = (config.translateModel || process.env.TRANSLATE_MODEL || '').trim();
  return raw || undefined;
}
