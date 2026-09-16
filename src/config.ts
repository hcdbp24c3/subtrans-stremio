export interface AddonConfig {
  streamUrl: string;
  subUrl: string;
  /** Comma-separated language codes, e.g. "en,vi,ja" — empty = all languages */
  languages: string;
}

export function encodeConfig(config: AddonConfig): string {
  const params = new URLSearchParams();
  params.set('stream', config.streamUrl);
  params.set('sub', config.subUrl);
  if (config.languages) params.set('lang', config.languages);
  return params.toString();
}

export function decodeConfig(queryString: string): AddonConfig | null {
  try {
    const params = new URLSearchParams(queryString);
    const streamUrl = params.get('stream') || '';
    const subUrl = params.get('sub') || '';
    if (!streamUrl || !subUrl) return null;
    return {
      streamUrl,
      subUrl,
      languages: params.get('lang') || '',
    };
  } catch {
    return null;
  }
}
