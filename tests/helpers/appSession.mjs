// Fake Google and fake sign-out storage. No network, no real account.
import crypto from 'node:crypto';
import { MAIN_ORIGIN, setTestServices } from '../../netlify/functions/lib/appAuth.mjs';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const APPROVED = { email: 'test.owner@gmail.com', sub: '1000000001' };
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

export function setUpAppAuth() {
  const world = { values: new Map(), storeDown: false };
  const check = () => { if (world.storeDown) throw Error('STORE_DOWN'); };
  setTestServices({
    store: {
      async get(key) { check(); return world.values.get(key) ?? null; },
      async set(key, value, options = {}) {
        check();
        if (options.onlyIfNew && world.values.has(key)) return { modified: false };
        world.values.set(key, value); return { modified: true };
      }
    },
    googleKeys: async () => [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256' }]
  });
  Object.assign(process.env, { APP_GOOGLE_CLIENT_ID: CLIENT_ID, APP_ALLOWED_GOOGLE_EMAIL: APPROVED.email, APP_SESSION_SECRET: 'test-only-app-session-'.repeat(3) });
  return world;
}

export function googleToken(claims, { key = keys.privateKey, algorithm = 'RS256' } = {}) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const text = part({ alg: algorithm, kid: 'test-key' }) + '.' + part({
    iss: 'https://accounts.google.com', aud: CLIENT_ID, iat: now, exp: now + 600,
    email: APPROVED.email, email_verified: true, sub: APPROVED.sub, ...claims
  });
  return text + '.' + (algorithm === 'none' ? '' : crypto.sign('RSA-SHA256', Buffer.from(text), key).toString('base64url'));
}

export async function fakeSignIn(auth, claims = {}, { raw = false, origin = MAIN_ORIGIN, ...signing } = {}) {
  const config = await auth(new Request(MAIN_ORIGIN + '/api/auth/config'));
  const { nonce } = await config.json();
  const nonceCookie = config.headers.getSetCookie()[0].split(';')[0];
  const response = await auth(new Request(MAIN_ORIGIN + '/api/auth/login', {
    method: 'POST', headers: { origin, cookie: nonceCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: googleToken({ nonce, ...claims }, signing) })
  }));
  if (raw) return response;
  if (response.status !== 200) throw Error('FAKE_SIGN_IN_FAILED_' + response.status);
  return response.headers.getSetCookie().find(value => value.startsWith('__Host-iom_app=')).split(';')[0];
}

/** A signed-in browser for gateway tests. */
export async function signedInCookie() {
  const { default: auth } = await import('../../netlify/functions/auth.mjs');
  setUpAppAuth();
  return fakeSignIn(auth);
}
