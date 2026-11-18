import { stockSetup } from './stockSignals.mjs';

// Ranked research universe only. An option is shown as actionable ONLY after
// confirmed candles, a valid FYERS derivative contract and live bid/ask depth.
const MAX_DETAILED_STOCKS = 24;
const FYERS_QUOTE_BATCH = 50;
// No hard-coded stock candidates: the FYERS derivative master determines the universe.
const candleCache = new Map();
const scans = new Map();
let masterPromise;
let masterExpires = 0;
const date = ms => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit'}).format(ms);

async function symbolMaster() {
  if (!masterPromise || Date.now() >= masterExpires) {
    masterExpires = Date.now() + 3600000;
    masterPromise = fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json', {signal: AbortSignal.timeout(12000)})
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

function quoteValue(response, symbol, now = Date.now()) {
  // FYERS v3 documents v.tt as "today's time", NOT the last price tick.
  // Therefore rejecting when |now - tt| > 30 seconds incorrectly discards
  // valid quote rows across the entire equity watchlist.
  // Stock-only backend responses are marked with our actual receive time.
  const receivedAt = Number(response?.receivedAt);
  if (Number.isFinite(receivedAt) && receivedAt > 0 &&
      (Date.now() - receivedAt > 10000 || receivedAt - Date.now() > 1000)) return null;
  const node = response?.d?.find(row => (row?.n || row?.v?.symbol) === symbol);
  const value = node?.v;
  if (node?.s !== 'ok' || !(Number(value?.lp) > 0)) return null;
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


function localDate(ms) { return date(ms); }

// Authoritative NSE stock options universe from FYERS' regularly updated
// derivative master. Includes only names with current active CE and PE lots.
export function deriveFnoUniverse(master, now = Date.now()) {
  const entries = new Map();
  for (const record of Object.values(master || {})) {
    if (!record || !['CE', 'PE'].includes(record.optType)) continue;
    if (record.tradeStatus != null && Number(record.tradeStatus) !== 1) continue;
    const expiry = Number(record.expiryDate);
    if (!Number.isFinite(expiry) || expiry <= now / 1000 || localDate(expiry * 1000) === localDate(now)) continue;
    if (!(Number(record.minLotSize) > 0)) continue;
    const name = String(record.underSym || '').toUpperCase().trim().replace(/^NSE:/, '').replace(/-EQ$/, '');
    if (!/^[A-Z0-9&._-]{2,30}$/.test(name) || /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|SENSEX|BANKEX|NIFTYNXT50)$/.test(name)) continue;
    const symbol = 'NSE:' + name + '-EQ';
    const sides = entries.get(symbol) || new Set();
    sides.add(record.optType);
    entries.set(symbol, sides);
  }
  return [...entries].filter(([, sides]) => sides.size === 2)
    .map(([symbol]) => ({ symbol, stock: symbol.slice(4, -3) }))
    .sort((a, b) => a.stock.localeCompare(b.stock));
}

export function shortlistForSetups(rows, now = Date.now(), limit = MAX_DETAILED_STOCKS) {
  // Quote movement is only an inexpensive pre-filter. The recommendation
  // list later requires a completed, valid 5m + 3m stockSetup.
  const scored = rows.map(row => {
    const lp = Number(row.quote?.lp), open = Number(row.quote?.open_price);
    const dayMove = open > 0 ? (lp - open) / open * 100 : Number(row.quote?.chp) || 0;
    const high = Number(row.quote?.high_price), low = Number(row.quote?.low_price);
    const rangePct = high > low && open > 0 ? (high - low) / open * 100 : 0;
    const preScore = Math.abs(dayMove) * .75 + Math.min(4, rangePct) * .5;
    return { ...row, preScore, dayMove };
  }).filter(row => Number(row.quote?.lp) > 0)
    .sort((a, b) => b.preScore - a.preScore || a.stock.localeCompare(b.stock));
  const selected = new Map();
  const keep = list => { for (const row of list) if (selected.size < limit) selected.set(row.symbol, row); };
  keep(scored.filter(row => row.dayMove >= 0).slice(0, Math.floor(limit * .4)));
  keep(scored.filter(row => row.dayMove < 0).slice(0, Math.floor(limit * .4)));
  const others = scored.filter(row => !selected.has(row.symbol));
  const rotated = others.length ? Math.floor(now / 180000) % others.length : 0;
  keep([...others.slice(rotated), ...others.slice(0, rotated)]);
  return [...selected.values()].slice(0, limit);
}

function scoreConfirmedSetup(setup, five, three, now) {
  if (!setup) return 0;
  const seconds = Math.floor(now / 1000);
  const completed = (three || []).filter(row => row[0] + 180 <= seconds);
  const last = completed.at(-1);
  const fraction = last ? Math.abs(last[4] - last[1]) / Math.max(.01, last[2] - last[3]) : 0;
  const volumes = completed.slice(-7, -1).map(row => Number(row[5])).filter(x => x > 0);
  const avgVolume = volumes.length ? volumes.reduce((a,b) => a+b, 0) / volumes.length : 0;
  const closes = (five || []).filter(row => row[0] + 300 <= seconds).slice(-3).map(row => row[4]);
  const aligned = closes.length === 3 && (setup.side === 'CE'
    ? closes[0] <= closes[1] && closes[1] <= closes[2]
    : closes[0] >= closes[1] && closes[1] >= closes[2]);
  const riskPct = setup.distance / Math.max(.01, setup.entry);
  return Math.min(100, 65 + (fraction >= .55 ? 9 : fraction >= .35 ? 4 : 0)
    + (avgVolume && Number(last?.[5]) >= 1.2 * avgVolume ? 8 : 0)
    + (aligned ? 9 : 0)
    + (riskPct >= .0015 && riskPct <= .008 ? 6 : 0)
    + (seconds - setup.confirmedAt < 90 ? 3 : 0));
}

async function universeQuotes(get, universe, now) {
  const chunks = [];
  for (let i = 0; i < universe.length; i += FYERS_QUOTE_BATCH) chunks.push(universe.slice(i, i + FYERS_QUOTE_BATCH));
  const blocks = await mapLimited(chunks, 2, async chunk => {
    const result = await get('/quotes', { symbols: chunk.map(row => row.symbol).join(',') });
    return chunk.flatMap(row => {
      const quote = quoteValue(result, row.symbol, now);
      return quote && Number(quote.lp) > 0 ? [{ ...row, quote }] : [];
    });
  });
  return blocks.flat();
}


async function scan(get, scope, now, options = {}) {
  if (!marketOpen(now)) return { candidates: [], watchlist: [], failures: [], status: 'Outside NSE market hours', generatedAt: new Date(now).toISOString() };
  // Scan F&O eligibility from the exchange master. The preliminary live-quote
  // screen examines this whole universe; history calls are limited to 24
  // rotating, dynamically selected stocks to preserve the live Index feed.
  const master = options.master || await symbolMaster();
  const universe = deriveFnoUniverse(master, now);
  if (!universe.length) return { candidates: [], watchlist: [], failures: [],
    universeCount: 0, quotesChecked: 0, detailedChecked: 0,
    status: 'No active eligible NSE stock option underlyings in FYERS symbol master.',
    generatedAt: new Date(now).toISOString() };
  const quoted = await universeQuotes(get, universe, now);
  const shortlist = shortlistForSetups(quoted, now);
  const failures = [];

  const checked = await mapLimited(shortlist, 2, async row => {
    const { stock, symbol, quote } = row;
    try {
      const [five, three] = await Promise.all([
        candles(get, scope, symbol, '5', now),
        candles(get, scope, symbol, '3', now)
      ]);
      const strict = stockSetup(five, three, now);
      // No confirmed breakout/retest? The stock is NOT a top-ten candidate.
      if (!strict) return null;
      return { stock, symbol, spot: Number(quote.lp), changePct: Number(quote.chp) || 0,
        side: strict.side, status: 'CONFIRMED',
        score: scoreConfirmedSetup(strict, five, three, now),
        reason: strict.setup, strict };
    } catch (error) {
      if (error?.status === 429 || error?.status === 401) throw error;
      failures.push(stock);
      return null;
    }
  });
  const monitored = checked.filter(Boolean).sort((a, b) =>
    b.score - a.score || Math.abs(b.changePct) - Math.abs(a.changePct) ||
    a.stock.localeCompare(b.stock)).slice(0, 10);
  const qualified = monitored;
  const candidates = await mapLimited(qualified, 2, async item => {
    try {
      const chain = await get('/options-chain-v3', { symbol: item.symbol, strikecount: 2, greeks: '1' });
      const data = chain?.data || chain;
      const expiry = Number(data?.expiryData?.[0]?.expiry);
      if (!Number.isFinite(expiry) || expiry <= now / 1000 || date(expiry * 1000) === date(now)) return null;
      const legs = (data?.optionsChain || []).filter(row =>
        row.option_type === item.side && row.symbol && Number.isFinite(Number(row.strike_price)));
      legs.sort((a, b) => Math.abs(a.strike_price - item.spot) - Math.abs(b.strike_price - item.spot));
      const leg = legs.find(row => master[row.symbol]?.tradeStatus !== 0 && master[row.symbol]?.optType === item.side && Number(master[row.symbol]?.minLotSize) > 0);
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
        score: item.score, status: 'CONFIRMED', validUntil: Date.now() + 20000 };
    } catch (error) {
      if (error?.status === 429 || error?.status === 401) throw error;
      failures.push(item.stock);
      return null;
    }
  });
  return { candidates: candidates.filter(Boolean), watchlist: monitored.map(({strict, ...row}) => row),
    failures: [...new Set(failures)], universeCount: universe.length,
    quotesChecked: quoted.length, detailedChecked: shortlist.length,
    status: !monitored.length ? 'No confirmed 5m/3m stock-option setups in the current screened shortlist.' : null,
    generatedAt: new Date(now).toISOString(),
    note: 'Only completed and confirmed setups are ranked. Score represents structural strength, not the probability of profit. The detailed chart scan covers a dynamically selected subset of the F&O universe.' };
}

export function runStockScan(get, scope, now = Date.now(), options = {}) {
  const current = scans.get(scope);
  if (current && (current.pending || now < current.until)) return current.result;
  if (scans.size >= 20) {
    for (const [key, entry] of scans) {
      if (!entry.pending && now >= entry.until) scans.delete(key);
    }
    if (scans.size >= 20) throw Object.assign(new Error('Scanner busy'), {status: 429, code: 'SCANNER_BUSY'});
  }
  const entry = { pending: true, until: now + 25000 };
  entry.result = scan(get, scope, now, options).catch(error => {
    if (error.status === 429) entry.until = Date.now() + 120000;
    throw error;
  }).finally(() => { entry.pending = false; });
  scans.set(scope, entry);
  return entry.result;
}

// Reuse the existing validated FYERS symbol and candle helpers across the
// shorter Stock stages; no changes to the Index/Scalp engines.
export { symbolMaster, candles, quoteValue, marketOpen };
