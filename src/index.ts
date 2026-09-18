import express from 'express';
import manifestRoute from './routes/manifestRoute.js';
import streamRoute from './routes/stream.js';
import subtitleRoute from './routes/subtitle.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);
const BASE_URL = process.env.BASE_URL || ''; // e.g. "https://example.com"

// Trust proxy for correct req.protocol behind reverse proxy
app.set('trust proxy', true);

// Middleware
app.use(express.json());

// CORS — required for Stremio web client
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

// Routes
app.use(manifestRoute);
app.use(streamRoute);
app.use(subtitleRoute);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  const display = BASE_URL || `http://localhost:${PORT}`;
  console.log(`🎬 Subtitle Alignment Addon running on http://0.0.0.0:${PORT}`);
  console.log(`   External: ${display}`);
  console.log(`   Configure: ${display}/configure`);
});
