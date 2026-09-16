export interface AddonConfig {
  /** Stream addon manifest URLs (supports multiple) */
  streamUrls: string[];
  /** Subtitle addon manifest URLs (supports multiple) */
  subUrls: string[];
  /** Comma-separated language codes, e.g. "en,vi,ja" — empty = all languages */
  languages: string;
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
    };
  } catch {
    return null;
  }
}
