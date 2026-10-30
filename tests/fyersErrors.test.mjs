import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFyersFailure } from '../netlify/functions/fyersErrors.mjs';

for (const code of [-8, -15, -16, -17]) {
  test(`FYERS token error ${code} requires re-authentication, even with HTTP 200`, () => {
    const result = classifyFyersFailure(200, { s: 'error', code, message: 'Invalid access token' }, 'history');
    assert.equal(result.status, 401);
    assert.equal(result.code, 'FYERS_AUTH_REQUIRED');
    assert.equal(result.authRequired, true);
  });
}
test('HTTP 401 requires reconnection', () => {
  assert.equal(classifyFyersFailure(401, {}, 'quotes').authRequired, true);
});
test('HTTP 403 permission errors must not be labelled as expired tokens', () => {
  const result = classifyFyersFailure(403, { message: 'Permission denied' }, 'quotes');
  assert.equal(result.status, 403);
  assert.equal(result.authRequired, false);
});
test('FYERS rate-limit payloads must be surfaced as 429', () => {
  for (const code of [-360, -429]) {
    const result = classifyFyersFailure(200, { s: 'error', code }, 'quotes');
    assert.equal(result.status, 429);
    assert.equal(result.code, 'FYERS_RATE_LIMIT');
    assert.equal(result.authRequired, false);
  }
});
test('upstream data failures do not require a reconnect', () => {
  const result = classifyFyersFailure(200, { s: 'error', code: -50, message: 'Bad historical date range' }, 'history');
  assert.equal(result.status, 502);
  assert.equal(result.authRequired, false);
  assert.equal(result.code, 'FYERS_UPSTREAM_ERROR');
});
