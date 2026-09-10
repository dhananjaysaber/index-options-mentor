import crypto from 'node:crypto';
import { buildMentorSnapshot, dateDaysAgoIST, dateKeyIST } from '../../server/mentor.js';

const COOKIE_NAME = 'iom_fyers_session';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const DATA_BASE = 'https://api-t1.fyers.in/data';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

function appId() {
  return process.env.FYERS_APP_ID || '';
}

function appSecret() {
  return process.env.FYERS_APP_SECRET || '';
}

function sessionSecret() {
  return process.env.FYERS_SESSION_SECRET || '';
}

function redirectUri(request) {
  if (process.env.FYERS_REDIRECT_URI) return process.env.FYERS_REDIRECT_URI;
  const origin = new URL(request.url).origin;
  return `${origin}/api/fyers/callback`;
}

function configured(request) {
  return Boolean(appId() && appSecret() && sessionSecret() && redirectUri(request));
}

function authHeader(accessToken) {
  return `${appId()}:${accessToken}`;
}

async function fyersGet(path, params, accessToken) {
  const url = new URL(`${DATA_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader(accessToken),
      'Content-Type': 'application/json',
      version: '3'
    }
  });

  const data = await response.json().catch(() => ({
    s: 'error',
    code: response.status,
    message: 'FYERS returned an unreadable response.'
  }));

  if (!response.ok && data?.s !== 'error') {
    data.s = 'error';
    data.code = response.status;
  }
  return data;
}

function loginUrl(request) {
  const url = new URL(`${API_BASE}/generate-authcode`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', crypto.randomBytes(12).toString('hex'));
  return url.toString();
}

async function exchangeAuthCode(authCode) {
  const appIdHash = crypto
    .createHash('sha256')
    .update(`${appId()}:${appSecret()}`)
    .digest('hex');

  const response = await fetch(`${API_BASE}/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      appIdHash,
      code: authCode
    })
  });

  return response.json();
}

