import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedInCookie } from './helpers/appSession.mjs';
import journal from '../netlify/functions/journal.mjs';
import maintenance from '../netlify/functions/journal-maintenance.mjs';
import { signedHeaders, verifyMaintenance } from '../netlify/functions/lib/journalBridge.mjs';

const cookie = await signedInCookie();

test('SQLite gateway signs writes and preserves browser retry on failed commit', async () => {
  const saved = globalThis.fetch;
  const environment = { ...process.env };
  process.env.JOURNAL_STORAGE = 'sqlite';
  process.env.AWS_PAPER_SYNC_BASE = 'https://api.optionsmentor.in';
  process.env.AWS_PAPER_SYNC_SECRET = 'test-key-'.repeat(8);
  const payload = { action: 'journal_event', event: { id: 'close:fixture', type: 'TRADE_CLOSED', trade: { id: 'fixture' } } };
  try {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.optionsmentor.in/journal/bridge');
      const headers = init.headers;
      const canonical = [headers['x-iom-time'], headers['x-iom-nonce'], 'POST', '/journal/bridge',
        crypto.createHash('sha256').update(init.body).digest('hex')].join('\n');
      assert.equal(headers['x-iom-signature'], crypto.createHmac('sha256', process.env.AWS_PAPER_SYNC_SECRET).update(canonical).digest('hex'));
      assert.deepEqual(JSON.parse(init.body), payload);
      return Response.json({ ok: true, tradeId: 'fixture' });
    };
    const request = () => new Request('https://optionsmentor.netlify.app/api/journal', {
      method: 'POST', body: JSON.stringify(payload), headers: { origin: 'https://optionsmentor.netlify.app', cookie }
    });
    const result = await journal(request());
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal((await result.json()).tradeId, 'fixture');
    assert.equal(calls, 1);
    globalThis.fetch = async () => { throw Error('offline'); };
    const failed = await journal(request());
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).ok, false);
  } finally {
    globalThis.fetch = saved;
    for (const name of ['JOURNAL_STORAGE', 'AWS_PAPER_SYNC_BASE', 'AWS_PAPER_SYNC_SECRET']) {
      if (environment[name] === undefined) delete process.env[name];
      else process.env[name] = environment[name];
    }
  }
});

test('Sheets maintenance rejects unsigned requests and forwards only valid signed actions', async () => {
  const saved = globalThis.fetch;
  const environment = { ...process.env };
  process.env.AWS_PAPER_SYNC_SECRET = 'test-key-'.repeat(8);
  process.env.JOURNAL_WEB_APP_URL = 'https://script.google.com/macros/s/fixture/exec';
  process.env.JOURNAL_SHARED_SECRET = 'sheet-test-secret';
  const url = 'https://optionsmentor.netlify.app/api/journal-maintenance';
  const body = JSON.stringify({ action: 'health' });
  try {
    assert.equal((await maintenance(new Request(url, { method: 'POST', body }))).status, 401);
    globalThis.fetch = async (upstream, init) => {
      assert.equal(upstream, process.env.JOURNAL_WEB_APP_URL);
      assert.equal(JSON.parse(init.body).secret, 'sheet-test-secret');
      return Response.json({ ok: true, trades: 5 });
    };
    const headers = signedHeaders('/api/journal-maintenance', body);
    const result = await maintenance(new Request(url, { method: 'POST', body, headers }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).trades, 5);
    assert.equal((await maintenance(new Request(url, { method: 'POST', body, headers }))).status, 401);
    const invalid = JSON.stringify({ action: 'unknown' });
    assert.equal((await maintenance(new Request(url, { method: 'POST', body: invalid,
      headers: signedHeaders('/api/journal-maintenance', invalid) }))).status, 400);
  } finally {
    globalThis.fetch = saved;
    for (const name of ['AWS_PAPER_SYNC_SECRET', 'JOURNAL_WEB_APP_URL', 'JOURNAL_SHARED_SECRET']) {
      if (environment[name] === undefined) delete process.env[name];
      else process.env[name] = environment[name];
    }
  }
});


