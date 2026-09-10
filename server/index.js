import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fyersRouter } from './fyers.js';

const app = express();
const port = 8787;

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: process.env.FYERS_APP_ID ? 'configured' : 'demo' });
});

app.use('/api/fyers', fyersRouter);

app.listen(port, '127.0.0.1', () => {
  console.log(`Mentor API running on http://127.0.0.1:${port}`);
});
