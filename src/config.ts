export interface AddonConfig {
  /** Stream addon manifest URLs (supports multiple) */
  streamUrls: string[];
  /** Subtitle addon manifest URLs (supports multiple) */
  subUrls: string[];
  /** Comma-separated language codes, e.g. "en,vi,ja" — empty = all languages */
  languages: string;
  /**
   * Lingarr server base URL (e.g. "http://localhost:9876"). When set, the addon
   * fills missing target languages by translating the best available source sub.
   * Falls back to env `LINGARR_URL` when empty.
   */
  lingarrUrl: string;
  /**
   * Lingarr API key (sent as `X-Api-Key`). Falls back to env `LINGARR_API_KEY`.
   * Omit/empty when Lingarr has authentication disabled.
   */
  lingarrApiKey: string;
  /**
   * ISO 639-1 language codes the user wants available, e.g. ["vi","ja"].
   * If a target language is missing from upstream sub addons, the addon will
   * translate a source sub via Lingarr and inject it into the response.
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
  if (config.lingarrUrl) params.set('lingarr', config.lingarrUrl);
  if (config.lingarrApiKey) params.set('lingarrKey', config.lingarrApiKey);
  for (const code of config.translateTargets) {
    if (code) params.append('translate', code);
  }
  return params.toString();
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
      lingarrUrl: (params.get('lingarr') || '').trim(),
      lingarrApiKey: (params.get('lingarrKey') || '').trim(),
      translateTargets: params.getAll('translate').map((c) => c.trim()).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the effective Lingarr base URL. Per-user config wins; falls back to
 * env `LINGARR_URL`. Returns null when neither is set (translation disabled).
 * Trailing slashes are stripped.
 */
export function resolveLingarrUrl(config: AddonConfig): string | null {
  const raw = (config.lingarrUrl || process.env.LINGARR_URL || '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Resolve the effective Lingarr API key. Per-user config wins; falls back to
 * env `LINGARR_API_KEY`. Returns undefined when neither is set (Lingarr likely
 * has authentication disabled — caller decides whether to send the header).
 */
export function resolveLingarrApiKey(config: AddonConfig): string | undefined {
  const raw = (config.lingarrApiKey || process.env.LINGARR_API_KEY || '').trim();
  return raw || undefined;
}
