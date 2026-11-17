import { stockSetup } from './stockSignals.mjs';
import { equityScreeningSymbols } from './stockUniverseSeed.mjs';
import {
  symbolMaster, deriveFnoUniverse, shortlistForSetups, quoteValue, marketOpen, candles
} from './stockScanner.mjs';

const quoteBatchSize = 50;
const stageCache = new Map();
const historyCache = new Map();
const formatDate = timestamp => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(timestamp));

function validSymbols(csv, max = 12) {
  const all = String(csv || '').split(',').map(value => value.trim().toUpperCase())
    .filter(value => /^NSE:[A-Z0-9&._-]{2,30}-EQ$/.test(value));
  return [...new Set(all)].slice(0, max);
}

async function mapLimited(items, limit, fn) {
  let cursor = 0;
  const result = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index], index);
    }
  }));
  return result;
}

function responseBase(now, stage) {
  return { phase: stage, generatedAt: new Date(now).toISOString(), candidates: [], watchlist: [], failures: [], status: null };
}

export async function runStockUniverse(get, scope, now = Date.now(), options = {}) {
  const base = responseBase(now, 'universe');
  if (!marketOpen(now)) return { ...base, status: 'Outside NSE market hours' };
  // The first screen must NOT download FYERS's large option-contract master.
  // Use a broad reference universe, then validate every stock by fresh live
  // FYERS quotes and, before paper entry, verify exact active CE/PE contracts.
  const universe = options.universe || equityScreeningSymbols();
  if (!universe.length) return { ...base, universeCount: 0,
    status: 'No equity F&O screening universe was configured.' };

  const batches = [];
  for (let i = 0; i < universe.length; i += quoteBatchSize) batches.push(universe.slice(i, i + quoteBatchSize));
  const failures = [];
  const batchResults = await mapLimited(batches, 3, async batch => {
    try {
      const quotes = await get('/quotes', { symbols: batch.map(row => row.symbol).join(',') });
      return batch.flatMap(row => {
        const price = quoteValue(quotes, row.symbol, now);
        return price && Number(price.lp) > 0 ? [{ ...row, quote: price }] : [];
      });
    } catch (error) {
      if (error?.status === 429 || error?.status === 401) throw error;
      failures.push(error?.message || 'One FYERS quote batch timed out');
      return [];
    }
  });
  const quoted = batchResults.flat();
  const selected = shortlistForSetups(quoted, now, 12);
  const prescreen = selected.map(row => ({
    stock: row.stock, symbol: row.symbol, spot: Number(row.quote.lp),
    changePct: Number(row.quote.chp) || 0,
    status: 'SCREENING',
    side: Number(row.dayMove) >= 0 ? 'CE' : 'PE', score: 0,
    reason: (Number(row.dayMove) >= 0 ? 'Bullish' : 'Bearish') + ' intraday mover; weekly/daily trend not yet verified'
  }));
  return { ...base, universeCount: universe.length, quotesChecked: quoted.length,
    source: 'Reference NSE F&O screening pool; confirm current exchange eligibility at entry',
    prescreen, watchlist: prescreen, contextChecked: 0, detailedChecked: 0,
    quoteBatchErrors: failures.length,
    status: prescreen.length ? null : 'No fresh FYERS equity quotes received. Market data may be unavailable.' };
}

// Weekly/daily history remains cached until the next closed day or week;
// intraday entry candles are intentionally fetched independently.
async function historic(get, scope, symbol, resolution, now) {
  const key = [scope, symbol, resolution].join('|');
  const ttl = resolution === '1W' ? 15 * 60 * 1000 : 5 * 60 * 1000;
  const record = historyCache.get(key);
  if (record && now < record.until) return record.rows;
  const days = resolution === '1W' ? 260 : 65;
  const result = await get('/history', {
    symbol, resolution, date_format: '1', cont_flag: '1',
    range_from: formatDate(now - days * 86400000), range_to: formatDate(now)
  });
  if (!Array.isArray(result?.candles)) throw new Error('Unable to read ' + resolution + ' candles');
  if (historyCache.size > 150) historyCache.clear();
  historyCache.set(key, { rows: result.candles, until: now + ttl });
  return result.candles;
}

