const GITHUB_PAGES_ORIGIN = 'https://dhananjaysaber.github.io';

function corsOrigin(request) {
  const origin = request.headers.get('origin') || '';
  return origin === GITHUB_PAGES_ORIGIN ? origin : '';
}

function jsonResponse(body, status = 200, request = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  const origin = request ? corsOrigin(request) : '';
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function forwardToSheet(payload, request) {
  const webAppUrl = Netlify.env.get('JOURNAL_WEB_APP_URL');
  const sharedSecret = Netlify.env.get('JOURNAL_SHARED_SECRET');

  if (!webAppUrl || !sharedSecret) {
    return jsonResponse({ ok: false, configured: false, error: 'Journal is not configured.' }, 503, request);
  }

  try {
    const upstream = await fetch(webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, secret: sharedSecret }),
      redirect: 'follow'
    });

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch { data = { ok: false, error: 'Journal returned an unreadable response.' }; }

    if (!upstream.ok || !data?.ok) {
      return jsonResponse({ ok: false, configured: true, error: data?.error || 'Journal write failed.' }, 502, request);
    }

    return jsonResponse({ ...data, configured: true }, 200, request);
  } catch {
    return jsonResponse({ ok: false, configured: true, error: 'Journal is temporarily unavailable.' }, 502, request);
  }
}

export default async (request) => {
  if (request.method === 'OPTIONS') return jsonResponse({ ok: true }, 200, request);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    if (url.searchParams.get('health') === '1') {
      return forwardToSheet({ action: 'health' }, request);
    }

    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 500));
    return forwardToSheet({ action: 'list_trades', limit }, request);
  }

  if (request.method === 'POST') {
    let body;
    try {
      const raw = await request.text();
      if (raw.length > 300000) return jsonResponse({ ok: false, error: 'Journal event is too large.' }, 413, request);
      body = JSON.parse(raw || '{}');
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid journal request.' }, 400, request);
    }

    if (body?.action === 'journal_event') {
      if (!body?.event?.trade?.id || !body?.event?.type) {
        return jsonResponse({ ok: false, error: 'Journal event is incomplete.' }, 400, request);
      }
      return forwardToSheet({ action: 'journal_event', event: body.event }, request);
    }

    if (body?.action === 'setup_decision') {
      if (!body?.setup?.id || !body?.setup?.sessionDate || !body?.setup?.side) {
        return jsonResponse({ ok: false, error: 'Setup decision is incomplete.' }, 400, request);
      }
      return forwardToSheet({ action: 'setup_decision', setup: body.setup }, request);
    }

    return jsonResponse({ ok: false, error: 'Unknown journal action.' }, 400, request);
  }

  return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405, request);
};

export const config = {
  path: '/api/journal'
};
