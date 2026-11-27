import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signedInCookie } from './helpers/appSession.mjs';
import orders from '../netlify/functions/orders.mjs';
import { finishTradingLogin, returnedValues, startTradingLogin } from '../src/services/tradingLogin.js';

const MAIN = 'https://optionsmentor.netlify.app';
const answer = (status, data) => async () => Response.json(data, { status });
const state = 'a'.repeat(64);

test('only a FYERS address is ever opened', async () => {
  const good = 'https://api-t1.fyers.in/api/v3/generate-authcode?client_id=X-200';
  assert.equal(await startTradingLogin(answer(200, { loginUrl: good })), good);
  for (const loginUrl of ['https://evil.test/api/v3/generate-authcode?', 'https://api-t1.fyers.in.evil.test/', 'javascript:alert(1)', undefined]) {
    await assert.rejects(startTradingLogin(answer(200, { loginUrl })), /could not be confirmed/);
  }
});
test('the return address must carry one well-formed state and code', () => {
  assert.deepEqual(returnedValues('?s=ok&auth_code=abc.def_ghijk&state=' + state), { state, code: 'abc.def_ghijk' });
  for (const bad of ['', '?auth_code=abcdefghijk', '?state=' + state, '?state=short&auth_code=abcdefghijk', '?state=' + state + '&auth_code=a%20b%20c%20d%20e%20f'])
    assert.equal(returnedValues(bad), null);
});
test('success is claimed only when the server says connected, with plain refusals', async () => {
  await finishTradingLogin(answer(200, { connected: true }), { state, code: 'abcdefghijk' });
  await assert.rejects(finishTradingLogin(answer(200, {}), { state, code: 'abcdefghijk' }), /could not be confirmed/);
  await assert.rejects(finishTradingLogin(answer(409, { reason: 'TRADING_LOGIN_WRONG_ACCOUNT' }), { state, code: 'abcdefghijk' }), /Nothing was saved/);
  await assert.rejects(finishTradingLogin(() => { throw Error('MUST_NOT_SEND'); }, null), /did not return/);
});
test('the trading sign-in is refused without today\'s app sign-in, from other sites, and without FYERS', async () => {
  process.env.AWS_PAPER_SYNC_SECRET = 'only-test-key-'.repeat(4); process.env.AWS_PAPER_SYNC_BASE = 'https://api.example.test';
  const cookie = await signedInCookie();
  const saved = global.fetch; global.fetch = () => { throw Error('NETWORK_MUST_NOT_RUN'); };
  try {
    for (const action of ['login-start', 'login-finish']) {
      const body = JSON.stringify(action === 'login-start' ? {} : { state, code: 'abcdefghijk' });
      const send = headers => orders(new Request(MAIN + '/api/orders/' + action, { method: 'POST', headers, body }));
      assert.equal((await send({ origin: MAIN })).status, 401, action);
      assert.equal((await send({ origin: 'https://evil.test', cookie })).status, 403, action);
      assert.equal((await send({ origin: MAIN, cookie })).status, 401, action);
      assert.equal((await orders(new Request(MAIN + '/api/orders/' + action, { headers: { cookie } }))).status, 405, action);
    }
  } finally { global.fetch = saved; }
});
