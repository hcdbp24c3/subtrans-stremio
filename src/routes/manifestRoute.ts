import express, { Router } from 'express';
import { decodeConfig } from '../config.js';
import { generateManifest } from '../manifest.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// Redirect root to /configure
router.get('/', (_req, res) => {
  res.redirect('/configure');
});

// Serve configure page
router.get('/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'configure.html'));
});

function getBaseUrl(req: express.Request): string {
  const envBase = process.env.BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');

  const host = req.headers.host || `localhost:${process.env.PORT || 5100}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${host}`;
}

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

  const transportUrl = getBaseUrl(req);
  const manifest = generateManifest(config, transportUrl);
  res.json(manifest);
});

export default router;
