import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import monitor from '../netlify/functions/monitor.mjs';

const BASE = 'https://deploy-preview-28--optionsmentor.netlify.app';
const PASS = 'x'.repeat(64);
const SESSION_SECRET = 'test-fyers-session-secret-never-used-in-production';

function encryptedFyersSession(value = 'example_fyers_token_just_for_gateway_unit_testing') {
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

function request(path, method = 'GET', token = '') {
  return new Request(BASE + '/api/monitor/' + path, {
    method,
    headers: {
      origin: 'https://dhananjaysaber.github.io',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
    },
    ...(method === 'POST' ? { body: JSON.stringify({ strategy: 'core' }) } : {})
  });
}

async function withEnv(callback) {
  const keys = ['FYERS_SESSION_SECRET', 'AWS_PAPER_SYNC_BASE', 'AWS_PAPER_SYNC_SECRET'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.FYERS_SESSION_SECRET = SESSION_SECRET;
  process.env.AWS_PAPER_SYNC_BASE = 'https://api.optionsmentor.in';
  process.env.AWS_PAPER_SYNC_SECRET = PASS;
  try { await callback(); } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('paper monitor gateway rejects missing browser session', async () => {
  await withEnv(async () => {
    const res = await monitor(request('status'));
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'FYERS_SESSION_REQUIRED');
  });
});

test('paper monitor gateway rejects malformed browser session', async () => {
  await withEnv(async () => {
    const res = await monitor(request('status', 'GET', 'not-a-session'));
    assert.equal(res.status, 401);
  });
});

test('paper monitor gateway signs and forwards authenticated status', async () => {
  await withEnv(async () => {
    const previous = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.optionsmentor.in/monitor/bridge/status');
      assert.equal(init.method, 'GET');
      const canonical = [
        init.headers['x-iom-time'],
        init.headers['x-iom-nonce'],
        'GET',
        '/monitor/bridge/status',
        crypto.createHash('sha256').update('').digest('hex')
      ].join('\n');
      const wanted = crypto.createHmac('sha256', PASS).update(canonical).digest('hex');
      assert.equal(init.headers['x-iom-signature'], wanted);
      return Response.json({ bridge: 'AUTHENTICATED', trading: 'DISABLED' });
    };
    try {
      const res = await monitor(request('status', 'GET', encryptedFyersSession()));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).bridge, 'AUTHENTICATED');
      assert.equal(calls, 1);
    } finally { globalThis.fetch = previous; }
  });
});

test('paper monitor gateway forwards signed reconciliation body', async () => {
  await withEnv(async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'https://api.optionsmentor.in/monitor/bridge/reconcile');
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{"strategy":"core"}');
      const canonical = [
        init.headers['x-iom-time'], init.headers['x-iom-nonce'],
        'POST', '/monitor/bridge/reconcile',
        crypto.createHash('sha256').update(init.body).digest('hex')
      ].join('\n');
      const wanted = crypto.createHmac('sha256', PASS).update(canonical).digest('hex');
      assert.equal(init.headers['x-iom-signature'], wanted);
      return Response.json({ result: 'PAPER_POSITION_RECONCILED' });
    };
    try {
      const res = await monitor(request('reconcile', 'POST', encryptedFyersSession()));
      assert.equal(res.status, 200);
      assert.equal((await res.json()).result, 'PAPER_POSITION_RECONCILED');
    } finally { globalThis.fetch = previous; }
  });
});

test('paper monitor refuses to forward if secret is absent', async () => {
  await withEnv(async () => {
    delete process.env.AWS_PAPER_SYNC_SECRET;
    const res = await monitor(request('status', 'GET', encryptedFyersSession()));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'PAPER_SYNC_NOT_CONFIGURED');
  });
});

test('paper monitor allows only approved browser origin', async () => {
  await withEnv(async () => {
    const res = await monitor(new Request(BASE + '/api/monitor/status', {
      headers: { origin: 'https://evil.example', authorization: 'Bearer ' + encryptedFyersSession() }
    }));
    assert.equal(res.status, 403);
  });
});
