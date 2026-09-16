import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { fetchJson } from '../lib/proxy.js';

const router = Router();

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

  // Fetch streams from upstream stream addon
  // Stremio sends type/id as path params, upstream expects same format
  const upstreamUrl = `${config.streamUrl.replace(/\/manifest\.json$/, '')}/stream/${type}/${decodedId}`;
  const streams = await fetchJson(upstreamUrl);

  if (!streams) {
    res.status(502).json({ error: 'Failed to fetch streams from upstream' });
    return;
  }

  res.json(streams);
});

export default router;
