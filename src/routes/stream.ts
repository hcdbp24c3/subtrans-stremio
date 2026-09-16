import { Router } from 'express';
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

router.get('/stream/:type/:id', async (req, res) => {
  const configStr = req.query.config as string;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  const { type, id } = req.params;
  const decodedId = decodeURIComponent(id);

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
});

export default router;
