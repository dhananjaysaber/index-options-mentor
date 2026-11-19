import test from 'node:test';
import { equityScreeningSymbols, NSE_FNO_SCREENING_SEED } from '../server/stockUniverseSeed.mjs';
import { quoteValue } from '../server/stockScanner.mjs';
import assert from 'node:assert/strict';
import {
  runStockUniverse, runStockContext, runStockEntryCheck, analyseWeeklyDaily
} from '../server/stockStages.mjs';

const now = Date.parse('2026-11-17T09:20:00Z'); // 14:50 IST
const expiry = Math.floor(Date.parse('2026-11-26T10:00:00Z') / 1000);
const baseMaster = {};
for (let i = 1; i <= 4; i++) {
  const code = 'SYM' + String(i).padStart(2, '0');
  baseMaster[code + 'CE'] = { optType: 'CE', underSym: code, expiryDate: expiry, minLotSize: 100, tradeStatus: 1 };
  baseMaster[code + 'PE'] = { optType: 'PE', underSym: code, expiryDate: expiry, minLotSize: 100, tradeStatus: 1 };
}
function makeDaily(direction = 1) {
  const first = Date.parse('2026-10-25T03:45:00Z') / 1000;
  return Array.from({length: 14}, (_, i) => {
    const price = 100 + direction * i * 2;
    return [first + i * 86400, price - 1, price + 2, price - 2, price, 1000 + i * 100];
  });
}
function makeWeekly(direction = 1) {
  const first = Date.parse('2026-09-21T03:45:00Z') / 1000;
  return Array.from({length: 8}, (_, i) => {
    const price = 90 + direction * i * 3;
    return [first + i * 7 * 86400, price - 1, price + 2, price - 2, price, 1000 + i * 300];
  });
}

test('progressive universe scan returns quote-based preliminary watches without requesting any candles', async () => {
  let quotes = 0, histories = 0;
  const get = async (path, params) => {
    if (path === '/history') { histories++; throw Error('Pre-screen must never call history'); }
    if (path !== '/quotes') throw Error('Unexpected endpoint: ' + path);
    quotes++;
    const symbols = params.symbols.split(',');
    assert.ok(symbols.length <= 50);
    return { d: symbols.map((symbol, i) => ({
      n: symbol, s: 'ok', v: { lp: 120 + i, open_price: 115, chp: 1.2, tt: now / 1000 }
    })) };
  };
  const result = await runStockUniverse(get, 'universe-incremental-01', now, { universe: Array.from({length: 4}, (_, i) => ({stock: 'SYM0'+(i+1), symbol:'NSE:SYM0'+(i+1)+'-EQ'})) });
  assert.equal(result.phase, 'universe');
  assert.equal(result.universeCount, 4);
  assert.equal(result.prescreen.length, 4);
  assert.ok(result.prescreen.every(row => row.status === 'SCREENING'));
  assert.equal(quotes, 1);
  assert.equal(histories, 0);
});

test('weekly/daily bullish alignment is displayed on WATCH rather than hidden until intraday entry', async () => {
  const context = analyseWeeklyDaily(makeDaily(1), makeWeekly(1), now, 128);
  assert.equal(context.weekBias, 'BULLISH');
  assert.equal(context.dayBias, 'BULLISH');
  assert.equal(context.side, 'CE');
  assert.equal(context.status, 'WATCH');
  assert.ok(context.score >= 60);
});

test('weekly/daily bearish alignment creates PE WATCH', () => {
  const context = analyseWeeklyDaily(makeDaily(-1), makeWeekly(-1), now, 64);
  assert.equal(context.weekBias, 'BEARISH');
  assert.equal(context.dayBias, 'BEARISH');
  assert.equal(context.side, 'PE');
});

