import test from 'node:test';
import assert from 'node:assert/strict';
import { FYERS_REFRESH, fyersRefreshProfile, isNseMarketHours } from '../src/services/fyersRefreshPolicy.js';
import { nextMarketOpenIST, installFyersRequestGuard } from '../src/services/fyersRequestGuard.js';

test('Standard profile stays well within the 5,000-request budget for one visible trading tab', () => {
  assert.equal(FYERS_REFRESH.tier, 'standard');
  const sessionMs = 375 * 60000;
  // Quotes 1 call, Mentor 3 calls, two charts at worst 1 each.
  const requests = Math.ceil(sessionMs / FYERS_REFRESH.quoteMs)
    + 3 * Math.ceil(sessionMs / FYERS_REFRESH.mentorMs)
    + Math.ceil(sessionMs / FYERS_REFRESH.chartMs)
    + Math.ceil(sessionMs / FYERS_REFRESH.scalpCandlesMs);
  assert.ok(requests < 4000, `Expected headroom, got ${requests} requests`);
});

test('NSE schedule is 09:15–15:30 IST on weekdays', () => {
  assert.equal(isNseMarketHours(Date.parse('2026-11-17T03:44:00Z')), false);
  assert.equal(isNseMarketHours(Date.parse('2026-11-17T03:45:00Z')), true);
  assert.equal(isNseMarketHours(Date.parse('2026-11-17T09:59:00Z')), true);
  assert.equal(isNseMarketHours(Date.parse('2026-11-17T10:00:00Z')), false);
  assert.equal(isNseMarketHours(Date.parse('2026-11-21T05:00:00Z')), false);
});

test('Daily limit recovery gate rolls to the next weekday market open', () => {
  assert.equal(new Date(nextMarketOpenIST(Date.parse('2026-11-20T08:00:00Z'))).toISOString(), '2026-11-23T03:45:00.000Z');
  assert.equal(new Date(nextMarketOpenIST(Date.parse('2026-11-17T03:00:00Z'))).toISOString(), '2026-11-17T03:45:00.000Z');
});

test('Daily FYERS 429 halts subsequent protected broker requests without disabling status', async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const stored = new Map();
  let upstream = 0;
  globalThis.localStorage = {
    getItem: key => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key)
  };
  globalThis.window = {
    location: { origin: 'https://dhananjaysaber.github.io' },
    dispatchEvent: () => {},
    fetch: async () => {
      upstream += 1;
      return new Response(JSON.stringify({
        code: 'FYERS_RATE_LIMIT',
        detail: "You've reached the Standard plan limit of 5,000 requests/day."
      }), { status: 429, headers: { 'Content-Type': 'application/json' } });
    }
  };
  try {
    installFyersRequestGuard();
    const first = await window.fetch('/api/fyers/mentor-snapshot');
    assert.equal(first.status, 429);
    const second = await window.fetch('/api/fyers/mentor-snapshot');
    assert.equal(second.status, 429);
    assert.equal((await second.json()).limitScope, 'daily');
    assert.equal(upstream, 1, 'second request must not reach the upstream FYERS API');
    await window.fetch('/api/fyers/status');
    assert.equal(upstream, 2, 'session-status remains accessible');
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

test('Prime speed restores one-second quotes and four-second strategy updates', () => {
  const prime = fyersRefreshProfile('prime');
  assert.deepEqual(
    [prime.quoteMs, prime.mentorMs, prime.chartMs, prime.scalpCandlesMs],
    [1000, 4000, 4000, 4000]
  );
  const sessionMs = 375 * 60000; // 09:15–15:30 IST
  const requests = Math.ceil(sessionMs / prime.quoteMs)
    + 3 * Math.ceil(sessionMs / prime.mentorMs)
    + Math.ceil(sessionMs / prime.chartMs)
    + Math.ceil(sessionMs / prime.scalpCandlesMs);
  const requestsPerMinute = 60000 / prime.quoteMs
    + 3 * 60000 / prime.mentorMs
    + 60000 / prime.chartMs
    + 60000 / prime.scalpCandlesMs;
  assert.ok(requests <= 500000, `Exceeded FYERS Prime daily limit: ${requests}`);
  assert.ok(requestsPerMinute < 500, `Exceeded FYERS Prime minute limit: ${requestsPerMinute}`);
  assert.ok(requests < 100000, 'Expected headroom for additional API reads');
});

test('Standard speed remains available as the fallback without changing strategy logic', () => {
  const standard = fyersRefreshProfile('standard');
  assert.deepEqual(
    [standard.quoteMs, standard.mentorMs, standard.chartMs, standard.scalpCandlesMs],
    [15000, 60000, 90000, 90000]
  );
  assert.equal(FYERS_REFRESH.tier, 'standard'); // default node test build, no VITE_FYERS_TIER
});
