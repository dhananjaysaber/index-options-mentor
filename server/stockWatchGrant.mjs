import { createHmac, timingSafeEqual } from 'node:crypto';

const FORMAT_VERSION = 1;
const GRANT_TTL_MS = 3 * 60 * 1000;

// A short-lived, session-bound proof that the SERVER already verified
// completed weekly/daily structure. The browser cannot change the 85+ score.
export function createStockWatchGrant(watch, scope, secret, now = Date.now()) {
  if (!secret || !scope || watch?.status !== 'WATCH' || Number(watch.score) < 85 ||
      !['CE','PE'].includes(watch.side) || !['BULLISH','BEARISH'].includes(watch.weekBias) ||
      watch.weekBias !== watch.dayBias || !(Number(watch.spot) > 0)) return null;
  const payload = {
    version: FORMAT_VERSION, scope,
    stock: watch.stock, side: watch.side, score: Number(watch.score),
    weekBias: watch.weekBias, dayBias: watch.dayBias,
    reason: String(watch.reason || '').slice(0, 200), spot: Number(watch.spot),
    issuedAt: now, expiresAt: now + GRANT_TTL_MS
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + signature;
}

export function verifyStockWatchGrant(token, scope, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 2500 ||
      !secret || !scope) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [body, signature] = parts;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return null; }
  if (payload?.version !== FORMAT_VERSION || payload?.scope !== scope ||
      !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt) ||
      payload.issuedAt > now + 5000 || payload.issuedAt < now - GRANT_TTL_MS ||
      payload.expiresAt <= now || payload.expiresAt > payload.issuedAt + GRANT_TTL_MS ||
      !/^[A-Z0-9&._-]{2,30}$/.test(payload.stock || '') ||
      !['CE','PE'].includes(payload.side) ||
      !(Number(payload.score) >= 85 && Number(payload.score) <= 100) ||
      !['BULLISH','BEARISH'].includes(payload.weekBias) ||
      payload.dayBias !== payload.weekBias ||
      (payload.side === 'CE' && payload.weekBias !== 'BULLISH') ||
      (payload.side === 'PE' && payload.weekBias !== 'BEARISH') ||
      !(Number(payload.spot) > 0)) return null;
  return { ...payload, status: 'WATCH' };
}
