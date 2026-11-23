import { forwardToSheet, verifyMaintenance } from './lib/journalBridge.mjs';

export default async function handler(request) {
  if (request.method !== 'POST') return Response.json({ ok: false }, { status: 405 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 300000) return Response.json({ ok: false }, { status: 413 });
  if (!verifyMaintenance(request, body)) return Response.json({ ok: false }, { status: 401 });
  let payload;
  try { payload = JSON.parse(body); }
  catch { return Response.json({ ok: false }, { status: 400 }); }
  if (!['health', 'list_trades', 'journal_event', 'setup_decision'].includes(payload?.action)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  try {
    return Response.json(await forwardToSheet(payload), { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'SHEETS_EXPORT_UNAVAILABLE' }, { status: 502 });
  }
}

export const config = { path: '/api/journal-maintenance' };
