import 'dotenv/config';
import path from 'node:path';

const MODES = new Set(['SIMULATION', 'PAPER', 'LIVE']);

function numberEnv(name, fallback = 0) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = String(process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function listEnv(name, fallback = []) {
  const raw = String(process.env[name] ?? '').trim();
  return raw ? raw.split(',').map(v => v.trim()).filter(Boolean) : fallback;
}

const executionMode = String(process.env.EXECUTION_MODE || 'SIMULATION').toUpperCase();

export const config = Object.freeze({
  port: Math.max(1, numberEnv('PORT', 8788)),
  host: process.env.HOST || '127.0.0.1',
  allowedOrigins: listEnv('ALLOWED_ORIGINS', ['https://dhananjaysaber.github.io']),
  controlApiKey: process.env.CONTROL_API_KEY || '',
  executionMode: MODES.has(executionMode) ? executionMode : 'SIMULATION',
  risk: Object.freeze({
    capitalLimit: Math.max(0, numberEnv('CAPITAL_LIMIT', 0)),
    maxRiskPerTradePct: Math.max(0, numberEnv('MAX_RISK_PER_TRADE_PCT', 0)),
    maxLots: Math.max(0, Math.floor(numberEnv('MAX_LOTS', 0))),
    dailyLossLimit: Math.max(0, numberEnv('DAILY_LOSS_LIMIT', 0)),
    staleDataMs: Math.max(1000, numberEnv('STALE_DATA_MS', 5000)),
    onePositionAtATime: boolEnv('ONE_POSITION_AT_A_TIME', true),
    envKillSwitch: boolEnv('GLOBAL_KILL_SWITCH', false)
  }),
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || './data'),
  fyers: Object.freeze({
    appId: process.env.FYERS_APP_ID || '',
    appSecret: process.env.FYERS_APP_SECRET || '',
    redirectUri: process.env.FYERS_REDIRECT_URI || '',
    frontendReturnUrl: process.env.FYERS_FRONTEND_RETURN_URL || 'https://dhananjaysaber.github.io/index-options-mentor-pwa/',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    stateSigningSecret: process.env.STATE_SIGNING_SECRET || ''
  })
});

export function riskConfigReady() {
  return config.risk.capitalLimit > 0 &&
    config.risk.maxRiskPerTradePct > 0 &&
    config.risk.maxLots > 0 &&
    config.risk.dailyLossLimit > 0;
}

export function fyersAuthConfigured() {
  const f = config.fyers;
  return Boolean(f.appId && f.appSecret && f.redirectUri && f.tokenEncryptionKey && f.stateSigningSecret);
}
