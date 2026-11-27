import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import journalMaintenance from '../netlify/functions/journal-maintenance.mjs';
import auth from '../netlify/functions/auth.mjs';
import journal from '../netlify/functions/journal.mjs';
import orders from '../netlify/functions/orders.mjs';
import execution from '../netlify/functions/execution.mjs';
import monitor from '../netlify/functions/monitor.mjs';
import fyers from '../netlify/functions/fyers.mjs';
import { MAIN_ORIGIN, endOfDayIST } from '../netlify/functions/lib/appAuth.mjs';
import { fakeSignIn, setUpAppAuth, googleToken, APPROVED, CLIENT_ID } from './helpers/appSession.mjs';

const world = setUpAppAuth();
const url = path => MAIN_ORIGIN + path;
const handlers = { journal, orders, execution, monitor, fyers };
// Every route that reads private data or controls something.
const PRIVATE = [
  ['journal', 'GET', '/api/journal'], ['journal', 'GET', '/api/journal?health=1'], ['journal', 'POST', '/api/journal'],
  ['orders', 'GET', '/api/orders/status'], ['orders', 'POST', '/api/orders/settings'], ['orders', 'POST', '/api/orders/preview'],
  ['orders', 'POST', '/api/orders/buy'], ['orders', 'POST', '/api/orders/prepare'], ['orders', 'POST', '/api/orders/submit'],
  ['orders', 'POST', '/api/orders/exit'], ['orders', 'POST', '/api/orders/stop'],
  ['execution', 'GET', '/api/execution/status'], ['execution', 'POST', '/api/execution/check'],
  ['monitor', 'GET', '/api/monitor/status'], ['monitor', 'POST', '/api/monitor/sync'], ['monitor', 'POST', '/api/monitor/reconcile'],
  ...['status', 'login', 'callback', 'logout', 'quote', 'history', 'research-history', 'option-chain', 'mentor-snapshot']
    .map(name => ['fyers', 'GET', '/api/fyers/' + name])
];
const call = ([name, method, path], headers = {}, base = MAIN_ORIGIN) => handlers[name](new Request(base + path, {
  method, headers: { ...(method === 'POST' ? { origin: base } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {})
}));
async function noNetwork(run) {
  const saved = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw Error('NETWORK_MUST_NOT_RUN'); };
  try { await run(); assert.equal(calls, 0); } finally { global.fetch = saved; }
}
const session = cookie => auth(new Request(url('/api/auth/session'), { headers: { cookie } }));

test('signed out: every private route refuses before touching any server', () => noNetwork(async () => {
  for (const route of PRIVATE) {
    const response = await call(route);
    assert.equal(response.status, 401, route.join(' '));
  }
}));

test('a market-data login alone opens nothing', () => noNetwork(async () => {
  for (const route of PRIVATE) {
    const response = await call(route, { authorization: 'Bearer stolen-market-data-session', cookie: 'iom_fyers_session=stolen' });
    assert.equal(response.status, 401, route.join(' '));
  }
}));

test('forged, altered and expired sign-ins are refused', () => noNetwork(async () => {
  const good = await fakeSignIn(auth);
  const [body, mark] = good.split('=')[1].split('.');
  const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), exp: 9999999999 })).toString('base64url');
  for (const cookie of ['__Host-iom_app=junk', `__Host-iom_app=${altered}.${mark}`, `__Host-iom_app=${body}.${'A'.repeat(mark.length)}`]) {
    assert.equal((await call(PRIVATE[0], { cookie })).status, 401, cookie);
  }
  const real = Date.now;
  try {
    Date.now = () => endOfDayIST(real()) * 1000 + 1000;
    assert.equal((await call(PRIVATE[0], { cookie: good })).status, 401);
  } finally { Date.now = real; }
}));

test('a sign-in lasts until midnight India time, never longer than one day', () => {
  const nineAm = Date.parse('2026-11-27T09:00:00+05:30');
  assert.equal(endOfDayIST(nineAm) * 1000, Date.parse('2026-11-28T00:00:00+05:30'));
  const justAfterMidnight = Date.parse('2026-11-27T00:00:01+05:30');
  assert.ok(endOfDayIST(justAfterMidnight) * 1000 - justAfterMidnight <= 86400000);
});

