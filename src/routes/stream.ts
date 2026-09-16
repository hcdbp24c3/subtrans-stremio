import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson } from '../lib/proxy.js';

const router = Router();

interface Manifest {
  id: string;
  transportUrl?: string;
  // Some addons embed config in path — fetch manifest to discover base
}

async function getUpstreamBaseUrl(manifestUrl: string): Promise<string> {
  // Fetch the manifest to discover the actual transport URL
  // Some addons (like HdHub) embed config in the path, so we can't just strip /manifest.json
  const manifest = await fetchJson<Manifest>(manifestUrl);
  if (manifest?.transportUrl) {
    return manifest.transportUrl;
  }
  // Fallback: strip /manifest.json from the URL
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

  // Fetch manifest to discover correct base URL
  const baseUrl = await getUpstreamBaseUrl(config.streamUrl);
  const upstreamUrl = `${baseUrl}/stream/${type}/${decodedId}`;

  const streams = await fetchJson(upstreamUrl);

  if (!streams) {
    res.status(502).json({ error: 'Failed to fetch streams from upstream' });
    return;
  }

  res.json(streams);
});

export default router;
