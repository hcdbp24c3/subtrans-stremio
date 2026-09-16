import express from 'express';

const app = express();
const PORT = parseInt(process.env.PORT || '5100', 10);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
