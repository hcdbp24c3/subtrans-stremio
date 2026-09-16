import { Router } from 'express';
import { decodeConfig } from '../config.js';
import { generateManifest } from '../manifest.js';

const router = Router();

router.get('/manifest.json', (req, res) => {
  const configStr = req.query.config as string | undefined;
  if (!configStr) {
    res.status(400).json({ error: 'Missing config parameter' });
    return;
  }

  const config = decodeConfig(configStr);
  if (!config) {
    res.status(400).json({ error: 'Invalid config' });
    return;
  }

  const host = req.headers.host || `localhost:${process.env.PORT || 5100}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const transportUrl = `${protocol}://${host}`;

  const manifest = generateManifest(config, transportUrl);
  res.json(manifest);
});

export default router;
