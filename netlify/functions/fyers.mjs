import crypto from 'node:crypto';
import { runStockScan } from '../../server/stockScanner.mjs';
import { classifyFyersFailure } from './fyersErrors.mjs';
import { buildMentorSnapshot, dateDaysAgoIST, dateKeyIST } from '../../server/mentor.js';

const COOKIE_NAME = 'iom_fyers_session';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const DATA_BASE = 'https://api-t1.fyers.in/data';
const DIRECTIONAL_PARAMETER_IDS = new Set(['trend', 'vwap', 'risk', 'liquidity', 'orb', 'close', 'retest', 'pd', 'htf']);
const GITHUB_PAGES_ORIGIN = 'https://dhananjaysaber.github.io';
const GITHUB_PAGES_PATHS = ['/index-options-mentor-pwa/', '/index-options-mentor/'];
const researchHistoryCache = new Map();

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

function appId() { return process.env.FYERS_APP_ID || ''; }
function appSecret() { return process.env.FYERS_APP_SECRET || ''; }
function sessionSecret() { return process.env.FYERS_SESSION_SECRET || ''; }

function redirectUri(request) {
  if (process.env.FYERS_REDIRECT_URI) return process.env.FYERS_REDIRECT_URI;
  const origin = new URL(request.url).origin;
  return `${origin}/api/fyers/callback`;
}

function configured(request) {
  return Boolean(appId() && appSecret() && sessionSecret() && redirectUri(request));
}

function authHeader(accessToken) { return `${appId()}:${accessToken}`; }

async function fyersGet(path, params, accessToken) {
  const url = new URL(`${DATA_BASE}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: {
      Authorization: authHeader(accessToken),
      'Content-Type': 'application/json',
      version: '3'
    }
  });

  const data = await response.json().catch(() => ({ s: 'error', code: response.status, message: 'FYERS returned an unreadable response.' }));
  if (!response.ok || data?.s === 'error') {
    const failure = classifyFyersFailure(response.status, data, path.replace(/^\//, ''));
    throw Object.assign(new Error(failure.error), failure);
  }
  return data;
}

function loginUrl(request) {
  const requestUrl = new URL(request.url);
  const url = new URL(`${API_BASE}/generate-authcode`);
  url.searchParams.set('client_id', appId());
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', makeState(requestUrl.searchParams.get('returnTo'), requestUrl.origin));
  return url.toString();
}

function makeState(returnTo, backendOrigin) {
  const safeReturnTo = validateReturnTo(returnTo, backendOrigin) || `${backendOrigin}/`;
  const payload = Buffer.from(JSON.stringify({ returnTo: safeReturnTo, nonce: crypto.randomBytes(12).toString('hex') })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readState(value, backendOrigin) {
  if (!value || !sessionSecret()) return `${backendOrigin}/`;
  try {
    const [payload, signature] = String(value).split('.');
    if (!payload || !signature) return `${backendOrigin}/`;
    const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return `${backendOrigin}/`;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return validateReturnTo(parsed?.returnTo, backendOrigin) || `${backendOrigin}/`;
  } catch {
    return `${backendOrigin}/`;
  }
}

function validateReturnTo(value, backendOrigin) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.origin === backendOrigin) return url.toString();
    if (url.origin === GITHUB_PAGES_ORIGIN && GITHUB_PAGES_PATHS.some(path => url.pathname.startsWith(path))) return url.toString();
  } catch {}
  return '';
}

async function exchangeAuthCode(authCode) {
  const appIdHash = crypto.createHash('sha256').update(`${appId()}:${appSecret()}`).digest('hex');
  const response = await fetch(`${API_BASE}/validate-authcode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', appIdHash, code: authCode })
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
  const authorization = request.headers.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) {
    const token = decryptToken(authorization.replace(/^Bearer\s+/i, '').trim());
    if (token) return token;
  }
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

function normalisePendingDirection(snapshot) {
  if (!snapshot?.decision || snapshot.decision.side || !Array.isArray(snapshot.parameters) || !snapshot.parameters.length) return snapshot;
  const regime = snapshot.parameters.find(row => row.id === 'chop');
  const regimeWeak = regime && Number(regime.value) < 0.58;

  return {
    ...snapshot,
    decision: {
      ...snapshot.decision,
      score: null,
      rr: 0,
      availableRR: 0,
      canSuggestTrade: false,
      reasons: [
        'Direction is not clear enough yet, so directional checks are waiting rather than failing.',
        ...(regimeWeak ? ['Market movement is also choppy, so the mentor is protecting capital.'] : []),
        'Wait for trend and VWAP to agree before judging a CE or PE setup.'
      ]
    },
    parameters: snapshot.parameters.map(row => DIRECTIONAL_PARAMETER_IDS.has(row.id)
      ? { ...row, assessable: false, weighted: 0, status: 'pending', gatePassed: row.mandatory ? null : row.gatePassed }
      : { ...row, assessable: true }),
    structure: {
      ...snapshot.structure,
      breakoutDetected: false,
      closeConfirmed: false,
      spotBeyondTrigger: false,
      trigger: null,
      retestFound: false,
      retestFailed: false,
      underlyingStop: null,
      underlyingTarget: null,
      riskPoints: 0
    },
    setup: {
      ...snapshot.setup,
      biasReady: false,
      mandatoryReady: false,
      breakoutDetected: false,
      closeConfirmed: false,
      retestStatus: 'NOT_STARTED',
      approvalReady: false
    },
    option: null
  };
}

function dateKeyForIST(value) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return year && month && day ? year + '-' + month + '-' + day : '';
}

