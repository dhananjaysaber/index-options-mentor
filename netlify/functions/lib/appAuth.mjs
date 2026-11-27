// The app's own sign-in. Owner decisions 27 Nov 2026: Sign in with Google for one
// approved account, a one-day sign-in, "sign out all devices", one main address.
// A FYERS (market-data) login never counts as an app sign-in.
// Anything that cannot be checked is refused.
import crypto from 'node:crypto';

export const MAIN_ORIGIN = 'https://optionsmentor.netlify.app';
export const APP_COOKIE = '__Host-iom_app';
export const NONCE_COOKIE = '__Host-iom_nonce';
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GENERATION = 'sign-in-generation';
const IST_OFFSET = 19800;

let testServices = null;
let keyCache = { keys: null, until: 0 };
export function setTestServices(services) { testServices = services; }

const env = name => String(globalThis.Netlify?.env?.get(name) ?? process.env[name] ?? '').trim();

export function config() {
  const value = {
    clientId: env('APP_GOOGLE_CLIENT_ID'), email: env('APP_ALLOWED_GOOGLE_EMAIL').toLowerCase(),
    sub: env('APP_ALLOWED_GOOGLE_SUB'), secret: env('APP_SESSION_SECRET')
  };
  value.ready = Boolean(value.clientId && value.secret.length >= 32 && (value.sub || value.email));
  return value;
}

export function reply(status, data, cookies = []) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

export const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function readCookie(request, name) {
  return (request.headers.get('cookie') || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(name + '='))?.slice(name.length + 1) || '';
}

/** Only the main address, and never a request started by another website. */
export function fromMainAddress(request) {
  const origin = request.headers.get('origin');
  if (new URL(request.url).origin !== MAIN_ORIGIN) return false;
  if (origin !== null && origin !== MAIN_ORIGIN) return false;
  return ['GET', 'HEAD'].includes(request.method) || origin === MAIN_ORIGIN;
}

function mac(purpose, text, secret) {
  return crypto.createHmac('sha256', secret).update(purpose + '\n' + text).digest('base64url');
}
export function seal(purpose, value, secret) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  return body + '.' + mac(purpose, body, secret);
}
export function open(purpose, sealed, secret) {
  const [body, given, extra] = String(sealed || '').split('.');
  if (!body || !given || extra !== undefined) return null;
  const expected = Buffer.from(mac(purpose, body, secret)), supplied = Buffer.from(given);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return Number.isInteger(value?.exp) && value.exp * 1000 > Date.now() ? value : null;
  } catch { return null; }
}

/** The next midnight in India, in seconds. Sign in once each day. */
export function endOfDayIST(nowMs = Date.now()) {
  const local = Math.floor(nowMs / 1000) + IST_OFFSET;
  return (Math.floor(local / 86400) + 1) * 86400 - IST_OFFSET;
}

export function approved(identity, settings = config()) {
  if (settings.sub) return identity.sub === settings.sub;
  // Without the permanent ID, only a Gmail address is safe to match by name.
  return Boolean(settings.email) && settings.email.endsWith('@gmail.com') && identity.email === settings.email;
}

// ---- "sign out all devices" record ----
async function store() {
  if (testServices?.store) return testServices.store;
  const { getStore } = await import('@netlify/blobs');
  const blobs = getStore({ name: 'iom-app-sign-in', consistency: 'strong' });
  return { get: key => blobs.get(key), set: (key, value, options) => blobs.set(key, value, options) };
}
export async function currentGeneration() { return (await store()).get(GENERATION); }
export async function generationForSignIn() {
  const records = await store();
  // Random, so a lost record can never match an earlier sign-in.
  await records.set(GENERATION, crypto.randomBytes(18).toString('hex'), { onlyIfNew: true });
  const value = await records.get(GENERATION);
  if (!value) throw Error('SIGN_IN_RECORD_UNAVAILABLE');
  return value;
}
export async function endAllSignIns() {
  await (await store()).set(GENERATION, crypto.randomBytes(18).toString('hex'));
}

// ---- Google proof of sign-in ----
async function googleKeys() {
  if (testServices?.googleKeys) return testServices.googleKeys();
  if (keyCache.keys && keyCache.until > Date.now()) return keyCache.keys;
  const response = await fetch(GOOGLE_KEYS_URL, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw Error('GOOGLE_KEYS_UNAVAILABLE');
  const data = await response.json();
  if (!Array.isArray(data?.keys)) throw Error('GOOGLE_KEYS_UNAVAILABLE');
  keyCache = { keys: data.keys, until: Date.now() + 3600000 };
  return data.keys;
}

/** Returns the Google identity, or null when the proof is not genuine and current. */
export async function verifyGoogleCredential(credential, nonce, settings = config()) {
  const parts = String(credential || '').split('.');
  if (parts.length !== 3 || String(credential).length > 6000) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
  if (header?.alg !== 'RS256') return null;
  const jwk = (await googleKeys()).find(key => key.kid === header.kid);
  if (!jwk) return null;
  const genuine = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  const now = Date.now() / 1000;
  if (!genuine || !['accounts.google.com', 'https://accounts.google.com'].includes(claims?.iss) ||
      claims.aud !== settings.clientId || !(claims.exp > now) || !(claims.iat <= now + 60) ||
      !nonce || claims.nonce !== nonce || claims.email_verified !== true ||
      typeof claims.sub !== 'string' || typeof claims.email !== 'string') return null;
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}

export function sessionFrom(request, settings = config()) {
  const value = open('session', readCookie(request, APP_COOKIE), settings.secret);
  return value && approved(value, settings) ? value : null;
}

/**
 * Gate for every private route. Returns null when allowed, otherwise the refusal.
 */
export async function requireApp(request) {
  if (!fromMainAddress(request)) return reply(403, { error: 'MAIN_ADDRESS_ONLY' });
  const settings = config();
  if (!settings.ready) return reply(503, { error: 'APP_SIGN_IN_NOT_CONFIGURED' });
  const session = sessionFrom(request, settings);
  let generation;
  try { generation = await currentGeneration(); }
  catch { return reply(503, { error: 'APP_SIGN_IN_CHECK_UNAVAILABLE' }); }
  if (!session || !generation || session.gen !== generation) return reply(401, { error: 'APP_SIGN_IN_REQUIRED' });
  return null;
}
