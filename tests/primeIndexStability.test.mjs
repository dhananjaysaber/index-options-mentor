import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFyersRequestGuard, readFyersCooldown } from '../src/services/fyersRequestGuard.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('production build remains Index-only with Normal and Scalp, no stock scanner', () => {
  const app = read('src/AppV3.jsx');
  const backend = read('netlify/functions/fyers.mjs');
  assert.match(app, /ScalpMentorDashboard/);
  assert.match(app, /MobileMentorDashboardV41/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition|strategyMode === 'stock'/);
  assert.doesNotMatch(backend, /case 'stock-scanner'|handleStockScanner|runStockUniverse/);
});

test('both strategies run outside the selected strategy tab without duplicate scalp automation', () => {
  const app = read('src/AppV3.jsx');
  const scalp = read('src/components/ScalpMentorDashboard.jsx');
  const monitor = read('src/hooks/useScalpResearch.js');
  assert.doesNotMatch(app, /strategyMode !== 'core'/);
  assert.match(app, /useScalpResearch/);
  assert.match(app, /buildScalpTicket\(snapshot, scalpStatus, settings, 'MENTOR'\)/);
  assert.match(app, /marketDataReady/);
  assert.doesNotMatch(scalp, /setInterval|const LEDGER_KEY|scalpAutoOpen/);
  assert.match(monitor, /FYERS_REFRESH\.scalpCandlesMs/);
  assert.match(monitor, /document\.visibilityState/);
});

test('Prime refresh profile stays 1s quotes and 4s mentor, chart and scalp', async () => {
  const { fyersRefreshProfile } = await import('../src/services/fyersRefreshPolicy.js');
  const fast = fyersRefreshProfile('prime');
  assert.equal(fast.quoteMs, 1000);
  assert.equal(fast.mentorMs, 4000);
  assert.equal(fast.chartMs, 4000);
  assert.equal(fast.scalpCandlesMs, 4000);
});

test('temporary FYERS snapshot 429 does not stop the independent NIFTY quote stream', async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  const calls = [];
  try {
    globalThis.localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key,value) => values.set(key, value),
      removeItem: key => values.delete(key)
    };
    globalThis.window = {
      location: { origin: 'https://optionsmentor.test' },
      __iomFyersRequestGuard: false,
      fetch: async input => {
        const pathname = new URL(String(input), 'https://optionsmentor.test').pathname;
        calls.push(pathname);
        if (pathname === '/api/fyers/mentor-snapshot') return new Response(JSON.stringify({
          code: 'FYERS_RATE_LIMIT', limitScope: 'temporary',
          error: 'FYERS temporary rate limit'
        }), {status:429, headers:{'Content-Type':'application/json'}});
        return new Response(JSON.stringify({d:[{n:'NSE:NIFTY50-INDEX',v:{lp:25000}}]}), {
          status:200, headers:{'Content-Type':'application/json'}
        });
      },
      dispatchEvent: () => {}
    };
    installFyersRequestGuard();
    const first = await window.fetch('/api/fyers/mentor-snapshot');
    assert.equal(first.status,429);
    const quote = await window.fetch('/api/fyers/quote?symbol=NSE:NIFTY50-INDEX');
    assert.equal(quote.status,200, 'A snapshot error must not block live NIFTY quotes');
    const repeated = await window.fetch('/api/fyers/mentor-snapshot');
    assert.equal(repeated.status,429, 'Throttle only the failing endpoint briefly');
    assert.deepEqual(calls, ['/api/fyers/mentor-snapshot', '/api/fyers/quote']);
    assert.equal(readFyersCooldown(), null, 'No global three-minute cooldown must be written');
    assert.equal(values.has('iom-fyers-data-cooldown-v1'),false);
  } finally {
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

test('journal errors never block a simulated position from being created', () => {
  const app = read('src/AppV3.jsx');
  const journal = read('src/services/tradeJournal.js');
  assert.match(app, /function takeTrade\(ticket\)/);
  assert.match(app, /setScalpPosition\(current => current \? current : enriched\)/);
  assert.match(journal, /await putOutbox\(event\);/);
  assert.match(journal, /void flushJournalQueue\(\)/);
  assert.match(journal, /nextJournalSyncAt/);
});
