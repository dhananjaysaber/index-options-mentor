// PAPER-ONLY position-sync gateway. No broker-order functionality.
// Requires Netlify env AWS_PAPER_SYNC_BASE and AWS_PAPER_SYNC_SECRET.
// The corresponding AWS endpoint must verify the HMAC before accepting changes.
import crypto from 'node:crypto';

const ORIGIN = 'https://dhananjaysaber.github.io';
const SESSION_COOKIE = 'iom_fyers_session';
const MAX_BYTES = 32768;
const reply = (code, value, origin = '') => new Response(JSON.stringify(value), {
  status: code,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(origin === ORIGIN ? {
      'Access-Control-Allow-Origin': ORIGIN,
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin'
    } : {})
  }
});

function hasEncryptedFyersSession(request) {
  const secret = process.env.FYERS_SESSION_SECRET;
  if (!secret) return false;
  const bearer = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = (request.headers.get('cookie') || '').split(';').map(v => v.trim())
    .find(v => v.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
  const value = bearer || (cookie ? decodeURIComponent(cookie) : '');
  if (!value || value.length > 8192) return false;
  try {
    const payload = Buffer.from(value, 'base64url');
    if (payload.length < 29) return false;
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm', crypto.createHash('sha256').update(secret).digest(),
      payload.subarray(0, 12)
    );
    decipher.setAuthTag(payload.subarray(12, 28));
    return decipher.update(payload.subarray(28), undefined, 'utf8').length +
      decipher.final('utf8').length > 20;
  } catch {
    return false;
  }
}

export default async function handler(request) {
  const origin = request.headers.get('origin') || '';
  if (request.method === 'OPTIONS')
    return origin === ORIGIN
      ? new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Origin': ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Vary': 'Origin'
        } })
      : reply(403, { error: 'ORIGIN_NOT_ALLOWED' }, origin);
  if (!['GET', 'POST'].includes(request.method))
    return reply(405, { error: 'METHOD_NOT_ALLOWED' }, origin);
  if (origin && origin !== ORIGIN)
    return reply(403, { error: 'ORIGIN_NOT_ALLOWED' }, origin);
  if (!hasEncryptedFyersSession(request))
    return reply(401, { error: 'FYERS_SESSION_REQUIRED' }, origin);

  const base = String(process.env.AWS_PAPER_SYNC_BASE || '').replace(/\/$/, '');
  const secret = process.env.AWS_PAPER_SYNC_SECRET || '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base) || secret.length < 32)
    return reply(503, { error: 'PAPER_SYNC_NOT_CONFIGURED' }, origin);

  const route = new URL(request.url).pathname;
  const action = route.endsWith('/sync') ? 'sync' : route.endsWith('/reconcile') ? 'reconcile' : route.endsWith('/status') ? 'status' : '';
  if (!action || (['sync', 'reconcile'].includes(action) && request.method !== 'POST') ||
      (action === 'status' && request.method !== 'GET'))
    return reply(404, { error: 'UNKNOWN_MONITOR_ROUTE' }, origin);

  // A FYERS login alone does not establish ownership of the one shared
  // AWS paper-state file. Fail closed until verified account binding is added.
  // Do not permit any browser session to open/close someone else's position.
  if (action === 'sync' || action === 'reconcile')
    return reply(403, { error: 'PAPER_WRITE_OWNER_VERIFICATION_REQUIRED' }, origin);

  const body = request.method === 'POST' ? await request.text() : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES)
    return reply(413, { error: 'PAYLOAD_TOO_LARGE' }, origin);
  if (body) {
    try { if (!JSON.parse(body) || Array.isArray(JSON.parse(body))) throw Error(); }
    catch { return reply(400, { error: 'INVALID_JSON' }, origin); }
  }
  const endpoint = '/monitor/bridge/' + action;
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [timestamp, nonce, request.method, endpoint,
    crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  try {
    const response = await fetch(base + endpoint, {
      method: request.method,
      headers: {
        'content-type': 'application/json',
        'x-iom-time': timestamp,
        'x-iom-nonce': nonce,
        'x-iom-signature': signature
      },
      body: request.method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(6000),
      redirect: 'error'
    });
    const data = await response.json().catch(() => ({ error: 'INVALID_AWS_RESPONSE' }));
    return reply(response.status, data, origin);
  } catch {
    return reply(503, { error: 'AWS_MONITOR_UNAVAILABLE' }, origin);
  }
}