function dateMonthsAgoIST(months) {
  const now = new Date();
  const shifted = new Date(now.getTime());
  shifted.setUTCMonth(shifted.getUTCMonth() - Math.max(1, Math.min(6, Number(months) || 6)));
  return dateKeyForIST(shifted);
}

function addDaysIST(dateKey, days) {
  const date = new Date(dateKey + 'T00:00:00+05:30');
  date.setTime(date.getTime() + Number(days || 0) * 86400000);
  return dateKeyForIST(date);
}

function buildHistoryChunks(from, to, chunkDays = 55) {
  const chunks = [];
  let cursor = from;
  while (cursor && cursor <= to) {
    const candidateEnd = addDaysIST(cursor, chunkDays - 1);
    const end = candidateEnd > to ? to : candidateEnd;
    chunks.push({ from: cursor, to: end });
    if (end >= to) break;
    cursor = addDaysIST(end, 1);
  }
  return chunks;
}

function dedupeCandles(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || !Number.isFinite(Number(row[0]))) continue;
    map.set(Number(row[0]), row);
  }
  return [...map.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
}

async function fetchHistoryChunks(resolution, from, to, accessToken) {
  const chunks = buildHistoryChunks(from, to);
  const responses = await Promise.all(chunks.map(chunk => fyersGet('/history', {
    symbol: 'NSE:NIFTY50-INDEX',
    resolution,
    date_format: '1',
    range_from: chunk.from,
    range_to: chunk.to,
    cont_flag: '1'
  }, accessToken)));

  const candles = [];
  for (const response of responses) {
    if (response?.s === 'error') {
      throw new Error(response?.message || 'FYERS historical data request failed.');
    }
    if (Array.isArray(response?.candles)) candles.push(...response.candles);
  }
  return dedupeCandles(candles);
}

function fyersFailureResponse(error, fallback = 'FYERS market data is temporarily unavailable.') {
  if (error?.status && error?.code) {
    return json({
      error: error.error || fallback,
      code: error.code,
      authRequired: error.authRequired === true,
      limitScope: error.limitScope || null,
      detail: error.detail || ''
    }, error.status);
  }
  const noCandles = /No regular-session 5-minute candles/i.test(error?.message || '');
  return json({
    error: noCandles
      ? 'Valid 5-minute candles are not available from FYERS. New entries are paused until data returns.'
      : fallback,
    code: noCandles ? 'FYERS_CANDLES_UNAVAILABLE' : 'FYERS_DATA_UNAVAILABLE',
    authRequired: false,
    detail: String(error?.message || 'Unknown data error').slice(0, 240)
  }, 503);
}

async function handleStatus(request) {
  const token = accessTokenFromRequest(request);
  let authenticated = Boolean(token);
  let authRequired = false;
  let verified = false;
  if (token) {
    try {
      // A saved encrypted token is not proof that FYERS still accepts it.
      await fyersGet('/quotes', { symbols: 'NSE:NIFTY50-INDEX' }, token);
      verified = true;
    } catch (error) {
      if (error?.authRequired) {
        authenticated = false;
        authRequired = true;
      }
      // A temporary network / rate-limit error does not prove expiry.
    }
  }
  return json({
    configured: configured(request),
    authenticated,
    authRequired,
    verified,
    redirectUri: redirectUri(request),
    runtime: 'netlify-functions-rest'
  });
}

