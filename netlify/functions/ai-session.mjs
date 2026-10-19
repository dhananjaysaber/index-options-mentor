import { constantEqual, issueAiSession, verifyAiSession } from '../../server/aiSessionAuth.mjs';

const SITE = 'https://dhananjaysaber.github.io';

function cors(request) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, private',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  if (request.headers.get('origin') === SITE) {
    headers['Access-Control-Allow-Origin'] = SITE;
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers.Vary = 'Origin';
  }
  return headers;
}

export default async function handler(request) {
  const reply = (body, code = 200) => new Response(JSON.stringify(body), { status: code, headers: cors(request) });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  if (process.env.TRADING_MODE !== 'paper' || process.env.LIVE_ORDER_EXECUTION_ENABLED !== 'false') {
    return reply({ error: 'Paper-only safety mode is not enabled' }, 503);
  }
  if (!process.env.MENTOR_AI_ACCESS_KEY || !process.env.FYERS_SESSION_SECRET) {
    return reply({ error: 'The private login is not configured on this backend' }, 503);
  }
  const contentLength = Number(request.headers.get('content-length') || 0);
  if (contentLength > 4096) return reply({ error: 'Request too large' }, 413);
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 4096) return reply({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch { return reply({ error: 'Invalid request' }, 400); }

  if (body?.action === 'login') {
    const provided = body?.password;
    if (typeof provided !== 'string' || provided.length > 512 ||
      !constantEqual(provided, process.env.MENTOR_AI_ACCESS_KEY)) {
      return reply({ error: 'Incorrect AI access password' }, 401);
    }
    const session = issueAiSession(body.remember === true);
    if (!session) return reply({ error: 'Unable to create a session' }, 503);
    return reply({ ok: true, ...session });
  }

  if (body?.action === 'verify') {
    const header = request.headers.get('authorization') || '';
    const result = header.startsWith('Bearer ') ? verifyAiSession(header.slice(7)) : { valid: false };
    return result.valid ? reply({ ok: true, ...result }) : reply({ error: 'Session expired or invalid' }, 401);
  }
  return reply({ error: 'Unknown action' }, 400);
}
