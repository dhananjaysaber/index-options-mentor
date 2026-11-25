import crypto from 'node:crypto';

export function setting(name) {
  return globalThis.Netlify?.env?.get(name) ?? process.env[name] ?? '';
}

export function signedHeaders(path, body, secret = setting('AWS_PAPER_SYNC_SECRET')) {
  if (secret.length < 32) throw new Error('Journal bridge key is missing');
  const time = String(Date.now());
  const nonce = crypto.randomBytes(16).toString('hex');
  const canonical = [time, nonce, 'POST', path,
    crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  return {
    'content-type': 'application/json',
    'x-iom-time': time,
    'x-iom-nonce': nonce,
    'x-iom-signature': crypto.createHmac('sha256', secret).update(canonical).digest('hex')
  };
}

export async function forwardToSqlite(payload) {
  const base = setting('AWS_PAPER_SYNC_BASE').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) throw new Error('Invalid journal bridge URL');
  const path = '/journal/bridge';
  const body = JSON.stringify(payload);
  const response = await fetch(base + path, {
    method: 'POST', headers: signedHeaders(path, body), body,
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000)
  });
  const data = await response.json();
  if (!response.ok || !data?.ok) throw new Error('SQLite journal rejected the request');
  return { ...data, configured: true };
}

export class SheetExportError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export async function forwardToSheet(payload) {
  const url = setting('JOURNAL_WEB_APP_URL');
  const secret = setting('JOURNAL_SHARED_SECRET');
  if (!url.startsWith('https://script.google.com/') || !secret) {
    throw new SheetExportError('SHEETS_NOT_CONFIGURED');
  }
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, secret }), redirect: 'follow',
    signal: AbortSignal.timeout(45000)
  });
  if (!response.ok) throw new SheetExportError(`SHEETS_HTTP_${response.status}`);
  let data;
  try { data = await response.json(); }
  catch { throw new SheetExportError('SHEETS_NON_JSON_RESPONSE'); }
  if (!data?.ok) throw new SheetExportError('SHEETS_REJECTED_REQUEST');
  return data;
}

const nonces = new Map();

export function verifyMaintenance(request, body) {
  const secret = setting('AWS_PAPER_SYNC_SECRET');
  const time = request.headers.get('x-iom-time') || '';
  const nonce = request.headers.get('x-iom-nonce') || '';
  const supplied = request.headers.get('x-iom-signature') || '';
  if (secret.length < 32 || !/^\d{13}$/.test(time) || !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(supplied) || Math.abs(Date.now() - Number(time)) > 60000) return false;
  const incomingPath = new URL(request.url).pathname;
  if (!['/api/journal-maintenance', '/.netlify/functions/journal-maintenance'].includes(incomingPath)) return false;
  // Netlify may expose the internal function URL after routing the public path.
  // Both spellings authenticate the same fixed public operation.
  const path = '/api/journal-maintenance';
  const canonical = [time, nonce, 'POST', path,
    crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  const expected = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'))) return false;
  for (const [id, expires] of nonces) if (expires < Date.now()) nonces.delete(id);
  if (nonces.has(nonce) || nonces.size > 10000) return false;
  nonces.set(nonce, Date.now() + 120000);
  return true;
}
