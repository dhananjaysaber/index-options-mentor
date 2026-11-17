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

test('stock endpoint defaults to production and both routes require a session', async () => {
  const stock = await fyers(new Request('https://example.com/api/fyers/stock-scanner'));
  const productionStock = await fyers(new Request('https://optionsmentor.netlify.app/api/fyers/stock-scanner'));
  const index = await fyers(new Request('https://example.com/api/fyers/mentor-snapshot'));
  assert.equal(stock.status, 404);
  assert.equal(productionStock.status, 401);
  assert.equal(index.status, 401);
});


test('universe is derived from active FYERS NSE stock-option contracts, not preset stock names', async () => {
  const { deriveFnoUniverse } = await import('../server/stockScanner.mjs');
  const now = Date.parse('2026-11-17T08:50:00Z');
  const expiry = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);
  const master = {
    'NSE:ABC26NOVCE': { optType: 'CE', underSym: 'ABC', expiryDate: expiry, tradeStatus: 1, minLotSize: 200 },
    'NSE:ABC26NOVPE': { optType: 'PE', underSym: 'ABC', expiryDate: expiry, tradeStatus: 1, minLotSize: 200 },
    'NSE:OTHERCE': { optType: 'CE', underSym: 'OTHER', expiryDate: expiry, tradeStatus: 1, minLotSize: 200 },
    'NSE:NIFTYCE': { optType: 'CE', underSym: 'NIFTY', expiryDate: expiry, tradeStatus: 1, minLotSize: 75 },
    'NSE:NIFTYPE': { optType: 'PE', underSym: 'NIFTY', expiryDate: expiry, tradeStatus: 1, minLotSize: 75 },
    'NSE:EXPIREDCE': { optType: 'CE', underSym: 'EXP', expiryDate: now / 1000 - 100, tradeStatus: 1, minLotSize: 100 },
    'NSE:EXPIREDPE': { optType: 'PE', underSym: 'EXP', expiryDate: now / 1000 - 100, tradeStatus: 1, minLotSize: 100 }
  };
  assert.deepEqual(deriveFnoUniverse(master, now), [{ stock: 'ABC', symbol: 'NSE:ABC-EQ' }]);
});

test('only actual confirmed 5m/3m setups are ranked: no padding to ten', async () => {
  const { runStockScan } = await import('../server/stockScanner.mjs');
  const now = Date.parse('2026-11-17T08:50:00Z'); // 14:20 IST
  const originalNow = Date.now;
  Date.now = () => now;
  const expiry = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);
  const master = {};
  for (let i = 1; i <= 12; i += 1) {
    const name = 'STK' + String(i).padStart(3, '0');
    master[name + 'CE'] = { optType: 'CE', underSym: name, expiryDate: expiry, minLotSize: 100, tradeStatus: 1 };
    master[name + 'PE'] = { optType: 'PE', underSym: name, expiryDate: expiry, minLotSize: 100, tradeStatus: 1 };
  }
  let quoteCalls = 0, historyCalls = 0, optionCalls = 0;
  try {
    const get = async (path, params) => {
      if (path === '/quotes') {
        quoteCalls += 1;
        const symbols = params.symbols.split(',');
        assert.ok(symbols.length <= 50, 'Must respect FYERS GET quotes 50-symbol limit');
        return { d: symbols.map(symbol => ({
          n: symbol, s: 'ok', v: { lp: 100, open_price: 99, high_price: 104,
            low_price: 96, chp: 0.2, tt: now / 1000 }
        })) };
      }
      if (path === '/history') { historyCalls += 1; return { candles: [] }; }
      if (path === '/options-chain-v3') { optionCalls += 1; throw Error('No option chains without structural setup'); }
      throw Error('Unexpected endpoint: ' + path);
    };
    const result = await runStockScan(get, 'stock-dynamic-test', now, { master });
    assert.equal(result.universeCount, 12);
    assert.equal(result.quotesChecked, 12);
    assert.equal(result.detailedChecked, 12);
    assert.equal(result.watchlist.length, 0, 'No setups means zero recommendations, not ten preset names');
    assert.equal(result.candidates.length, 0);
    assert.equal(quoteCalls, 1, 'Quotes are batched');
    assert.equal(historyCalls, 24);
    assert.equal(optionCalls, 0);
  } finally { Date.now = originalNow; }
});

test('large F&O universe is shortlisted dynamically and never polls over 50 symbols in one quote request', async () => {
  const { shortlistForSetups } = await import('../server/stockScanner.mjs');
  const rows = Array.from({ length: 200 }, (_, i) => ({
    stock: 'STK' + i, symbol: 'NSE:STK' + i + '-EQ',
    quote: { lp: 100 + i, open_price: 100, chp: i / 2, high_price: 200, low_price: 95 }
  }));
  const selected = shortlistForSetups(rows, Date.parse('2026-11-17T08:50:00Z'));
  assert.equal(selected.length, 24);
  assert.equal(new Set(selected.map(row => row.stock)).size, 24);
  assert.ok(selected.some(row => row.stock === 'STK199'), 'Strongest daily mover should be considered');
});

test('scanner outside market hours makes zero FYERS requests', async () => {
  const { runStockScan } = await import('../server/stockScanner.mjs');
  const result = await runStockScan(async () => { throw Error('No API calls expected after close'); },
    'stock-market-closed-test', Date.parse('2026-11-17T12:00:00Z'));
  assert.equal(result.candidates.length, 0);
  assert.equal(result.watchlist.length, 0);
});
