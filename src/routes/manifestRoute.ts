import express, { Router } from 'express';
import { decodeConfig, encodeConfig } from '../config.js';
import { generateManifest } from '../manifest.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

// Path-segment config: {base64url(config)}/manifest.json
// Stremio's addon SDK convention uses path segments for extra args
// (e.g. /{resource}/{type}/{id}/{extraArgs}.json). For configurable
// addons, embedding the config in the path keeps the URL self-contained
// and matches the protocol spec. We also accept the legacy ?config=
// query string for backward compatibility.

const PATH_SEGMENT = '[A-Za-z0-9_-]+'; // base64url charset
// Helper: extract config string from either path segment or query string.
function readConfigStr(req: express.Request): string | undefined {
  const pathConfig = (req.params as { config?: string }).config;
  if (pathConfig) {
    try {
      // base64url -> base64 -> decode
      const b64 = pathConfig.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      return Buffer.from(padded, 'base64').toString('utf-8');
    } catch {
      return undefined;
    }
  }
  return req.query.config as string | undefined;
}

// Redirect root to /configure
router.get('/', (_req, res) => {
  res.redirect('/configure');
});

// Serve configure page (legacy query string)
router.get('/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'configure.html'));
});

// Serve configure page (path segment: /{config}/configure)
router.get(`/:config(${PATH_SEGMENT})/configure`, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'configure.html'));
});

function getBaseUrl(req: express.Request): string {
  const envBase = process.env.BASE_URL;
  if (envBase) return envBase.replace(/\/$/, '');

  const host = req.headers.host || `localhost:${process.env.PORT || 5100}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${protocol}://${host}`;
}

// Manifest with path segment config
router.get(`/:config(${PATH_SEGMENT})/manifest.json`, (req, res) => {
  const configStr = readConfigStr(req);
  if (!configStr) {
    res.status(400).json({ error: 'Missing config' });
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

// Manifest with legacy query string
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

/**
 * Helper exported for the configure UI to convert a config string into
 * the path-segment form: base64url(config).
 */
export function configToPathSegment(configStr: string): string {
  return Buffer.from(configStr, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export { encodeConfig };

export default router;
