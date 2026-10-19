import crypto from 'node:crypto';

export const AI_SESSION_REMEMBER_MS = 7 * 24 * 60 * 60 * 1000;
export const AI_SESSION_TAB_MS = 12 * 60 * 60 * 1000;
const AUDIENCE = 'mentor-ai-paper-lab:research-only:v1';

function secretKey() {
  const password = process.env.MENTOR_AI_ACCESS_KEY || '';
  const seed = process.env.FYERS_SESSION_SECRET || '';
  if (!password || !seed) return null;
  return crypto.createHmac('sha256', seed).update('mentor-ai-paper-session-v1:' + password).digest();
}

export function constantEqual(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;
  const left = crypto.createHash('sha256').update(a).digest();
  const right = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

function sign(encoded, key) {
  return crypto.createHmac('sha256', key).update(encoded).digest('base64url');
}

export function issueAiSession(remember = false) {
  const key = secretKey();
  if (!key) return null;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + (remember ? AI_SESSION_REMEMBER_MS : AI_SESSION_TAB_MS);
  const payload = { v: 1, aud: AUDIENCE, iat: issuedAt, exp: expiresAt, jti: crypto.randomBytes(20).toString('hex') };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: encoded + '.' + sign(encoded, key), expiresAt: new Date(expiresAt).toISOString(), remembered: !!remember };
}

export function verifyAiSession(raw) {
  const key = secretKey();
  if (!key || typeof raw !== 'string' || raw.length > 2048 || raw.length < 40) return { valid: false };
  const parts = raw.split('.');
  if (parts.length !== 2) return { valid: false };
  const [encoded, signature] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) return { valid: false };
  const expected = sign(encoded, key);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { valid: false };
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const now = Date.now();
    if (payload.v !== 1 || payload.aud !== AUDIENCE ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.iat > now + 60_000 || payload.exp <= now ||
        payload.exp - payload.iat > AI_SESSION_REMEMBER_MS || !/^[a-f0-9]{40}$/.test(payload.jti || '')) return { valid: false };
    return { valid: true, expiresAt: new Date(payload.exp).toISOString() };
  } catch {
    return { valid: false };
  }
}
