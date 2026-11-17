import { stockSetup } from './stockSignals.mjs';

// Ranked research universe only. An option is shown as actionable ONLY after
// confirmed candles, a valid FYERS derivative contract and live bid/ask depth.
const watchlist = [
  'RELIANCE', 'SBIN', 'ICICIBANK', 'HDFCBANK', 'INFY',
  'TCS', 'AXISBANK', 'BHARTIARTL', 'LT', 'KOTAKBANK',
  'BAJFINANCE', 'SUNPHARMA'
];
const candleCache = new Map();
const scans = new Map();
let masterPromise;
let masterExpires = 0;
const date = ms => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(ms);

async function symbolMaster() {
  if (!masterPromise || Date.now() >= masterExpires) {
    masterExpires = Date.now() + 3600000;
    masterPromise = fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json', {signal: AbortSignal.timeout(5000)})
      .then(response => {
        if (!response.ok) throw new Error('Contract master unavailable');
        return response.json();
      }).catch(error => {
        masterExpires = 0;
        throw error;
      });
  }
  return masterPromise;
}

async function candles(get, scope, symbol, resolution, now) {
  const key = [scope, symbol, resolution].join(':');
  const bucket = Math.floor((Math.floor(now / 1000) - 330 * 60) / (Number(resolution) * 60));
  const saved = candleCache.get(key);
  if (saved?.bucket === bucket) return saved.rows;
  const response = await get('/history', {
    symbol, resolution, date_format: '1', cont_flag: '1',
    range_from: date(now - 7 * 86400000), range_to: date(now)
  });
  if (!Array.isArray(response.candles)) throw new Error('Stock candles unavailable');
  if (candleCache.size >= 120) candleCache.clear();
  candleCache.set(key, { bucket, rows: response.candles });
  return response.candles;
}

function quoteValue(response, symbol) {
  const node = response?.d?.find(row => (row.n || row.v?.symbol) === symbol);
  const value = node?.v;
  const seconds = Number(value?.tt);
  if (node?.s !== 'ok' || !Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 30) return null;
  return value;
}


const currentSession = now => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(new Date(now));
function marketOpen(now) {
  const local = currentSession(now), part = name => local.find(item => item.type === name)?.value;
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  return !['Sat', 'Sun'].includes(part('weekday')) && minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
}
async function mapLimited(items, concurrency, fn) {
  const results = Array(items.length); let cursor = 0;
  const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers); return results;
}

function watchContext(five, three, now) {
  const seconds = Math.floor(now / 1000);
  const recent = (rows, minutes) => (Array.isArray(rows) ? rows : []).filter(row =>
    Array.isArray(row) && row.length >= 5 && row.slice(0, 5).every(Number.isFinite) &&
    row[0] + minutes * 60 <= seconds &&
    row[0] >= seconds - 60 * 60 * 3
  ).sort((a, b) => a[0] - b[0]);
  const f = recent(five, 5), t = recent(three, 3);
  if (f.length < 4 || t.length < 3) return {side: '', score: 0, status: 'WAIT', reason: 'Waiting for completed candles'};
  const last5 = f.at(-1), last3 = t.at(-1), earlier = f.at(-4);
  const change = (last5[4] - earlier[4]) / Math.max(0.01, earlier[4]);
  const move3 = (last3[4] - t.at(-3)[4]) / Math.max(0.01, t.at(-3)[4]);
  const side = Math.sign(change) === Math.sign(move3) && Math.abs(change) > 0.0004 && Math.abs(move3) > 0.00025
    ? (change > 0 ? 'CE' : 'PE') : '';
  const score = side ? Math.min(88, Math.round(45 + Math.min(24, Math.abs(change) * 4000) + Math.min(19, Math.abs(move3) * 6000))) : 0;
  return { side, score, status: side ? 'WATCH' : 'WAIT',
    reason: side ? '5m/3m momentum aligns; breakout and retest not yet confirmed' : 'No aligned completed 5m/3m momentum' };
}

