export interface AddonConfig {
  streamUrl: string;
  subUrl: string;
}

export function encodeConfig(config: AddonConfig): string {
  const params = new URLSearchParams();
  params.set('stream', config.streamUrl);
  params.set('sub', config.subUrl);
  return params.toString();
}

export function decodeConfig(queryString: string): AddonConfig | null {
  try {
    const params = new URLSearchParams(queryString);
    const streamUrl = params.get('stream') || '';
    const subUrl = params.get('sub') || '';
    if (!streamUrl || !subUrl) return null;
    return { streamUrl, subUrl };
  } catch {
    return null;
  }
}
