import { symbolMaster, marketOpen, quoteValue } from './stockScanner.mjs';
import { NSE_FNO_SCREENING_SEED } from './stockUniverseSeed.mjs';

function dateKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
// Manual research intentionally does NOT claim an approved 3m trigger.
// It still requires a real FYERS tradable CE/PE contract and spread.
export async function prepareStockPaperTicket(get, query, now = Date.now(), options = {}) {
  if (!marketOpen(now)) return { error: 'Paper-entry quotes are available during NSE market hours only.', status: 409 };
  const stock = String(query?.stock || '').toUpperCase().trim();
  const side = String(query?.side || '').toUpperCase();
  if (!NSE_FNO_SCREENING_SEED.includes(stock) || !['CE', 'PE'].includes(side)) {
    return { error: 'Choose a stock and CE/PE direction from the F&O watchlist.', status: 400 };
  }
  const underlyingSymbol = 'NSE:' + stock + '-EQ';
  const [chain, equity, master] = await Promise.all([
    get('/options-chain-v3', { symbol: underlyingSymbol, strikecount: 3, greeks: '1' }),
    get('/quotes', { symbols: underlyingSymbol }),
    options.master ? Promise.resolve(options.master) : symbolMaster()
  ]);
  const spot = Number(quoteValue(equity, underlyingSymbol, now)?.lp);
  if (!(spot > 0)) return { error: 'Fresh underlying quote unavailable.', status: 422 };
  const data = chain?.data || chain;
  const expiry = Number(data?.expiryData?.[0]?.expiry);
  if (!(expiry > now / 1000) || dateKey(expiry * 1000) === dateKey(now)) {
    return { error: 'No verified non-expiring-today option expiry.', status: 422 };
  }
  const legs = (data?.optionsChain || []).filter(row => row?.option_type === side &&
    row?.symbol && Number.isFinite(Number(row?.strike_price)))
    .sort((a,b)=>Math.abs(Number(a.strike_price)-spot)-Math.abs(Number(b.strike_price)-spot));
  const leg = legs.find(row =>
    Number(master?.[row.symbol]?.minLotSize) > 0 &&
    master?.[row.symbol]?.optType === side &&
    master?.[row.symbol]?.tradeStatus !== 0);
  if (!leg) return { error: 'No active FYERS contract with verified lot size was available.', status: 422 };
  const lotSize = Number(master[leg.symbol].minLotSize);
  const delta = Math.abs(Number(leg.greeks?.delta));
  if (!Number.isSafeInteger(lotSize) || !(delta > 0 && delta <= 1)) {
    return { error: 'Lot size or option delta could not be verified.', status: 422 };
  }
  const [quotes, depth] = await Promise.all([
    get('/quotes', { symbols: [underlyingSymbol, leg.symbol].join(',') }),
    get('/depth', { symbol: leg.symbol, ohlcv_flag: 1 })
  ]);
  const currentSpot = Number(quoteValue(quotes, underlyingSymbol, now)?.lp);
  const option = quoteValue(quotes, leg.symbol, now);
  const book = depth?.d?.[leg.symbol] || {};
  const bid = Number(book?.bids?.[0]?.price);
  const ask = Number((book?.ask || book?.asks)?.[0]?.price);
  const bidSize = Number(book?.bids?.[0]?.volume), askSize = Number((book?.ask || book?.asks)?.[0]?.volume);
  if (!(currentSpot > 0 && option && bid > 0 && ask >= bid && bidSize >= lotSize && askSize >= lotSize)) {
    return { error: 'Option quote or bid/ask order-book liquidity could not be verified.', status: 422 };
  }
  // Fixed protective stop for explicit MANUAL RESEARCH. This is not
  // verified structure or predictive option pricing.
  const riskPoints = currentSpot * .0075;
  const stop = side === 'CE' ? currentSpot - riskPoints : currentSpot + riskPoints;
  const target = side === 'CE' ? currentSpot + 2 * riskPoints : currentSpot - 2 * riskPoints;
  return {
    status: 'MANUAL_RESEARCH', strictEligible: false, stock, side,
    symbol: leg.symbol, underlyingSymbol,
    setup: 'Manual weekly/daily research override (no approved 3m trigger)',
    confirmedAt: now, validUntil: Date.now() + 60000,
    strike: Number(leg.strike_price), expiry: dateKey(expiry * 1000),
    lotSize, delta, bid, ask, bidSize, askSize, spot: currentSpot,
    stop, target, min: currentSpot * .997, max: currentSpot * 1.003,
    entry: currentSpot, distance: riskPoints,
    warning: 'Manual research: 0.75% underlying model stop and 1.5% model target; not a verified breakout entry.'
  };
}
