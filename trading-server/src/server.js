import crypto from 'node:crypto';
import express from 'express';
import { config, riskConfigReady } from './config.js';
import { AuditLog } from './audit-log.js';
import { RuntimeState } from './runtime-state.js';
import { TokenVault } from './token-vault.js';
import { FyersAuth } from './fyers-auth.js';
import { ExecutionGate } from './execution-gate.js';

const app = express();
const audit = new AuditLog(config.dataDir);
const state = new RuntimeState(config.dataDir);
const vault = new TokenVault(config.dataDir, config.fyers.tokenEncryptionKey);
const fyers = new FyersAuth({ config: config.fyers, vault, audit, state });
const execution = new ExecutionGate({ config, state, audit, riskConfigReady });

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(securityHeaders);
app.use(corsAllowlist);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'index-options-mentor-trading-server',
    mode: config.executionMode,
    liveExecution: false
  });
});

app.get('/api/status', requireControlAuth, (_req, res) => {
  res.json({
    ok: true,
    mode: config.executionMode,
    liveExecution: false,
    riskConfigReady: riskConfigReady(),
    risk: {
      capitalLimit: config.risk.capitalLimit,
      maxRiskPerTradePct: config.risk.maxRiskPerTradePct,
      maxLots: config.risk.maxLots,
      dailyLossLimit: config.risk.dailyLossLimit,
      staleDataMs: config.risk.staleDataMs,
      onePositionAtATime: config.risk.onePositionAtATime,
      killSwitch: config.risk.envKillSwitch || state.snapshot().killSwitch
    },
    fyers: fyers.status(),
    runtime: state.snapshot()
  });
});

app.post('/api/risk/preflight', requireControlAuth, (req, res) => {
  const result = execution.preflight(req.body || {});
  res.status(result.ok ? 200 : 422).json(result);
});

app.post('/api/execution/simulate', requireControlAuth, (req, res) => {
  const result = execution.simulate(req.body || {});
  res.status(result.ok ? 200 : 422).json(result);
});

app.post('/api/control/kill-switch', requireControlAuth, (req, res) => {
  const enabled = req.body?.enabled === true;
  const next = state.setKillSwitch(enabled);
  audit.append(enabled ? 'KILL_SWITCH_ENABLED' : 'KILL_SWITCH_DISABLED', { source: 'control_api' });
  res.json({ ok: true, enabled: next.killSwitch });
});

app.get('/api/audit', requireControlAuth, (req, res) => {
  res.json({ ok: true, events: audit.read(req.query.limit) });
});

app.get('/api/fyers/status', requireControlAuth, (_req, res) => {
  res.json({ ok: true, ...fyers.status() });
});

app.get('/api/fyers/login-url', requireControlAuth, (_req, res) => {
  try {
    res.json({ ok: true, url: fyers.createLoginUrl() });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get('/api/fyers/callback', async (req, res) => {
  const authCode = String(req.query.auth_code || '');
  const stateValue = String(req.query.state || '');
  if (!authCode || !stateValue) return res.status(400).send('FYERS callback is incomplete.');

  try {
    const destination = await fyers.completeCallback(authCode, stateValue);
    res.redirect(destination);
  } catch (error) {
    audit.append('FYERS_CALLBACK_FAILED', { message: error.message });
    res.status(400).send('FYERS login could not be completed.');
  }
});

app.post('/api/fyers/logout', requireControlAuth, (_req, res) => {
  fyers.logout();
  res.json({ ok: true });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

app.listen(config.port, config.host, () => {
  audit.append('SERVER_STARTED', {
    host: config.host,
    port: config.port,
    mode: config.executionMode,
    liveExecution: false
  });
  console.log(`Trading server listening on http://${config.host}:${config.port}`);
});

function requireControlAuth(req, res, next) {
  if (!config.controlApiKey) {
    return res.status(503).json({ ok: false, error: 'CONTROL_API_KEY is not configured.' });
  }

  const header = String(req.headers.authorization || '');
  const supplied = header.replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, config.controlApiKey)) {
    audit.append('CONTROL_AUTH_REJECTED', { path: req.path, ip: req.ip });
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }
  next();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function securityHeaders(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function corsAllowlist(req, res, next) {
  const origin = String(req.headers.origin || '');
  if (origin && config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }

  if (req.method === 'OPTIONS') {
    if (!origin || !config.allowedOrigins.includes(origin)) return res.sendStatus(403);
    return res.sendStatus(204);
  }

  next();
}
