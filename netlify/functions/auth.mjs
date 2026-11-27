// Sign in, sign out and "sign out all devices". No trading code is reachable here.
import crypto from 'node:crypto';
import {
  APP_COOKIE, NONCE_COOKIE, approved, config as signInConfig, cookie, endAllSignIns, endOfDayIST, fromMainAddress,
  generationForSignIn, open, readCookie, reply, requireApp, seal, sessionFrom, verifyGoogleCredential
} from './lib/appAuth.mjs';

const clearAll = () => [cookie(APP_COOKIE, '', 0), cookie('iom_fyers_session', '', 0)];

async function login(request, settings) {
  let body;
  try {
    const text = await request.text();
    if (text.length > 8000) return reply(413, { error: 'BODY_TOO_LARGE' });
    body = JSON.parse(text);
  } catch { return reply(400, { error: 'INVALID_JSON' }); }
  const issued = open('nonce', readCookie(request, NONCE_COOKIE), settings.secret);
  const spent = cookie(NONCE_COOKIE, '', 0);
  try {
    const identity = await verifyGoogleCredential(body?.credential, issued?.nonce, settings);
    if (!identity) return reply(403, { error: 'GOOGLE_SIGN_IN_NOT_VERIFIED' }, [spent]);
    if (!approved(identity, settings)) return reply(403, { error: 'ACCOUNT_NOT_ALLOWED' }, [spent]);
    const now = Date.now(), exp = endOfDayIST(now);
    const value = seal('session', { sub: identity.sub, email: identity.email, gen: await generationForSignIn(), exp }, settings.secret);
    return reply(200, { signedIn: true, expiresAt: exp }, [cookie(APP_COOKIE, value, Math.max(1, exp - Math.floor(now / 1000))), spent]);
  } catch {
    return reply(503, { error: 'APP_SIGN_IN_CHECK_UNAVAILABLE' });
  }
}

export default async function auth(request) {
  const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
  const method = { config: 'GET', session: 'GET', login: 'POST', logout: 'POST', 'logout-all': 'POST' }[action];
  if (!method) return reply(404, { error: 'UNKNOWN_SIGN_IN_ROUTE' });
  if (request.method !== method) return reply(405, { error: 'METHOD_NOT_ALLOWED' });
  if (!fromMainAddress(request)) return reply(403, { error: 'MAIN_ADDRESS_ONLY' });
  // Signing out of this device must always work.
  if (action === 'logout') return reply(200, { signedIn: false }, clearAll());
  const settings = signInConfig();
  if (action === 'config') {
    if (!settings.ready) return reply(200, { configured: false, clientId: '', nonce: '' });
    const nonce = crypto.randomBytes(24).toString('hex');
    const value = seal('nonce', { nonce, exp: Math.floor(Date.now() / 1000) + 600 }, settings.secret);
    return reply(200, { configured: true, clientId: settings.clientId, nonce }, [cookie(NONCE_COOKIE, value, 600)]);
  }
  if (!settings.ready) return reply(503, { error: 'APP_SIGN_IN_NOT_CONFIGURED' });
  if (action === 'login') return login(request, settings);
  const refused = await requireApp(request);
  if (refused) return refused;
  if (action === 'session') return reply(200, { signedIn: true, expiresAt: sessionFrom(request, settings).exp });
  try { await endAllSignIns(); }
  catch { return reply(503, { error: 'SIGN_OUT_ALL_NOT_CONFIRMED' }); }
  return reply(200, { signedIn: false, allDevices: true }, clearAll());
}