test('only the approved Google account can sign in', async () => {
  const refuse = async claims => {
    const response = await fakeSignIn(auth, claims, { raw: true });
    assert.equal(response.status, 403, JSON.stringify(claims));
    assert.ok(!(response.headers.get('set-cookie') || '').includes('__Host-iom_app=ey'));
  };
  await refuse({ email: 'someone.else@gmail.com', sub: '999' });
  await refuse({ email_verified: false });
  await refuse({ aud: 'another-app.apps.googleusercontent.com' });
  await refuse({ iss: 'https://evil.example' });
  await refuse({ exp: Math.floor(Date.now() / 1000) - 10 });
  await refuse({ nonce: 'not-the-one-issued' });
  // A work address needs the permanent Google ID to be configured instead.
  process.env.APP_ALLOWED_GOOGLE_EMAIL = 'jay@work.example';
  await refuse({ email: 'jay@work.example' });
  process.env.APP_ALLOWED_GOOGLE_EMAIL = APPROVED.email;
  const ok = await fakeSignIn(auth, {}, { raw: true });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.getSetCookie().find(value => value.startsWith('__Host-iom_app='));
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(cookie.includes(flag), flag);
});

test('a token signed by the wrong key, or with no signature, is refused', async () => {
  const forged = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const options of [{ key: forged }, { algorithm: 'none' }]) {
    const response = await fakeSignIn(auth, {}, { raw: true, ...options });
    assert.equal(response.status, 403);
  }
});

test('a permanent Google ID, when set, must match', async () => {
  process.env.APP_ALLOWED_GOOGLE_SUB = APPROVED.sub;
  try {
    assert.equal((await fakeSignIn(auth, {}, { raw: true })).status, 200);
    assert.equal((await fakeSignIn(auth, { sub: '999' }, { raw: true })).status, 403);
  } finally { delete process.env.APP_ALLOWED_GOOGLE_SUB; }
});

test('changing the approved account ends existing sign-ins', async () => {
  const cookie = await fakeSignIn(auth);
  assert.equal((await session(cookie)).status, 200);
  process.env.APP_ALLOWED_GOOGLE_EMAIL = 'new.owner@gmail.com';
  try { assert.equal((await session(cookie)).status, 401); }
  finally { process.env.APP_ALLOWED_GOOGLE_EMAIL = APPROVED.email; }
});

test('sign out all devices ends every earlier sign-in, and a new one works', async () => {
  const phone = await fakeSignIn(auth), laptop = await fakeSignIn(auth);
  assert.equal((await session(phone)).status, 200);
  assert.equal((await session(laptop)).status, 200);
  const done = await auth(new Request(url('/api/auth/logout-all'), { method: 'POST', headers: { cookie: laptop, origin: MAIN_ORIGIN } }));
  assert.equal(done.status, 200);
  assert.ok(done.headers.getSetCookie().some(v => v.startsWith('__Host-iom_app=;')));
  assert.ok(done.headers.getSetCookie().some(v => v.startsWith('iom_fyers_session=;')));
  assert.equal((await session(phone)).status, 401);
  assert.equal((await session(laptop)).status, 401);
  assert.equal((await session(await fakeSignIn(auth))).status, 200);
});

test('plain sign out clears this device only', async () => {
  const phone = await fakeSignIn(auth), laptop = await fakeSignIn(auth);
  const done = await auth(new Request(url('/api/auth/logout'), { method: 'POST', headers: { cookie: laptop, origin: MAIN_ORIGIN } }));
  assert.equal(done.status, 200);
  assert.ok(done.headers.getSetCookie().some(v => v.startsWith('__Host-iom_app=;')));
  assert.equal((await session(phone)).status, 200);
});

test('if the sign-out record cannot be read, everything stays locked', () => noNetwork(async () => {
  const cookie = await fakeSignIn(auth);
  world.storeDown = true;
  try {
    for (const route of PRIVATE) assert.equal((await call(route, { cookie })).status, 503, route.join(' '));
  } finally { world.storeDown = false; }
}));

test('a lost sign-out record never revives old sign-ins', async () => {
  const cookie = await fakeSignIn(auth);
  world.values.clear();
  assert.equal((await session(cookie)).status, 401);
});

