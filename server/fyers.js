import express from 'express';
import { fyersModel, fyersDataSocket } from 'fyers-api-v3';
import { buildMentorSnapshot, dateDaysAgoIST, dateKeyIST } from './mentor.js';

export const fyersRouter = express.Router();

const APP_ID = process.env.FYERS_APP_ID || '';
const APP_SECRET = process.env.FYERS_APP_SECRET || '';
const REDIRECT_URI = process.env.FYERS_REDIRECT_URI || 'http://127.0.0.1:8787/api/fyers/callback';

let accessToken = '';
let socket = null;
const listeners = new Set();

function configured() {
  return Boolean(APP_ID && APP_SECRET && REDIRECT_URI);
}

function client() {
  const fyers = new fyersModel({ path: '', enableLogging: false });
  fyers.setAppId(APP_ID);
  fyers.setRedirectUrl(REDIRECT_URI);
  if (accessToken) fyers.setAccessToken(accessToken);
  return fyers;
}

fyersRouter.get('/status', (_req, res) => {
  res.json({
    configured: configured(),
    authenticated: Boolean(accessToken),
    redirectUri: REDIRECT_URI
  });
});

fyersRouter.get('/login', (_req, res) => {
  if (!configured()) {
    return res.status(400).json({ error: 'FYERS is not configured yet.' });
  }
  const fyers = client();
  const url = fyers.generateAuthCode();
  res.redirect(url);
});

fyersRouter.get('/callback', async (req, res) => {
  const authCode = req.query.auth_code;
  if (!authCode) {
    return res.status(400).send('FYERS did not return an auth code.');
  }

  try {
    const fyers = client();
    const response = await fyers.generate_access_token({
      client_id: APP_ID,
      secret_key: APP_SECRET,
      auth_code: authCode
    });

    if (response?.s !== 'ok' || !response?.access_token) {
      console.error('FYERS token response:', response);
      return res.status(400).send('FYERS login could not be completed.');
    }

    accessToken = response.access_token;
    res.redirect('http://127.0.0.1:5173/?fyers=connected');
  } catch (error) {
    console.error(error);
    res.status(500).send('FYERS login failed.');
  }
});

fyersRouter.get('/quote', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Connect FYERS first.' });
  const symbols = String(req.query.symbol || 'NSE:NIFTY50-INDEX')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .slice(0, 10);

  try {
    const fyers = client();
    const response = await fyers.getQuotes(symbols.length ? symbols : ['NSE:NIFTY50-INDEX']);
    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load quote.' });
  }
});

fyersRouter.get('/history', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Connect FYERS first.' });

  const symbol = req.query.symbol || 'NSE:NIFTY50-INDEX';
  const resolution = req.query.resolution || '5';
  const today = dateKeyIST();

  try {
    const fyers = client();
    const response = await fyers.getHistory({
      symbol,
      resolution,
      date_format: '1',
      range_from: req.query.from || today,
      range_to: req.query.to || today,
      cont_flag: '1'
    });
    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load historical candles.' });
  }
});

fyersRouter.get('/option-chain', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Connect FYERS first.' });

  const symbol = req.query.symbol || 'NSE:NIFTY50-INDEX';
  const strikecount = Number(req.query.strikecount || 10);

  try {
    const fyers = client();
    const response = await fyers.getOptionChain({
      symbol,
      strikecount,
      timestamp: req.query.timestamp || '',
      greeks: '1'
    });
    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load option chain.' });
  }
});

fyersRouter.get('/mentor-snapshot', async (_req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Connect FYERS first.' });

  try {
    const fyers = client();
    const today = dateKeyIST();
    const from = dateDaysAgoIST(8);

    const [quoteResponse, historyResponse, chainResponse] = await Promise.all([
      fyers.getQuotes(['NSE:NIFTY50-INDEX']),
      fyers.getHistory({
        symbol: 'NSE:NIFTY50-INDEX',
        resolution: '5',
        date_format: '1',
        range_from: from,
        range_to: today,
        cont_flag: '1'
      }),
      fyers.getOptionChain({
        symbol: 'NSE:NIFTY50-INDEX',
        strikecount: 12,
        timestamp: '',
        greeks: '1'
      })
    ]);

    const snapshot = await buildMentorSnapshot({
      quoteResponse,
      historyResponse,
      chainResponse,
      now: new Date()
    });

    res.json(snapshot);
  } catch (error) {
    console.error('Mentor snapshot failed:', error);
    res.status(500).json({
      error: 'The live mentor snapshot could not be calculated.',
      detail: error?.message || 'Unknown error'
    });
  }
});

fyersRouter.get('/stream', (req, res) => {
  if (!accessToken) return res.status(401).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const listener = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  listeners.add(listener);

  req.on('close', () => listeners.delete(listener));
});

fyersRouter.post('/stream/start', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: 'Connect FYERS first.' });

  const symbols = Array.isArray(req.body.symbols) && req.body.symbols.length
    ? req.body.symbols
    : ['NSE:NIFTY50-INDEX'];

  try {
    if (socket) {
      try { socket.close(); } catch {}
      socket = null;
    }

    const DataSocket = fyersDataSocket;
    socket = DataSocket.getInstance(`${APP_ID}:${accessToken}`, '', false);

    socket.on('connect', () => {
      socket.subscribe(symbols);
      try { socket.mode(socket.FullMode); } catch {}
    });

    socket.on('message', (message) => {
      for (const listener of listeners) listener(message);
    });

    socket.on('error', (message) => {
      console.error('FYERS data socket:', message);
    });

    socket.on('close', () => {
      console.log('FYERS market-data socket closed');
    });

    socket.connect();
    res.json({ ok: true, symbols });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not start FYERS live stream.' });
  }
});
