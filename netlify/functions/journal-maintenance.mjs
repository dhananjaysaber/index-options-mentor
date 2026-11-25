import { forwardToSheet, verifyMaintenance, SheetExportError } from './lib/journalBridge.mjs';

export default async function handler(request) {
  if (request.method !== 'POST') return Response.json({ ok: false }, { status: 405 });
  const body = await request.text();
  if (Buffer.byteLength(body) > 300000) return Response.json({ ok: false }, { status: 413 });
  if (!verifyMaintenance(request, body)) return Response.json({ ok: false }, { status: 401 });
  let payload;
  try { payload = JSON.parse(body); }
  catch { return Response.json({ ok: false }, { status: 400 }); }
  if (!['health', 'list_trades', 'journal_event', 'setup_decision', 'journal_receipt'].includes(payload?.action)) {
    return Response.json({ ok: false }, { status: 400 });
  }
  if (payload.action === 'journal_receipt') {
    const valid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(value);
    if (Object.keys(payload).some(key => !['action', 'tradeId', 'eventId'].includes(key)) ||
        !valid(payload.tradeId) || !valid(payload.eventId)) return Response.json({ ok: false }, { status: 400 });
  }
  try {
    return Response.json(await forwardToSheet(payload), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // Only our fixed categories leave the server; Google payloads stay private.
    const reason = error instanceof SheetExportError ? error.code : 'SHEETS_EXPORT_UNAVAILABLE';
    return Response.json({ ok: false, error: reason }, { status: 502 });
  }
}

export const config = { path: '/api/journal-maintenance' };