function completedCandles(rows, now, period) {
  const shifted = now + 330 * 60000;
  const today = Math.floor(shifted / 86400000);
  const monday = today - ((new Date(shifted).getUTCDay() + 6) % 7);
  return (rows || []).filter(row => Array.isArray(row) && row.length >= 6 &&
    row.slice(0, 5).every(Number.isFinite) &&
    (period === 'day'
      ? Math.floor((row[0] * 1000 + 330 * 60000) / 86400000) < today
      : Math.floor((row[0] * 1000 + 330 * 60000) / 86400000) < monday))
    .sort((a, b) => a[0] - b[0]);
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function analyseWeeklyDaily(daily, weekly, now = Date.now(), spot = 0) {
  const day = completedCandles(daily, now, 'day');
  const week = completedCandles(weekly, now, 'week');
  if (day.length < 8 || week.length < 6) return {
    status: 'INSUFFICIENT', side: '', score: 0, weekBias: '—', dayBias: '—',
    reason: 'Waiting for at least 8 completed daily and 6 completed weekly candles'
  };
  const d = day.at(-1), dPrev = day.at(-2), w = week.at(-1), wPrev = week.at(-2);
  const dAvg = avg(day.slice(-6, -1).map(row => row[4]));
  const wAvg = avg(week.slice(-5, -1).map(row => row[4]));
  const dailyBull = d[4] > dAvg && d[4] >= dPrev[4];
  const dailyBear = d[4] < dAvg && d[4] <= dPrev[4];
  const weeklyBull = w[4] > wAvg && w[4] >= wPrev[4];
  const weeklyBear = w[4] < wAvg && w[4] <= wPrev[4];
  const dayBias = dailyBull ? 'BULLISH' : dailyBear ? 'BEARISH' : 'MIXED';
  const weekBias = weeklyBull ? 'BULLISH' : weeklyBear ? 'BEARISH' : 'MIXED';
  const aligned = dayBias !== 'MIXED' && dayBias === weekBias;
  const side = aligned ? (dayBias === 'BULLISH' ? 'CE' : 'PE') : '';
  const dayVol = avg(day.slice(-6, -1).map(row => Number(row[5]) || 0));
  const volExpansion = dayVol > 0 && d[5] >= dayVol * 1.2;
  const nearBreak = side === 'CE' ? spot >= d[2] * .998
    : side === 'PE' ? spot <= d[3] * 1.002 : false;
  const score = side ? Math.min(95, 60 +
    Math.min(15, Math.abs((d[4] - dAvg) / dAvg) * 2000) +
    Math.min(10, Math.abs((w[4] - wAvg) / wAvg) * 600) +
    (volExpansion ? 6 : 0) + (nearBreak ? 8 : 0)) : 0;
  return {
    weekBias, dayBias, side, score: Math.round(score),
    status: aligned ? 'WATCH' : 'MIXED',
    reason: aligned
      ? (side === 'CE' ? 'Weekly + daily bullish; awaiting 5m/3m CE trigger' :
        'Weekly + daily bearish; awaiting 5m/3m PE trigger')
      : 'Weekly and daily directions are not aligned',
    lastWeeklyClose: w[4], lastDailyClose: d[4],
    priorDailyHigh: d[2], priorDailyLow: d[3],
    dailyVolumeExpansion: volExpansion
  };
}

export async function runStockContext(get, scope, now = Date.now(), query = {}, options = {}) {
  const base = responseBase(now, 'context');
  if (!marketOpen(now)) return { ...base, status: 'Outside NSE market hours' };
  const symbols = validSymbols(query.symbols, 12);
  if (!symbols.length) return { ...base, status: 'Choose stocks from the active F&O quote shortlist.' };
  const quotes = options.quotes || await get('/quotes', { symbols: symbols.join(',') });
  const failures = [];
  const checked = await mapLimited(symbols, 4, async symbol => {
    const quote = quoteValue(quotes, symbol, now);
    if (!quote) return null;
    try {
      const [daily, weekly] = await Promise.all([
        historic(get, scope, symbol, '1D', now),
        historic(get, scope, symbol, '1W', now)
      ]);
      const context = analyseWeeklyDaily(daily, weekly, now, Number(quote.lp));
      const stock = symbol.slice(4, -3);
      return { stock, symbol, spot: Number(quote.lp), changePct: Number(quote.chp) || 0, ...context };
    } catch (error) {
      if (error?.status === 401 || error?.status === 429) throw error;
      failures.push(symbol.slice(4, -3));
      return null;
    }
  });
  const all = checked.filter(Boolean);
  const watchlist = all.filter(row => row.status === 'WATCH')
    .sort((a, b) => b.score - a.score || a.stock.localeCompare(b.stock)).slice(0, 10);
  stageCache.set(scope, { at: now, watchlist });
  if (stageCache.size > 20) stageCache.clear();
  return { ...base, watchlist, contextChecked: symbols.length, failures,
    neutralCount: all.length - watchlist.length, status: watchlist.length ? null
      : 'No aligned completed weekly/daily trends among the screened stocks. The preliminary market watchlist remains available.' };
}

export async function runStockEntryCheck(get, scope, now = Date.now(), query = {}, options = {}) {
  const base = responseBase(now, 'entry');
  if (!marketOpen(now)) return { ...base, status: 'Outside NSE market hours' };
  const symbols = validSymbols(query.symbols, 5);
  if (!symbols.length) return { ...base, status: 'No weekly/daily watch candidates for entry checks.' };
  const bias = new Map(String(query.bias || '').split(',').map(value => value.split(':'))
    .filter(([stock, side]) => /^[A-Z0-9&._-]{2,30}$/.test(stock || '') && ['CE', 'PE'].includes(side)));
  const failures = [];
  const checked = await mapLimited(symbols, 3, async symbol => {
    try {
      const [five, three] = await Promise.all([
        candles(get, scope, symbol, '5', now), candles(get, scope, symbol, '3', now)
      ]);
      const setup = stockSetup(five, three, now);
      const stock = symbol.slice(4, -3);
      if (!setup || bias.get(stock) !== setup.side) return null;
      return { stock, symbol, setup };
    } catch (error) {
      if (error?.status === 401 || error?.status === 429) throw error;
      failures.push(symbol.slice(4, -3));
      return null;
    }
  });
  const confirmed = checked.filter(Boolean);
  if (!confirmed.length) return { ...base, detailedChecked: symbols.length, failures,
    status: 'Watching 5-minute structure and 3-minute confirmation; no valid triggers yet.' };

  const master = options.master || await symbolMaster();
  const candidates = await mapLimited(confirmed.slice(0, 3), 2, async row => {
    try {
      const chain = await get('/options-chain-v3', { symbol: row.symbol, strikecount: 2, greeks: '1' });
      const data = chain?.data || chain;
      const expiry = Number(data?.expiryData?.[0]?.expiry);
      if (!(expiry > now / 1000) || formatDate(expiry * 1000) === formatDate(now)) return null;
      const legs = (data?.optionsChain || []).filter(item =>
        item.option_type === row.setup.side && item.symbol && Number.isFinite(Number(item.strike_price)));
      const spotQuote = await get('/quotes', { symbols: row.symbol });
      const spot = Number(quoteValue(spotQuote, row.symbol, now)?.lp);
      if (!(spot > 0)) return null;
      legs.sort((a,b)=>Math.abs(Number(a.strike_price)-spot)-Math.abs(Number(b.strike_price)-spot));
      const leg = legs.find(item => Number(master[item.symbol]?.minLotSize) > 0 &&
        master[item.symbol]?.optType === row.setup.side && master[item.symbol]?.tradeStatus !== 0);
      if (!leg) return null;
      const delta = Math.abs(Number(leg.greeks?.delta));
      const lotSize = Number(master[leg.symbol].minLotSize);
      if (!Number.isSafeInteger(lotSize) || !(delta > 0 && delta <= 1)) return null;
      const [optionQuote, depth] = await Promise.all([
        get('/quotes', { symbols: [row.symbol, leg.symbol].join(',') }),
        get('/depth', { symbol: leg.symbol, ohlcv_flag: 1 })
      ]);
      const currentSpot = Number(quoteValue(optionQuote, row.symbol, now)?.lp);
      const option = quoteValue(optionQuote, leg.symbol, now);
      const min = row.setup.entry - row.setup.distance * .15;
      const max = row.setup.entry + row.setup.distance * .15;
      const book = depth?.d?.[leg.symbol] || {};
      const bid = Number(book.bids?.[0]?.price), ask = Number(book.asks?.[0]?.price);
      const bidSize = Number(book.bids?.[0]?.volume), askSize = Number(book.asks?.[0]?.volume);
      if (!(currentSpot >= min && currentSpot <= max && option && bid > 0 &&
        ask >= bid && bidSize > 0 && askSize > 0)) return null;
      return { ...row.setup, stock: row.stock, symbol: leg.symbol, underlyingSymbol: row.symbol,
        strike: Number(leg.strike_price), expiry: formatDate(expiry * 1000),
        lotSize, delta, bid, ask, bidSize, askSize, min, max, spot: currentSpot,
        target: row.setup.entry + (row.setup.side === 'CE' ? 1 : -1) * row.setup.distance * 2,
        validUntil: Math.min(Number(option.tt) * 1000 + 20000, now + 20000),
        status: 'CONFIRMED', setupScore: 90 };
    } catch (error) {
      if (error?.status === 401 || error?.status === 429) throw error;
      failures.push(row.stock);
      return null;
    }
  });
  return { ...base, candidates: candidates.filter(Boolean), detailedChecked: symbols.length,
    failures, status: candidates.some(Boolean) ? null :
      'Intraday trigger found, but no option contract passed live liquidity and price checks.' };
}