test('maintenance signatures survive Netlify rewriting without accepting other paths or body changes', () => {
  const original = process.env.AWS_PAPER_SYNC_SECRET;
  process.env.AWS_PAPER_SYNC_SECRET = 'rewrite-fixture-'.repeat(4);
  const body = JSON.stringify({ action: 'health' });
  const path = '/api/journal-maintenance';
  try {
    const headers = signedHeaders(path, body);
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/.netlify/functions/journal-maintenance',
      { method: 'POST', body, headers }), body), true);
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
      { method: 'POST', body, headers }), body), false, 'same nonce remains rejected across aliases');
    const otherHeaders = signedHeaders(path, body);
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/api/other',
      { method: 'POST', body, headers: otherHeaders }), body), false);
    const tampered = JSON.stringify({ action: 'list_trades', limit: 1000 });
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
      { method: 'POST', body: tampered, headers: otherHeaders }), tampered), false);
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
      { method: 'POST', body, headers: otherHeaders }), body), true);
    assert.equal(verifyMaintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
      { method: 'POST', body, headers: signedHeaders('/api/other', body) }), body), false);
  } finally {
    if (original === undefined) delete process.env.AWS_PAPER_SYNC_SECRET;
    else process.env.AWS_PAPER_SYNC_SECRET = original;
  }
});


test('maintenance reports private-safe export failure categories', async () => {
  const fetchSaved = globalThis.fetch;
  const env = { ...process.env };
  process.env.AWS_PAPER_SYNC_SECRET = 'redaction-fixture-'.repeat(4);
  process.env.JOURNAL_WEB_APP_URL = 'https://script.google.com/macros/s/fixture/exec';
  process.env.JOURNAL_SHARED_SECRET = 'never-return-this-secret';
  const body = JSON.stringify({ action: 'health' });
  try {
    for (const [response, reason] of [
      [new Response('private account information', { status: 403 }), 'SHEETS_HTTP_403'],
      [new Response('<html>private login page</html>'), 'SHEETS_NON_JSON_RESPONSE'],
      [Response.json({ ok: false, error: 'never-return-this-secret' }), 'SHEETS_REJECTED_REQUEST'],
    ]) {
      globalThis.fetch = async () => response;
      const result = await maintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
        { method: 'POST', body, headers: signedHeaders('/api/journal-maintenance', body) }));
      assert.equal(result.status, 502);
      assert.deepEqual(await result.json(), { ok: false, error: reason });
    }
  } finally {
    globalThis.fetch = fetchSaved;
    for (const name of ['AWS_PAPER_SYNC_SECRET', 'JOURNAL_WEB_APP_URL', 'JOURNAL_SHARED_SECRET']) {
      if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    }
  }
});


test('only a signed, valid read-only identifier receipt is forwarded to Sheets', async () => {
  const savedFetch=globalThis.fetch, env={...process.env};
  process.env.AWS_PAPER_SYNC_SECRET='receipt-key-'.repeat(5);
  process.env.JOURNAL_WEB_APP_URL='https://script.google.com/macros/s/fixture/exec';
  process.env.JOURNAL_SHARED_SECRET='receipt-sheet-key';
  let forwarded=0;
  globalThis.fetch=async (url,init)=>{
    const body=JSON.parse(init.body);forwarded++;
    assert.equal(body.action,'journal_receipt');assert.equal(body.tradeId,'trade-id');
    assert.equal(body.eventId,'sqlite:trade-id:1');
    return Response.json({ok:true,complete:true,tradeId:body.tradeId,eventId:body.eventId});
  };
  const payload={action:'journal_receipt',tradeId:'trade-id',eventId:'sqlite:trade-id:1'};
  async function send(value,signed=true){const body=JSON.stringify(value);return maintenance(new Request('https://optionsmentor.netlify.app/api/journal-maintenance',
    {method:'POST',body,headers:signed?signedHeaders('/api/journal-maintenance',body):{}}));}
  try {
    assert.equal((await send(payload,false)).status,401);
    assert.equal((await send({...payload,tradeId:'../invalid'})).status,400);
    assert.equal((await send({...payload,extra:'not-allowed'})).status,400);
    assert.equal((await send(payload)).status,200);
    assert.equal(forwarded,1);
  }finally{
    globalThis.fetch=savedFetch;
    for(const name of ['AWS_PAPER_SYNC_SECRET','JOURNAL_WEB_APP_URL','JOURNAL_SHARED_SECRET']){
      if(env[name]===undefined)delete process.env[name];else process.env[name]=env[name];
    }
  }
});