async function scan(get, scope, now) {
  if (!marketOpen(now)) return { candidates: [], watchlist: [], failures: [], status: 'Outside NSE market hours', generatedAt: new Date(now).toISOString() };
  const symbolFor = stock => `NSE:${stock}-EQ`;
  const quote = await get('/quotes', { symbols: watchlist.map(symbolFor).join(',') });
  const failures = [];

  const checked = await mapLimited(watchlist, 2, async stock => {
    const symbol = symbolFor(stock);
    const underlying = quoteValue(quote, symbol);
    if (!underlying || !(Number(underlying.lp) > 0)) return { stock, status: 'UNAVAILABLE', reason: 'No fresh FYERS equity quote' };
    try {
      const [five, three] = await Promise.all([
        candles(get, scope, symbol, '5', now),
        candles(get, scope, symbol, '3', now)
      ]);
      const context = watchContext(five, three, now);
      const strict = stockSetup(five, three, now);
      return { stock, symbol, spot: Number(underlying.lp), changePct: Number(underlying.chp) || 0,
        ...context, ...(strict ? {side: strict.side, status: 'CONFIRMED', score: Math.max(context.score, 90), reason: strict.setup } : {}),
        strict };
    } catch (error) {
      if (error?.status === 429 || error?.status === 401) throw error;
      failures.push(stock);
      return { stock, symbol, spot: Number(underlying.lp), status: 'UNAVAILABLE', score: 0, reason: 'Stock candles unavailable' };
    }
  });

  const monitored = checked.sort((a, b) => (b.status === 'CONFIRMED') - (a.status === 'CONFIRMED')
    || Number(b.score || 0) - Number(a.score || 0) || watchlist.indexOf(a.stock) - watchlist.indexOf(b.stock)).slice(0, 10);
  const qualified = monitored.filter(row => row.strict);
  const master = qualified.length ? await symbolMaster().catch(() => null) : null;
  const candidates = await mapLimited(qualified, 2, async item => {
    try {
      if (!master) throw new Error('Contract master unavailable');
      const chain = await get('/options-chain-v3', { symbol: item.symbol, strikecount: 2, greeks: '1' });
      const data = chain?.data || chain;
      const expiry = Number(data?.expiryData?.[0]?.expiry);
      if (!Number.isFinite(expiry) || expiry <= now / 1000 || date(expiry * 1000) === date(now)) return null;
      const legs = (data?.optionsChain || []).filter(row =>
        row.option_type === item.side && row.symbol && Number.isFinite(Number(row.strike_price)));
      legs.sort((a, b) => Math.abs(a.strike_price - item.spot) - Math.abs(b.strike_price - item.spot));
      const leg = legs.find(row => master[row.symbol]?.tradeStatus !== 0 && Number(master[row.symbol]?.minLotSize) > 0);
      if (!leg) return null;
      const lotSize = Number(master[leg.symbol]?.minLotSize);
      const delta = Math.abs(Number(leg.greeks?.delta));
      if (!Number.isSafeInteger(lotSize) || !(delta > 0 && delta <= 1)) return null;
      const [optionQuote, depth] = await Promise.all([
        get('/quotes', { symbols: [item.symbol, leg.symbol].join(',') }),
        get('/depth', { symbol: leg.symbol, ohlcv_flag: 1 })
      ]);
      const spot = Number(quoteValue(optionQuote, item.symbol)?.lp);
      const option = quoteValue(optionQuote, leg.symbol);
      const min = item.strict.entry - item.strict.distance * 0.15;
      const max = item.strict.entry + item.strict.distance * 0.15;
      if (!(spot >= min && spot <= max) || !option) return null;
      const book = depth?.d?.[leg.symbol] || {};
      const bid = Number(book?.bids?.[0]?.price);
      const ask = Number(book?.ask?.[0]?.price);
      const bidSize = Number(book?.bids?.[0]?.volume);
      const askSize = Number(book?.ask?.[0]?.volume);
      if (!(bid > 0 && ask >= bid && bidSize > 0 && askSize > 0)) return null;
      const target = item.strict.entry + (item.side === 'CE' ? 1 : -1) * item.strict.distance * 2;
      return { ...item.strict, stock: item.stock, symbol: leg.symbol, underlyingSymbol: item.symbol,
        strike: Number(leg.strike_price), expiry: date(expiry * 1000),
        lotSize, delta, bid, ask, bidSize, askSize, min, max, target, spot,
        score: item.score, status: 'CONFIRMED', validUntil: Math.min(Number(option.tt) * 1000 + 20000, Date.now() + 20000) };
    } catch (error) {
      if (error?.status === 429 || error?.status === 401) throw error;
      failures.push(item.stock);
      return null;
    }
  });
  return { candidates: candidates.filter(Boolean), watchlist: monitored.map(({strict, ...row}) => row),
    failures: [...new Set(failures)],
    status: !checked.some(row => row.status !== 'UNAVAILABLE') ? 'FYERS stock data unavailable' : null,
    generatedAt: new Date(now).toISOString(),
    note: 'Rankings are momentum watch signals, not calibrated probabilities. Only confirmed contracts with fresh depth can be opened in paper mode.' };
}

export function runStockScan(get, scope, now = Date.now()) {
  const current = scans.get(scope);
  if (current && (current.pending || now < current.until)) return current.result;
  if (scans.size >= 20) {
    for (const [key, entry] of scans) {
      if (!entry.pending && now >= entry.until) scans.delete(key);
    }
    if (scans.size >= 20) throw Object.assign(new Error('Scanner busy'), {status: 429, code: 'SCANNER_BUSY'});
  }
  const entry = { pending: true, until: now + 25000 };
  entry.result = scan(get, scope, now).catch(error => {
    if (error.status === 429) entry.until = Date.now() + 120000;
    throw error;
  }).finally(() => { entry.pending = false; });
  scans.set(scope, entry);
  return entry.result;
}