test('unfinished setup locks everything', () => noNetwork(async () => {
  const cookie = await fakeSignIn(auth);
  for (const name of ['APP_GOOGLE_CLIENT_ID', 'APP_SESSION_SECRET', 'APP_ALLOWED_GOOGLE_EMAIL']) {
    const saved = process.env[name]; delete process.env[name];
    try { for (const route of PRIVATE) assert.equal((await call(route, { cookie })).status, 503, name + route.join(' ')); }
    finally { process.env[name] = saved; }
  }
}));

test('other copies of the app cannot reach private data, even with a sign-in cookie', () => noNetwork(async () => {
  const cookie = await fakeSignIn(auth);
  for (const route of PRIVATE) {
    for (const base of ['https://deploy-preview-28--optionsmentor.netlify.app', 'https://deploy-preview-30--optionsmentor.netlify.app', 'https://abc123--optionsmentor.netlify.app']) {
      assert.equal((await call(route, { cookie }, base)).status, 403, base + route.join(' '));
    }
    for (const origin of ['https://dhananjaysaber.github.io', 'https://evil.netlify.app', 'null']) {
      const response = await call(route, { cookie, origin });
      assert.equal(response.status, 403, origin + route.join(' '));
      assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
  }
}));

test('a POST without a browser origin is refused', () => noNetwork(async () => {
  const cookie = await fakeSignIn(auth);
  for (const [name, , path] of PRIVATE.filter(r => r[1] === 'POST')) {
    const response = await handlers[name](new Request(url(path), { method: 'POST', headers: { cookie }, body: '{}' }));
    assert.equal(response.status, 403, path);
  }
}));

test('sign-in itself must come from the main address', async () => {
  const response = await fakeSignIn(auth, {}, { raw: true, origin: 'https://evil.example' });
  assert.equal(response.status, 403);
});

test('signed in, the journal is reachable', async () => {
  const cookie = await fakeSignIn(auth);
  const saved = global.fetch, env = { ...process.env };
  Object.assign(process.env, { JOURNAL_STORAGE: 'sqlite', AWS_PAPER_SYNC_BASE: 'https://api.optionsmentor.in', AWS_PAPER_SYNC_SECRET: 'test-key-'.repeat(8) });
  global.fetch = async () => Response.json({ ok: true, trades: [] });
  try { assert.equal((await call(['journal', 'GET', '/api/journal'], { cookie })).status, 200); }
  finally {
    global.fetch = saved;
    for (const name of ['JOURNAL_STORAGE', 'AWS_PAPER_SYNC_BASE', 'AWS_PAPER_SYNC_SECRET']) {
      if (env[name] === undefined) delete process.env[name]; else process.env[name] = env[name];
    }
  }
});

test('the sign-in setup page gives out no secrets', async () => {
  const response = await auth(new Request(url('/api/auth/config')));
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['clientId', 'configured', 'nonce']);
  assert.equal(data.clientId, CLIENT_ID);
});

test('no server function is left open: each needs the app sign-in or a server signature', () => noNetwork(async () => {
  const files = readdirSync(new URL('../netlify/functions/', import.meta.url)).filter(name => name.endsWith('.mjs'));
  // fyersErrors only holds messages; auth is the sign-in itself. A new file fails here until it is checked.
  assert.deepEqual(files.sort(), [...Object.keys(handlers), 'auth', 'journal-maintenance', 'fyersErrors'].map(n => n + '.mjs').sort());
  const machine = [
    [journalMaintenance, '/api/journal-maintenance', 401],
    [orders, '/api/orders/maintenance-status', 403],
    [execution, '/api/execution/maintenance', 403]
  ];
  process.env.AWS_PAPER_SYNC_SECRET ||= 'test-key-'.repeat(8);
  process.env.AWS_PAPER_SYNC_BASE ||= 'https://api.optionsmentor.in';
  for (const [handler, path, refused] of machine) {
    const body = path.includes('journal') ? '{"action":"list_trades"}' : path.includes('execution') ? JSON.stringify({ checkId: crypto.randomUUID() }) : '{}';
    const response = await handler(new Request(url(path), { method: 'POST', body }));
    assert.equal(response.status, refused, path);
  }
}));
