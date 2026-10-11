import { AddonConfig } from './config.js';

export function generateManifest(
  config: AddonConfig,
  transportUrl: string
): Record<string, unknown> {
  return {
    id: 'org.subtrans.alignment',
    version: '1.0.0',
    name: 'Subtitle Alignment Addon',
    description: 'Auto-aligns subtitles using ffprobe video duration detection',
    logo: 'https://cdn-icons-png.flaticon.com/512/2788/2788835.png',
    catalogs: [],
    resources: ['stream', 'subtitles'],
    types: ['movie', 'series'],
    // transportUrl tells Stremio which base URL to call for /subtitles/...
    // and /stream/... requests. Without it, the client may guess wrong
    // (e.g. default to a stale cached value).
    transportUrl: transportUrl.replace(/\/$/, ''),
    behavior: {
      bingeOnly: false,
    },
    behaviorHints: {
      configurable: true,
    },
  };
}
