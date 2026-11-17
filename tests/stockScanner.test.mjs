import test from 'node:test';
import assert from 'node:assert/strict';
import { stockSetup } from '../server/stockSignals.mjs';
import { rankStockCandidates } from '../src/engine/stockRanking.js';
import fyers from '../netlify/functions/fyers.mjs';

const start = Date.parse('2026-11-16T09:15:00+05:30') / 1000;
const bar = (minute, open, high, low, close) => [start + minute * 60, open, high, low, close, 1000];
const five = [bar(0, 99, 100, 98, 99), bar(5, 99, 100, 99, 99), bar(10, 99, 100, 98, 99), bar(15, 99, 101, 99, 100.6)];
const retest = bar(21, 100.5, 100.7, 100.02, 100.3);
const confirmation = bar(24, 100.3, 100.85, 100.2, 100.8);

test('requires a closed confirmation after a retest and rejects an invalidated retest', () => {
  assert.equal(stockSetup(five, [retest, confirmation], (start + 26 * 60) * 1000), null);
  assert.equal(stockSetup(five, [retest, confirmation], (start + 27 * 60) * 1000)?.side, 'CE');
  assert.equal(stockSetup(five, [bar(21, 100.5, 100.7, 99.8, 99.9), confirmation], (start + 27 * 60) * 1000), null);
});

test('requires a confirmed prior-day reclaim and supports the bearish mirror', () => {
  const prior = bar(-24 * 60, 101, 102, 100, 101);
  const opening = [bar(0, 101, 102, 100.4, 101), bar(5, 101, 102, 100.4, 101), bar(10, 101, 102, 100.4, 101)];
  const now = (start + 27 * 60) * 1000;
  const reclaim = bar(15, 100.3, 100.6, 99.8, 100.5);
  const result = stockSetup([prior, ...opening, reclaim], [retest, confirmation], now);
  assert.equal(result?.setup, 'Failed breakdown and reclaim');
  const mirror = row => [row[0], 200 - row[1], 200 - row[3], 200 - row[2], 200 - row[4], row[5]];
  assert.equal(stockSetup([prior, ...opening, reclaim].map(mirror), [retest, confirmation].map(mirror), now)?.side, 'PE');
});

test('rejects stale contracts, insufficient depth, and trades above the rupee risk ceiling', () => {
  const candidate = { lotSize: 100, ask: 21, bid: 20.95, spot: 100, stop: 99,
    target: 104, delta: 0.5, askSize: 500, bidSize: 500, validUntil: 2000 };
  const settings = { defaultLots: 2, lotCap: 5, capital: 50000, riskPct: 1 };
  assert.equal(rankStockCandidates([candidate], settings, 1000)[0]?.quantity, 200);
  assert.deepEqual(rankStockCandidates([candidate], settings, 2100), []);
  assert.deepEqual(rankStockCandidates([{ ...candidate, askSize: 199 }], settings, 1000), []);
  assert.deepEqual(rankStockCandidates([candidate], { ...settings, riskPct: 0.2 }, 1000), []);
});

test('stock endpoint is disabled by default and existing index endpoint still requires a session', async () => {
  const stock = await fyers(new Request('https://example.com/api/fyers/stock-scanner'));
  const index = await fyers(new Request('https://example.com/api/fyers/mentor-snapshot'));
  assert.equal(stock.status, 404);
  assert.equal(index.status, 401);
});
