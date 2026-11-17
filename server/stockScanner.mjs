import { stockSetup } from './stockSignals.mjs';

const watchlist = ['RELIANCE', 'SBIN', 'ICICIBANK'];
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

async function scan(get, scope, now) {
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now);
  const part = name => local.find(item => item.type === name)?.value;
  const minute = Number(part('hour')) * 60 + Number(part('minute'));
  if (['Sat', 'Sun'].includes(part('weekday')) || minute < 570 || minute >= 930) {
    return { candidates: [], status: 'Outside the scanner session' };
  }
  const candidates = [];
  const failures = [];
  for (const stock of watchlist) {
    const symbol = `NSE:${stock}-EQ`;
    try {
      const five = await candles(get, scope, symbol, '5', now);
      const three = await candles(get, scope, symbol, '3', now);
      const setup = stockSetup(five, three, now);
      if (!setup) continue;

      const chain = await get('/options-chain-v3', { symbol, strikecount: 2, greeks: '1' });
      const expiry = Number(chain.data?.expiryData?.[0]?.expiry);
      if (!Number.isFinite(expiry) || expiry <= now / 1000 || date(expiry * 1000) === date(now)) continue;
      const legs = (chain.data?.optionsChain ?? []).filter(row =>
        row.option_type === setup.side && row.symbol && Number.isFinite(Number(row.strike_price)));
      legs.sort((a, b) => Math.abs(a.strike_price - setup.entry) - Math.abs(b.strike_price - setup.entry));
      const leg = legs[0];
      if (!leg) continue;

      const master = await symbolMaster();
      const lotSize = Number(master?.[leg.symbol]?.minLotSize);
      const delta = Math.abs(Number(leg.greeks?.delta));
      if (!Number.isSafeInteger(lotSize) || lotSize < 1 || !(delta > 0 && delta <= 1)) continue;

      const quote = await get('/quotes', { symbols: [symbol, leg.symbol].join(',') });
      const spot = Number(quoteValue(quote, symbol)?.lp);
      const option = quoteValue(quote, leg.symbol);
      const min = setup.entry - setup.distance * 0.15;
      const max = setup.entry + setup.distance * 0.15;
      if (!(spot >= min && spot <= max) || !option) continue;

      const depth = await get('/depth', { symbol: leg.symbol, ohlcv_flag: 1 });
      const book = depth.d?.[leg.symbol];
      const bid = Number(book?.bids?.[0]?.price);
      const ask = Number(book?.ask?.[0]?.price);
      const bidSize = Number(book?.bids?.[0]?.volume);
      const askSize = Number(book?.ask?.[0]?.volume);
      if (!(bid > 0 && ask >= bid && bidSize > 0 && askSize > 0)) continue;
      if (!quoteValue(quote, symbol) || !quoteValue(quote, leg.symbol)) continue;
      const target = setup.entry + (setup.side === 'CE' ? 1 : -1) * setup.distance * 2;
      candidates.push({ ...setup, stock, symbol: leg.symbol, strike: Number(leg.strike_price),
        expiry: date(expiry * 1000), lotSize, delta, bid, ask, bidSize, askSize, min, max, target, spot,
        validUntil: Math.min(Number(option.tt) * 1000 + 30000, Date.now() + 30000) });
    } catch (error) {
      if (error.status === 429 || error.status === 401) throw error;
      failures.push(stock);
    }
  }
  return { candidates, failures, status: failures.length === watchlist.length ? 'Stock market data unavailable' : null };
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
  const entry = { pending: true, until: now + 30000 };
  let nextRequestAt = 0;
  async function pacedGet(path, params) {
    const wait = nextRequestAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextRequestAt = Date.now() + 400;
    return get(path, params);
  }
  entry.result = scan(pacedGet, scope, now).catch(error => {
    if (error.status === 429) entry.until = Date.now() + 120000;
    throw error;
  }).finally(() => { entry.pending = false; });
  scans.set(scope, entry);
  return entry.result;
}