test('context stage returns watch candidates even without 5m/3m triggers or option chain', async () => {
  let calls = 0;
  const get = async (path, params) => {
    calls++;
    if (path === '/quotes') return {
      d: params.symbols.split(',').map(symbol => ({
        n: symbol, s: 'ok', v: { lp: 128, chp: 1.3, tt: now / 1000 }
      }))
    };
    if (path === '/history') {
      assert.ok(['1D', '1W'].includes(params.resolution));
      return { candles: params.resolution === '1D' ? makeDaily(1) : makeWeekly(1) };
    }
    throw Error('Unexpected option request before entry stage: ' + path);
  };
  const result = await runStockContext(get, 'context-incremental-01', now, {
    symbols: 'NSE:SYM01-EQ,NSE:SYM02-EQ'
  });
  assert.equal(result.phase, 'context');
  assert.equal(result.contextChecked, 2);
  assert.equal(result.watchlist.length, 2);
  assert.ok(result.watchlist.every(item => item.side === 'CE' && item.status === 'WATCH'));
  assert.equal(calls, 5);
});

test('entry checks return no paper order if 5m/3m confirmation is absent', async () => {
  let chainCalls = 0;
  const get = async (path) => {
    if (path === '/history') return { candles: [] };
    if (path === '/options-chain-v3') { chainCalls++; throw Error('No chain should be requested'); }
    throw Error('Unexpected call: ' + path);
  };
  const result = await runStockEntryCheck(get, 'entry-incremental-01', now, {
    symbols: 'NSE:SYM01-EQ', bias: 'SYM01:CE'
  }, { master: baseMaster });
  assert.equal(result.phase, 'entry');
  assert.equal(result.detailedChecked, 1);
  assert.equal(result.candidates.length, 0);
  assert.equal(chainCalls, 0);
});

test('stages do not fetch outside trading hours', async () => {
  const afterHours = Date.parse('2026-11-17T11:15:00Z');
  const forbidden = async () => { throw Error('No broker traffic expected'); };
  const stage = await runStockUniverse(forbidden, 'closed-incremental', afterHours, { master: baseMaster });
  assert.match(stage.status, /outside NSE market hours/i);
});

test('fast initial scan uses exchange-derived broad reference pool, not a twelve-stock preset', async () => {
  assert.ok(NSE_FNO_SCREENING_SEED.length > 100);
  assert.ok(equityScreeningSymbols().some(row => row.stock === 'JIOFIN'));
  assert.ok(equityScreeningSymbols().some(row => row.stock === 'YESBANK'));
  assert.ok(equityScreeningSymbols().some(row => row.stock === 'LAURUSLABS'));
  let quotes = 0, histories = 0, chains = 0;
  const get = async (path, params) => {
    if (path === '/history') histories++;
    if (path === '/options-chain-v3') chains++;
    assert.equal(path, '/quotes', 'initial watchlist must not download candles/options');
    const all = params.symbols.split(',');
    assert.ok(all.length <= 50);
    quotes++;
    return { d: all.map((symbol, i) => ({
      n: symbol, s: 'ok', v: { lp: 110 + i, open_price: 100,
        chp: i % 2 ? -2.2 : 1.8, high_price: 115, low_price: 95, tt: now / 1000 }
    })) };
  };
  const result = await runStockUniverse(get, 'fast-seeded-universe-01', now);
  assert.ok(result.universeCount > 100);
  assert.equal(result.quotesChecked, result.universeCount);
  assert.ok(result.prescreen.length > 0);
  assert.ok(result.prescreen.length <= 12);
  assert.ok(result.prescreen.every(row => ['CE','PE'].includes(row.side) && row.status === 'SCREENING'));
  assert.ok(quotes > 1);
  assert.equal(histories, 0);
  assert.equal(chains, 0);
});

test('FYERS quote.tt is day time, not a last-price-tick timestamp', () => {
  // Regress the actual production bug: a valid FYERS equity quote had
  // non-current tt and was discarded, leaving 0 / 163 validated quotes.
  const symbol = 'NSE:RELIANCE-EQ';
  const brokerQuote = {
    d: [{ n: symbol, s: 'ok',
      v: { symbol, lp: 1402.25, open_price: 1400, chp: .15, tt: '1691020800' } }],
    receivedAt: Date.now()
  };
  assert.equal(quoteValue(brokerQuote, symbol)?.lp, 1402.25);
  assert.equal(quoteValue({ ...brokerQuote, receivedAt: Date.now() - 11000 }, symbol), null,
    'A stale application snapshot must still be rejected');
  assert.equal(quoteValue({ ...brokerQuote, d: [{ ...brokerQuote.d[0], s: 'error' }] }, symbol), null);
});

