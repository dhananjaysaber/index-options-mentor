import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import monitor from '../netlify/functions/monitor.mjs';

const BASE = 'https://deploy-preview-28--optionsmentor.netlify.app';
const AWS_URL = 'https://api.optionsmentor.in';
const SECRET = 'x'.repeat(64);
const SESSION_SECRET = 'test-fyers-session-secret-never-used-in-production';
const APP_ID = 'FAKEAPP-100';
const ACCOUNT_ID = 'FAKETESTUSER123';
const proof = id => crypto.createHmac('sha256', SECRET)
  .update('FYERS_OWNER_V1:' + id).digest('hex');

function encryptedSession(value = 'fake_fyers_token_for_unit_testing_long_enough') {
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function request(action, method = 'GET', token = '', body = { strategy: 'core' }, origin = 'https://dhananjaysaber.github.io') {
  return new Request(BASE + '/api/monitor/' + action, {
    method, headers: {
      origin,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {})
  });
}
async function withEnv(run) {
  const keys = ['FYERS_SESSION_SECRET', 'FYERS_APP_ID',
    'AWS_PAPER_SYNC_BASE', 'AWS_PAPER_SYNC_SECRET'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.FYERS_SESSION_SECRET = SESSION_SECRET;
  process.env.FYERS_APP_ID = APP_ID;
  process.env.AWS_PAPER_SYNC_BASE = AWS_URL;
  process.env.AWS_PAPER_SYNC_SECRET = SECRET;
  try { await run(); } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
function verifyAwsSignature(url, init) {
  const endpoint = new URL(url).pathname;
  const canonical = [
    init.headers['x-iom-time'],
    init.headers['x-iom-nonce'],
    init.method, endpoint,
    crypto.createHash('sha256').update(init.body || '').digest('hex')
  ].join('\n');
  assert.equal(init.headers['x-iom-signature'],
    crypto.createHmac('sha256', SECRET).update(canonical).digest('hex'));
}
function mockFetch({ ownerProof = proof(ACCOUNT_ID), fyId = ACCOUNT_ID } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://api-t1.fyers.in/api/v3/profile') {
      assert.equal(init.headers.Authorization.split(':')[0], APP_ID);
      return Response.json({ s: 'ok', data: { fy_id: fyId } });
    }
    assert.ok(url.startsWith(AWS_URL + '/monitor/bridge/'));
    verifyAwsSignature(url, init);
    if (url.endsWith('/status')) return Response.json({
      bridge: 'AUTHENTICATED', trading: 'DISABLED',
      paperOwnerProof: ownerProof, paperSync: { core: null, scalp: null, recentlyClosed: [] }
    });
    return Response.json({
      accepted: true, result: 'PAPER_POSITION_REGISTERED', trading: 'DISABLED'
    });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('rejects requests without a FYERS session', async () => {
  await withEnv(async () => {
    assert.equal((await monitor(request('status'))).status, 401);
    assert.equal((await monitor(request('status', 'GET', 'bad'))).status, 401);
  });
});

test('authenticated status matches the AWS owner and hides owner proof', async () => {
  await withEnv(async () => {
    const m = mockFetch();
    try {
      const response = await monitor(request('status', 'GET', encryptedSession()));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.bridge, 'AUTHENTICATED');
      assert.equal(body.paperOwnerProof, undefined);
      assert.equal(m.calls.filter(x => x.url.endsWith('/profile')).length, 1);
    } finally { m.restore(); }
  });
});

test('owner match allows signed paper open and reconcile', async () => {
  await withEnv(async () => {
    const m = mockFetch();
    try {
      for (const action of ['sync', 'reconcile']) {
        const response = await monitor(request(action, 'POST', encryptedSession()));
        assert.equal(response.status, 200);
      }
      assert.equal(m.calls.filter(x => x.url.endsWith('/sync') ||
        x.url.endsWith('/reconcile')).length, 2);
    } finally { m.restore(); }
  });
});

test('Netlify preview can sync using its own browser origin', async () => {
  await withEnv(async () => {
    const mock = mockFetch();
    try {
      const res = await monitor(request('sync', 'POST', encryptedSession(), { strategy: 'core' }, BASE));
      assert.ok(res.ok);
      assert.ok(mock.calls.some(call => call.url.endsWith('/sync')));
    } finally { mock.restore(); }
  });
});

test('wrong FYERS account cannot read status or write positions', async () => {
  await withEnv(async () => {
    const m = mockFetch({ ownerProof: proof('DIFFERENT_ACCOUNT') });
    try {
      const response = await monitor(request('status', 'GET', encryptedSession()));
      assert.equal(response.status, 403);
      const post = await monitor(request('sync', 'POST', encryptedSession()));
      assert.equal(post.status, 403);
      assert.equal(m.calls.filter(x => x.url.endsWith('/sync')).length, 0);
    } finally { m.restore(); }
  });
});

test('missing AWS owner proof refuses access', async () => {
  await withEnv(async () => {
    const m = mockFetch({ ownerProof: null });
    try {
      // undefined is handled as a deliberately absent/missing proof.
      const res = await monitor(request('status', 'GET', encryptedSession()));
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'PAPER_OWNER_NOT_CONFIGURED');
    } finally { m.restore(); }
  });
});

test('missing AWS secret fails closed', async () => {
  await withEnv(async () => {
    delete process.env.AWS_PAPER_SYNC_SECRET;
    const res = await monitor(request('status', 'GET', encryptedSession()));
    assert.equal(res.status, 503);
  });
});

test('disallowed browser origin is rejected', async () => {
  await withEnv(async () => {
    const res = await monitor(new Request(BASE + '/api/monitor/status', {
      headers: { origin: 'https://evil.example',
        Authorization: 'Bearer ' + encryptedSession() }
    }));
    assert.equal(res.status, 403);
  });
});