function cookieMap(request) {
  const raw = request.headers.get('cookie') || '';
  const out = {};
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function encryptionKey() {
  if (!sessionSecret()) return null;
  return crypto.createHash('sha256').update(sessionSecret()).digest();
}

function encryptToken(text) {
  const key = encryptionKey();
  if (!key) throw new Error('FYERS_SESSION_SECRET is not configured.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptToken(payload) {
  if (!payload) return '';
  const key = encryptionKey();
  if (!key) return '';
  try {
    const raw = Buffer.from(payload, 'base64url');
    if (raw.length < 29) return '';
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function accessTokenFromRequest(request) {
  return decryptToken(cookieMap(request)[COOKIE_NAME]);
}

function setSessionCookie(value, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=43200`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0`;
}

function requireToken(request) {
  const token = accessTokenFromRequest(request);
  if (!token) return { error: json({ error: 'Connect FYERS first.' }, 401) };
  return { token };
}

function routeName(request) {
  const pathname = new URL(request.url).pathname;
  const markers = ['/api/fyers/', '/.netlify/functions/fyers/'];
  for (const marker of markers) {
    const index = pathname.indexOf(marker);
    if (index >= 0) return pathname.slice(index + marker.length).replace(/^\/+|\/+$/g, '');
  }
  return '';
}

async function handleStatus(request) {
  return json({
    configured: configured(request),
    authenticated: Boolean(accessTokenFromRequest(request)),
    redirectUri: redirectUri(request),
    runtime: 'netlify-functions-rest'
  });
}

async function handleLogin(request) {
  if (!configured(request)) {
    return json({ error: 'FYERS environment variables are not configured on Netlify.' }, 400);
  }
  return Response.redirect(loginUrl(request), 302);
}

async function handleCallback(request) {
  const url = new URL(request.url);
  const authCode = url.searchParams.get('auth_code');
  if (!authCode) return new Response('FYERS did not return an auth code.', { status: 400 });

  try {
    const response = await exchangeAuthCode(authCode);

    if (response?.s !== 'ok' || !response?.access_token) {
      console.error('FYERS token response:', response);
      return new Response('FYERS login could not be completed.', { status: 400 });
    }

    const encrypted = encryptToken(response.access_token);
    const destination = `${url.origin}/?fyers=connected`;
    return new Response(null, {
      status: 302,
      headers: {
        location: destination,
        'set-cookie': setSessionCookie(encrypted, request),
        'cache-control': 'no-store'
      }
    });
  } catch (error) {
    console.error('FYERS callback failed:', error);
    return new Response('FYERS login failed.', { status: 500 });
  }
}

async function handleLogout(request) {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${new URL(request.url).origin}/`,
      'set-cookie': clearSessionCookie(request),
      'cache-control': 'no-store'
    }
  });
}

async function handleQuote(request) {
  const auth = requireToken(request);
  if (auth.error) return auth.error;

  const raw = new URL(request.url).searchParams.get('symbol') || 'NSE:NIFTY50-INDEX';
  const symbols = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);

  try {
    return json(await fyersGet('/quotes', { symbols: symbols.join(',') }, auth.token));
  } catch (error) {
    console.error('Quote failed:', error);
    return json({ error: 'Could not load quote.' }, 500);
  }
}

async function handleHistory(request) {
  const auth = requireToken(request);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol') || 'NSE:NIFTY50-INDEX';
  const resolution = url.searchParams.get('resolution') || '5';
  const today = dateKeyIST();

  try {
    return json(await fyersGet('/history', {
      symbol,
      resolution,
      date_format: '1',
      range_from: url.searchParams.get('from') || today,
      range_to: url.searchParams.get('to') || today,
      cont_flag: '1'
    }, auth.token));
  } catch (error) {
    console.error('History failed:', error);
    return json({ error: 'Could not load historical candles.' }, 500);
  }
}

async function handleOptionChain(request) {
  const auth = requireToken(request);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const symbol = url.searchParams.get('symbol') || 'NSE:NIFTY50-INDEX';
  const strikecount = Number(url.searchParams.get('strikecount') || 10);

  try {
    return json(await fyersGet('/options-chain-v3', {
      symbol,
      strikecount,
      timestamp: url.searchParams.get('timestamp') || '',
      greeks: '1'
    }, auth.token));
  } catch (error) {
    console.error('Option chain failed:', error);
    return json({ error: 'Could not load option chain.' }, 500);
  }
}

async function handleMentorSnapshot(request) {
  const auth = requireToken(request);
  if (auth.error) return auth.error;

  try {
    const today = dateKeyIST();
    const from = dateDaysAgoIST(8);

    const [quoteResponse, historyResponse, chainResponse] = await Promise.all([
      fyersGet('/quotes', { symbols: 'NSE:NIFTY50-INDEX' }, auth.token),
      fyersGet('/history', {
        symbol: 'NSE:NIFTY50-INDEX',
        resolution: '5',
        date_format: '1',
        range_from: from,
        range_to: today,
        cont_flag: '1'
      }, auth.token),
      fyersGet('/options-chain-v3', {
        symbol: 'NSE:NIFTY50-INDEX',
        strikecount: 12,
        greeks: '1'
      }, auth.token)
    ]);

    return json(await buildMentorSnapshot({
      quoteResponse,
      historyResponse,
      chainResponse,
      now: new Date()
    }));
  } catch (error) {
    console.error('Mentor snapshot failed:', error);
    return json({
      error: 'The live mentor snapshot could not be calculated.',
      detail: error?.message || 'Unknown error'
    }, 500);
  }
}

export default async (request) => {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);

  const route = routeName(request);
  switch (route) {
    case 'status': return handleStatus(request);
    case 'login': return handleLogin(request);
    case 'callback': return handleCallback(request);
    case 'logout': return handleLogout(request);
    case 'quote': return handleQuote(request);
    case 'history': return handleHistory(request);
    case 'option-chain': return handleOptionChain(request);
    case 'mentor-snapshot': return handleMentorSnapshot(request);
    default: return json({ error: 'Unknown FYERS route.' }, 404);
  }
};
