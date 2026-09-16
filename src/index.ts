import express from 'express';
import configRoute from './routes/configure.js';
import manifestRoute from './routes/manifestRoute.js';
import streamRoute from './routes/stream.js';
import subtitleRoute from './routes/subtitle.js';

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

// Middleware
app.use(express.json());

// Routes
app.use(configRoute);
app.use(manifestRoute);
app.use(streamRoute);
app.use(subtitleRoute);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎬 Subtitle Alignment Addon running on http://0.0.0.0:${PORT}`);
  console.log(`   Configure: http://localhost:${PORT}/configure`);
});
