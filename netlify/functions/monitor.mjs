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

const PROFILE_URL = 'https://api-t1.fyers.in/api/v3/profile';
const verifiedProfiles = new Map();

function decryptedFyersToken(request) {
  const secret = process.env.FYERS_SESSION_SECRET;
  if (!secret) return '';
  const bearer = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)?.[1];
  const cookie = (request.headers.get('cookie') || '').split(';').map(v => v.trim())
    .find(v => v.startsWith(SESSION_COOKIE + '='))?.slice(SESSION_COOKIE.length + 1);
  let value = bearer || '';
  if (!value && cookie) {
    try { value = decodeURIComponent(cookie); }
    catch { return ''; }
  }
  if (!value || value.length > 8192) return '';
  try {
    const payload = Buffer.from(value, 'base64url');
    if (payload.length < 29) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm',
      crypto.createHash('sha256').update(secret).digest(), payload.subarray(0, 12));
    decipher.setAuthTag(payload.subarray(12, 28));
    const token = decipher.update(payload.subarray(28), undefined, 'utf8') +
      decipher.final('utf8');
    return token.length > 20 ? token : '';
  } catch { return ''; }
}

async function verifiedAccountProof(accessToken, secret) {
  const appId = process.env.FYERS_APP_ID || '';
  if (!appId || !accessToken)
    return { error: 'FYERS_PROFILE_NOT_CONFIGURED', status: 503 };

  const key = crypto.createHash('sha256').update(appId + ':' + accessToken).digest('hex');
  const cached = verifiedProfiles.get(key);
  if (cached?.expiresAt > Date.now()) return { proof: cached.proof };

  let response;
  try {
    response = await fetch(PROFILE_URL, {
      method: 'GET',
      headers: { Authorization: appId + ':' + accessToken },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
      redirect: 'error'
    });
  } catch { return { error: 'FYERS_PROFILE_UNAVAILABLE', status: 503 }; }

  if (!response.ok) return {
    error: response.status === 401 ? 'FYERS_SESSION_EXPIRED' : 'FYERS_PROFILE_UNAVAILABLE',
    status: response.status === 401 ? 401 : 503
  };

  const data = await response.json().catch(() => ({}));
  const fyId = data?.s === 'ok' && typeof data?.data?.fy_id === 'string'
    ? data.data.fy_id.trim() : '';
  if (!fyId || fyId.length > 128)
    return { error: 'FYERS_PROFILE_UNVERIFIED', status: 503 };

  const proof = crypto.createHmac('sha256', secret)
    .update('FYERS_OWNER_V1:' + fyId).digest('hex');

  // Bounded in-memory cache avoids repeating the FYERS profile request
  // on every poll and cannot outlive the serverless worker.
  if (verifiedProfiles.size >= 64) verifiedProfiles.clear();
  verifiedProfiles.set(key, { proof, expiresAt: Date.now() + 15 * 60000 });
  return { proof };
}

function sameOwner(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a || '') ||
      !/^[a-f0-9]{64}$/.test(b || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function signedAwsRequest(base, secret, action, method, body = '') {
  const endpoint = '/monitor/bridge/' + action;
  const time = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [
    time, nonce, method, endpoint,
    crypto.createHash('sha256').update(body).digest('hex')
  ].join('\n');
  const signature = crypto.createHmac('sha256', secret)
    .update(canonical).digest('hex');
  return fetch(base + endpoint, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-iom-time': time,
      'x-iom-nonce': nonce,
      'x-iom-signature': signature
    },
    body: method === 'POST' ? body : undefined,
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
    cache: 'no-store'
  });
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
  const token = decryptedFyersToken(request);
  if (!token) return reply(401, { error: 'FYERS_SESSION_REQUIRED' }, origin);

  const base = String(process.env.AWS_PAPER_SYNC_BASE || '').replace(/\/$/, '');
  const secret = process.env.AWS_PAPER_SYNC_SECRET || '';
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base) || secret.length < 32)
    return reply(503, { error: 'PAPER_SYNC_NOT_CONFIGURED' }, origin);

  const route = new URL(request.url).pathname;
  const action = route.endsWith('/sync') ? 'sync' : route.endsWith('/reconcile') ? 'reconcile' : route.endsWith('/status') ? 'status' : '';
  if (!action || (['sync', 'reconcile'].includes(action) && request.method !== 'POST') ||
      (action === 'status' && request.method !== 'GET'))
    return reply(404, { error: 'UNKNOWN_MONITOR_ROUTE' }, origin);


  const body = request.method === 'POST' ? await request.text() : '';
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES)
    return reply(413, { error: 'PAYLOAD_TOO_LARGE' }, origin);
  if (body) {
    try { if (!JSON.parse(body) || Array.isArray(JSON.parse(body))) throw Error(); }
    catch { return reply(400, { error: 'INVALID_JSON' }, origin); }
  }
  // Verify the current FYERS identity against the AWS instance's
  // pinned owner BEFORE returning sensitive status or forwarding writes.
  // The AWS owner proof is HMAC-SHA256(secret, 'FYERS_OWNER_V1:' + fy_id).
  try {
    const statusResponse = await signedAwsRequest(base, secret, 'status', 'GET');
    if (!statusResponse.ok)
      return reply(503, { error: 'AWS_OWNER_STATUS_UNAVAILABLE' }, origin);

    const statusData = await statusResponse.json().catch(() => ({}));
    const ownerProof = statusData?.paperOwnerProof;
    if (!/^[a-f0-9]{64}$/.test(ownerProof || ''))
      return reply(503, { error: 'PAPER_OWNER_NOT_CONFIGURED' }, origin);

    const account = await verifiedAccountProof(token, secret);
    if (account.error)
      return reply(account.status, { error: account.error }, origin);

    if (!sameOwner(ownerProof, account.proof))
      return reply(403, { error: 'FYERS_ACCOUNT_NOT_PAPER_OWNER' }, origin);

    if (action === 'status') {
      // Never expose the internal identity binding to the browser.
      const { paperOwnerProof: _privateProof, ...safeStatus } = statusData;
      return reply(200, safeStatus, origin);
    }

    const response = await signedAwsRequest(
      base, secret, action, request.method, body
    );
    const data = await response.json().catch(() => ({
      error: 'INVALID_AWS_RESPONSE'
    }));
    return reply(response.status, data, origin);
  } catch {
    return reply(503, { error: 'AWS_MONITOR_UNAVAILABLE' }, origin);
  }
}
