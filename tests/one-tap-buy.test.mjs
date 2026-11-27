import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneTapBuy, AFTER_TAP_PAUSE_MS } from '../src/services/oneTapBuy.js';
import { checkSignIn, watchSignIn, signOut } from '../src/services/appSignIn.js';

const shown = { symbol: 'NSE:NIFTYTEST25450PE', quantity: 130, buyPrice: 230 };
function setup(reply) {
  const world = { calls: [], now: 1000000, ids: 0 };
  world.tap = createOneTapBuy({ now: () => world.now, uuid: () => 'id-' + ++world.ids,
    fetcher: async (url, init) => { world.calls.push(JSON.parse(init.body)); return reply(world.calls.length); } });
  return world;
}
const bought = () => Response.json({ order: { state: 'MANAGING' } });

test('one tap sends exactly what was on screen', async () => {
  const world = setup(bought);
  const result = await world.tap('SCALP', shown, 30000);
  assert.deepEqual(result, { kind: 'done', message: 'Bought. Your stop is confirmed.' });
  assert.deepEqual(world.calls, [{ intentId: 'id-1', strategy: 'SCALP', symbol: shown.symbol, quantity: 130, maxPrice: 230, tradeAmount: 30000 }]);
});

test('double and rapid taps send one request', async () => {
  const world = setup(bought);
  let started = 0;
  const results = await Promise.all([1, 2, 3, 4].map(() => world.tap('SCALP', shown, 30000, () => started++)));
  assert.equal(started, 1, 'an ignored tap must not change the screen');
  assert.equal(world.calls.length, 1);
  assert.equal(results.filter(r => r.kind === 'ignored').length, 3);
  assert.equal((await world.tap('SCALP', shown, 30000)).kind, 'ignored');
  world.now += AFTER_TAP_PAUSE_MS + 1;
  await world.tap('SCALP', shown, 30000);
  assert.equal(world.calls[1].intentId, 'id-2');
});

test('the two strategies do not block each other', async () => {
  const world = setup(bought);
  await Promise.all([world.tap('CORE', shown, 30000), world.tap('SCALP', shown, 30000)]);
  assert.equal(world.calls.length, 2);
});

test('a lost reply keeps the same identity; a clear answer does not', async () => {
  const world = setup(count => { if (count === 1) throw Error('offline'); if (count === 2) return Response.json({ error: 'ORDER_SERVICE_UNAVAILABLE_CHECK_BROKER_BEFORE_RETRY' }, { status: 503 }); return bought(); });
  for (let i = 0; i < 4; i++) { await world.tap('SCALP', shown, 30000); world.now += AFTER_TAP_PAUSE_MS + 1; }
  assert.deepEqual(world.calls.map(c => c.intentId), ['id-1', 'id-1', 'id-1', 'id-2']);
});

test('refused, waiting, unprotected and unclear are never shown as bought', async () => {
  const cases = [
    [Response.json({ reason: 'PRICE_MOVED_REFRESH_PLAN' }, { status: 409 }), 'refused', /price went up.*No order was sent/],
    [Response.json({ error: 'ORDER_NOT_ACCEPTED_CHECK_STATUS' }, { status: 409 }), 'unclear', /Check your FYERS orders/],
    [Response.json({ reason: 'DUPLICATE_TAP' }, { status: 409 }), 'refused', /Only the first one counted/],
    [Response.json({ error: 'APP_SIGN_IN_REQUIRED' }, { status: 401 }), 'refused', /Sign in/],
    [new Response('<html>', { status: 502 }), 'unclear', /unclear/],
    [Response.json({ order: { state: 'WAITING' } }), 'waiting', /not confirmed as bought/],
    [Response.json({ order: { state: 'PENDING' } }), 'waiting', /not confirmed as bought/],
    [Response.json({ order: { state: 'PROTECTING' } }), 'warning', /NOT confirmed/],
    [Response.json({ order: { state: 'NO_FILL' } }), 'refused', /Nothing was bought/],
    [Response.json({ order: { state: 'NOT_SENT', duplicate: true } }), 'refused', /No order was sent/],
    [Response.json({ order: { state: 'UNCLEAR' } }), 'unclear', /unclear/],
    [Response.json({}), 'unclear', /unclear/]
  ];
  for (const [response, kind, message] of cases) {
    const result = await setup(() => response).tap('SCALP', shown, 30000);
    assert.equal(result.kind, kind, result.message);
    assert.match(result.message, message);
  }
});

const MAIN = 'optionsmentor.netlify.app', later = () => Math.floor(Date.now() / 1000) + 600;
test('the app opens only on a confirmed, current sign-in at the main address', async () => {
  const ask = (response, host = MAIN) => checkSignIn(async () => response, host).then(r => r.state);
  assert.equal(await ask(Response.json({ signedIn: true, expiresAt: later() })), 'signed-in');
  assert.equal(await ask(Response.json({ signedIn: true, expiresAt: 5 })), 'unavailable');
  assert.equal(await ask(Response.json({ ok: true })), 'unavailable');
  assert.equal(await ask(Response.json({ error: 'APP_SIGN_IN_REQUIRED' }, { status: 401 })), 'signed-out');
  assert.equal(await ask(Response.json({ error: 'APP_SIGN_IN_NOT_CONFIGURED' }, { status: 503 })), 'not-configured');
  assert.equal(await ask(new Response('<html></html>')), 'unavailable');
  assert.equal((await checkSignIn(async () => { throw Error('offline'); }, MAIN)).state, 'unavailable');
  for (const host of ['dhananjaysaber.github.io', 'deploy-preview-28--optionsmentor.netlify.app', 'evil.example']) {
    assert.equal((await checkSignIn(async () => { throw Error('must not ask'); }, host)).state, 'wrong-address');
  }
});

test('an open app closes at expiry and after sign-out elsewhere, not on lost signal', async () => {
  const listeners = [], timers = []; let reloads = 0, reply;
  const page = { visibilityState: 'visible', addEventListener: (_n, run) => listeners.push(run) };
  watchSignIn(later(), { hostname: MAIN, reload: () => reloads++, page, timers: { setTimeout: (run, ms) => timers.push([run, ms]) }, fetcher: async () => reply() });
  assert.ok(timers[0][1] > 590000 && timers[0][1] <= 602000);
  reply = () => { throw Error('offline'); }; await listeners[0](); assert.equal(reloads, 0);
  reply = () => Response.json({}, { status: 401 }); await listeners[0](); assert.equal(reloads, 1);
});

test('sign out reports failure instead of pretending', async () => {
  const calls = [];
  await signOut(async url => { calls.push(url); return new Response('{}'); }, true);
  await signOut(async url => { calls.push(url); return new Response('{}'); }, false);
  assert.deepEqual(calls, ['/api/auth/logout-all', '/api/auth/logout']);
  await assert.rejects(signOut(async () => new Response('{}', { status: 503 }), true), /NOT_CONFIRMED/);
});
