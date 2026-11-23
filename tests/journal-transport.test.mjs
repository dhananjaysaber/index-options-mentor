import test from 'node:test';
import assert from 'node:assert/strict';
import { sendJournalWrite, journalTransportState } from '../src/services/journalTransport.js';

test('journal writes are serialized and preserve event payloads', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Response.json({ ok: true });
  };
  try {
    const a = sendJournalWrite({ action: 'journal_event', event: { id: 'trade-open-1' } });
    const b = sendJournalWrite({ action: 'setup_decision', setup: { id: 'setup-1' } });
    const r = await Promise.all([a, b]);
    assert.equal(r[0].status, 200);
    assert.equal(r[1].status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.event.id, 'trade-open-1');
    assert.equal(calls[1].body.setup.id, 'setup-1');
    assert.equal(journalTransportState().failures, 0);
  } finally { globalThis.fetch = original; }
});

test('failed journal request enters cooldown and does not flood Google Sheets', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ ok: false }, { status: 502 }); };
  try {
    const response = await sendJournalWrite({ action: 'journal_event', event: { id: 'bad-1' } });
    assert.equal(response.status, 502);
    assert.ok(journalTransportState().cooldownUntil > Date.now());
    await assert.rejects(() => sendJournalWrite({
      action: 'journal_event', event: { id: 'bad-2' }
    }), /JOURNAL_RETRY_COOLDOWN/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
