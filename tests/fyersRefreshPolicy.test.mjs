import test from 'node:test';
import assert from 'node:assert/strict';
import { FYERS_REFRESH, isNseMarketHours } from '../src/services/fyersRefreshPolicy.js';
import { nextMarketOpenIST } from '../src/services/fyersRequestGuard.js';

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