async function handleLogin(request) {
  if (!configured(request)) return json({ error: 'FYERS environment variables are not configured on Netlify.' }, 400);
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
    const returnTo = readState(url.searchParams.get('state'), url.origin);
    const destination = new URL(returnTo);
    destination.searchParams.set('fyers', 'connected');
    if (destination.origin === GITHUB_PAGES_ORIGIN) destination.hash = `fyers_session=${encodeURIComponent(encrypted)}`;

    return new Response(null, {
      status: 302,
      headers: {
        location: destination.toString(),
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
    return fyersFailureResponse(error, 'Could not load quote.');
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
    return fyersFailureResponse(error, 'Could not load historical candles.');
  }
}

async function handleResearchHistory(request) {
  const auth = requireToken(request);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const months = Math.max(1, Math.min(6, Number(url.searchParams.get('months')) || 6));
  const requestedResolution = String(url.searchParams.get('resolution') || 'both').toLowerCase();
  const resolution = requestedResolution === '5' || requestedResolution === '3' ? requestedResolution : 'both';
  const to = dateKeyIST();
  const from = dateMonthsAgoIST(months);
  const cacheKey = months + ':' + resolution + ':' + from + ':' + to;
  const cached = researchHistoryCache.get(cacheKey);
  if (cached?.data && Date.now() - cached.at < 10 * 60 * 1000) return json(cached.data);

  try {
    let fiveMinute = [];
    let threeMinute = [];

    if (resolution === '5') {
      fiveMinute = await fetchHistoryChunks('5', from, to, auth.token);
    } else if (resolution === '3') {
      threeMinute = await fetchHistoryChunks('3', from, to, auth.token);
    } else {
      [fiveMinute, threeMinute] = await Promise.all([
        fetchHistoryChunks('5', from, to, auth.token),
        fetchHistoryChunks('3', from, to, auth.token)
      ]);
    }

    const data = {
      ok: true,
      source: 'FYERS historical candles',
      symbol: 'NSE:NIFTY50-INDEX',
      months,
      from,
      to,
      resolution,
      ...(resolution !== '3' ? { fiveMinute } : {}),
      ...(resolution !== '5' ? { threeMinute } : {}),
      generatedAt: new Date().toISOString(),
      note: 'NIFTY candles only. No historical option chain, Greeks or bid/ask data are fabricated.'
    };

    researchHistoryCache.set(cacheKey, { at: Date.now(), data });
    if (researchHistoryCache.size > 12) {
      const oldest = [...researchHistoryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) researchHistoryCache.delete(oldest);
    }
    return json(data);
  } catch (error) {
    console.error('Research history failed:', error);
    if (error?.status && error?.code) return fyersFailureResponse(error, 'Could not load research history.');
    return json({
      error: 'Could not load the historical NIFTY research dataset.',
      detail: error?.message || 'Unknown error'
    }, 502);
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
    return fyersFailureResponse(error, 'Could not load option chain.');
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

    const snapshot = await buildMentorSnapshot({ quoteResponse, historyResponse, chainResponse, now: new Date() });
    return json(normalisePendingDirection(snapshot));
  } catch (error) {
    console.error('Mentor snapshot failed:', error);
    return fyersFailureResponse(error, 'The live mentor snapshot could not be calculated. Live entries remain paused until data returns.');
  }
}

async function handleStockScanner(request) {
  // Keep the public scanner unavailable on unrelated hosts and provide a
  // one-switch rollback without touching Index or Scalp.
  const setting = process.env.STOCK_SCANNER_ENABLED;
  const productionHost = new URL(request.url).hostname === 'optionsmentor.netlify.app';
  if (setting === 'false' || (setting !== 'true' && !productionHost)) {
    return json({ error: 'Stock scanner is disabled.' }, 404);
  }
  const auth = requireToken(request);
  if (auth.error) return auth.error;
  try {
    const scope = crypto.createHash('sha256').update(auth.token).digest('hex');
    return json(await runStockScan((path, params) => fyersGet(path, params, auth.token), scope));
  } catch (error) {
    console.error('Stock scan unavailable:', error?.code || error?.message);
    return fyersFailureResponse(error, 'Stock scanner data is temporarily unavailable.');
  }
}

function corsOrigin(request) {
  const origin = request.headers.get('origin') || '';
  if (origin === GITHUB_PAGES_ORIGIN) return origin;
  return '';
}

function withCors(response, request) {
  const origin = corsOrigin(request);
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), request);
  }
  if (request.method !== 'GET') return withCors(json({ error: 'Method not allowed.' }, 405), request);

  const route = routeName(request);
  let response;
  switch (route) {
    case 'status': response = await handleStatus(request); break;
    case 'login': response = await handleLogin(request); break;
    case 'callback': response = await handleCallback(request); break;
    case 'logout': response = await handleLogout(request); break;
    case 'quote': response = await handleQuote(request); break;
    case 'history': response = await handleHistory(request); break;
    case 'research-history': response = await handleResearchHistory(request); break;
    case 'option-chain': response = await handleOptionChain(request); break;
    case 'mentor-snapshot': response = await handleMentorSnapshot(request); break;
    case 'stock-scanner': response = await handleStockScanner(request); break;
    default: response = json({ error: 'Unknown FYERS route.' }, 404);
  }
  return withCors(response, request);
};