test('actual FYERS quote timestamps no longer eliminate the preliminary watchlist', async () => {
  const oldSessionTime = '1691020800'; // FYERS documented quote tt sample
  const get = async (path, params) => {
    assert.equal(path, '/quotes');
    return { receivedAt: Date.now(), d: params.symbols.split(',').map(symbol => ({
      n: symbol, s: 'ok', v: { lp: 132.5, chp: 1.1, open_price: 130.0,
        high_price: 134, low_price: 129, tt: oldSessionTime }
    })) };
  };
  const result = await runStockUniverse(get, 'tt-session-format-regression', now, {
    universe: [
      { stock: 'RELIANCE', symbol: 'NSE:RELIANCE-EQ' },
      { stock: 'SBIN', symbol: 'NSE:SBIN-EQ' }
    ]
  });
  assert.equal(result.quotesChecked, 2);
  assert.equal(result.prescreen.length, 2);
});


test('weekly/daily stock checks never start concurrent broker history calls', async () => {
  let activeCalls = 0;
  let peakCalls = 0;
  const get = async (path, params) => {
    activeCalls += 1;
    peakCalls = Math.max(peakCalls, activeCalls);
    try {
      await new Promise(resolve => setTimeout(resolve, 3));
      if (path === '/quotes') return { d: params.symbols.split(',').map(symbol => ({
        n: symbol, s: 'ok', v: { lp: 128, chp: 2.1, tt: now / 1000 }
      })) };
      if (path === '/history') return {
        candles: params.resolution === '1D' ? makeDaily(1) : makeWeekly(1)
      };
      throw new Error('Unexpected FYERS endpoint ' + path);
    } finally { activeCalls -= 1; }
  };
  const result = await runStockContext(get, 'serial-context-no-429-test', now, {
    symbols: 'NSE:SYM01-EQ,NSE:SYM02-EQ,NSE:SYM03-EQ,NSE:SYM04-EQ'
  });
  assert.equal(peakCalls, 1, 'Stock history must be serial to avoid Prime per-second 429 bursts');
  assert.equal(result.contextChecked, 4);
  assert.equal(result.contextVerified, 4);
  assert.equal(result.assessedRows.length, 4);
  assert.equal(result.watchlist.length, 4);
  assert.ok(result.assessedRows.every(row => row.status === 'WATCH' && row.score > 0));
});

test('Stock screening keeps a truthful MIXED score rather than inventing 85+', async () => {
  const get = async (path, params) => {
    if (path === '/quotes') return { d: [{ n: 'NSE:SYM01-EQ',
      s: 'ok', v: { lp: 120, chp: 3, tt: now / 1000 } }] };
    if (path === '/history') return {
      candles: params.resolution === '1D' ? makeDaily(1) : makeWeekly(-1)
    };
    throw new Error('Unexpected FYERS endpoint ' + path);
  };
  const result = await runStockContext(get, 'mixed-context-score-test', now, {
    symbols: 'NSE:SYM01-EQ'
  });
  assert.equal(result.contextVerified, 1);
  assert.equal(result.watchlist.length, 0);
  assert.equal(result.assessedRows[0].status, 'MIXED');
  assert.equal(result.assessedRows[0].score, 0);
  assert.equal(result.assessedRows[0].dayBias, 'BULLISH');
  assert.equal(result.assessedRows[0].weekBias, 'BEARISH');
});

test('Stock 429 propagates immediately and does not continue checking the remaining stocks', async () => {
  let requests = 0;
  const get = async (path, params) => {
    requests += 1;
    if (path === '/quotes') return { d: params.symbols.split(',').map(symbol => ({
      n: symbol, s: 'ok', v: { lp: 120, chp: 1.2, tt: now / 1000 }
    })) };
    throw Object.assign(new Error('FYERS temporary per-second limit'), { status: 429 });
  };
  await assert.rejects(() => runStockContext(get, 'context-429-no-storm-test', now, {
    symbols: 'NSE:SYM01-EQ,NSE:SYM02-EQ,NSE:SYM03-EQ'
  }), { status: 429 });
  assert.equal(requests, 2, 'Do not issue more FYERS calls after first 429');
});
