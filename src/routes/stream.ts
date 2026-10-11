import { Router, Request, Response } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson } from '../lib/proxy.js';

const router = Router();

interface Manifest {
  id: string;
  transportUrl?: string;
}

async function getUpstreamBaseUrl(manifestUrl: string): Promise<string> {
  const manifest = await fetchJson<Manifest>(manifestUrl);
  if (manifest?.transportUrl) return manifest.transportUrl;
  return manifestUrl.replace(/\/manifest\.json$/, '');
}

const PATH_SEGMENT_RE = '[A-Za-z0-9_-]+';

function decodePathConfig(seg: string | undefined): string | undefined {
  if (!seg) return undefined;
  try {
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

const streamHandler = async (req: Request, res: Response) => {
  // Resolve config from path segment or query string (path wins).
  let configStr: string | undefined;
  const pathConfig = (req.params as { config?: string }).config;
  if (pathConfig) {
    configStr = decodePathConfig(pathConfig);
  } else {
    const raw = req.query.config;
    const first = Array.isArray(raw) ? raw[0] : raw;
    configStr = typeof first === 'string' ? first : undefined;
  }
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  const { type: paramType, id: paramId } = req.params;
  const type = Array.isArray(paramType) ? paramType[0] : paramType;
  const id = Array.isArray(paramId) ? paramId[0] : paramId;
  // Stremio appends .json to resource URLs (/stream/movie/tt123.json)
  const decodedId = decodeURIComponent(id ?? '').replace(/\.json$/, '');

  // Fetch streams from all upstream addons in parallel, merge results
  const results = await Promise.allSettled(
    config.streamUrls.map(async (streamUrl) => {
      const baseUrl = await getUpstreamBaseUrl(streamUrl);
      const upstreamUrl = `${baseUrl}/stream/${type}/${decodedId}.json`;
      const data = await fetchJson<{ streams: Array<Record<string, unknown>> }>(upstreamUrl);
      return data?.streams || [];
    })
  );

  const allStreams = results
    .filter((r): r is PromiseFulfilledResult<Array<Record<string, unknown>>> => r.status === 'fulfilled')
    .flatMap((r) => r.value);

  if (allStreams.length === 0) {
    res.json({ streams: [] });
    return;
  }

  res.json({ streams: allStreams });
};

router.get('/stream/:type/:id', streamHandler);
// Path-segment config: /<config>/stream/<type>/<id>.json
router.get(`/:config(${PATH_SEGMENT_RE})/stream/:type/:id`, streamHandler);

export default router;
