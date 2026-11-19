import { runStockContext } from './stockStages.mjs';
import { symbolMaster, quoteValue, marketOpen } from './stockScanner.mjs';
import { NSE_FNO_SCREENING_SEED } from './stockUniverseSeed.mjs';

const MIN_MANUAL_SCORE = 85;
const dateIST = millis => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(millis));

const fail = (message, status = 422) => ({ error: message, status });
const number = value => Number.isFinite(Number(value)) ? Number(value) : NaN;

// This is a manual PAPER research exception, not an auto-approved 3-minute signal.
// A screenshot/client-supplied 85 is never trusted. Verify the current
// completed weekly and daily data on the server before selecting any contract.
export async function prepareManualStockPaperTicket(get, scope, query, now = Date.now(), options = {}) {
  if (!marketOpen(now)) return fail('Manual Stock paper tickets can be prepared during NSE market hours only.', 409);
  const stock = String(query?.stock || '').trim().toUpperCase();
  const side = String(query?.side || '').trim().toUpperCase();
  if (!NSE_FNO_SCREENING_SEED.includes(stock) || !['CE','PE'].includes(side)) {
    return fail('Select an eligible Stock WATCH candidate and its CE/PE direction.', 400);
  }
  const underlyingSymbol = 'NSE:' + stock + '-EQ';
  // The Stock context endpoint already verified the completed weekly/daily
  // candles and issued a session-bound signed grant. Do not fetch those
  // candles AGAIN while the user is trying to open a manual paper ticket.
  // Without a valid proof, the current PWA must re-scan first.
  if (options.requireGrant && !options.validatedWatch) {
    return fail('The verified 85+ WATCH confirmation expired. Tap Scan now and then Manual paper again.', 409);
  }
  const verified = options.validatedWatch
    ? { watchlist: [options.validatedWatch] }
    : await runStockContext(get, scope, now, { symbols: underlyingSymbol });
  const watch = verified.watchlist?.find(row =>
    row.stock === stock && row.side === side && row.status === 'WATCH' &&
    Number(row.score) >= MIN_MANUAL_SCORE &&
    row.weekBias === row.dayBias &&
    (side === 'CE' ? row.weekBias === 'BULLISH' : row.weekBias === 'BEARISH'));
  if (!watch) return fail('Manual paper entry requires a currently verified aligned weekly/daily score of at least 85/100.', 409);
  // Start the option-master download in parallel with the option chain, rather
  // than making the first watchlist request wait for it.
  let master, chain;
  try {
    [master, chain] = await Promise.all([
      options.master ? Promise.resolve(options.master) : symbolMaster(),
      get('/options-chain-v3', { symbol: underlyingSymbol, strikecount: 3, greeks: '1' })
    ]);
  } catch (error) {
    if (error?.status === 429 || error?.status === 401) throw error;
    return fail('FYERS could not verify the option contract and lot size. No paper entry was opened; please try again.', 503);
  }
  const data = chain?.data || chain;
  const expiry = number(data?.expiryData?.[0]?.expiry);
  if (!(expiry > now / 1000) || dateIST(expiry * 1000) === dateIST(now)) {
    return fail('No valid non-expiring-today FYERS option expiry is available.');
  }
  const spot = number(watch.spot);
  if (!(spot > 0)) return fail('No current verified stock price available.');
  const optionsList = (data?.optionsChain || []).filter(row =>
    row?.option_type === side && row?.symbol &&
    Number.isFinite(number(row.strike_price)))
    .sort((a,b)=>Math.abs(number(a.strike_price)-spot)-Math.abs(number(b.strike_price)-spot));
  const leg = optionsList.find(row => {
    const instrument = master[row.symbol];
    return number(instrument?.minLotSize) > 0 && instrument?.optType === side &&
      Number(instrument?.tradeStatus) === 1; // Expiry is verified against the live FYERS option chain above.
  });
  if (!leg) return fail('No current exchange-listed FYERS option with a verified lot size was found.');
  const lotSize = number(master[leg.symbol].minLotSize);
  const delta = Math.abs(number(leg.greeks?.delta));
  if (!Number.isSafeInteger(lotSize) || !(delta > 0 && delta <= 1)) {
    return fail('The option lot size or delta could not be verified.');
  }
  const [quotes, depth] = await Promise.all([
    get('/quotes', { symbols: [underlyingSymbol, leg.symbol].join(',') }),
    get('/depth', { symbol: leg.symbol, ohlcv_flag: 1 })
  ]);
  const currentSpot = number(quoteValue(quotes, underlyingSymbol, now)?.lp);
  const optQuote = quoteValue(quotes, leg.symbol, now);
  const book = depth?.d?.[leg.symbol] || {};
  const bid = number(book.bids?.[0]?.price);
  const ask = number((book.asks || book.ask)?.[0]?.price);
  const bidSize = number(book.bids?.[0]?.volume);
  const askSize = number((book.asks || book.ask)?.[0]?.volume);
  if (!(currentSpot > 0 && optQuote && bid > 0 && ask >= bid && bidSize >= lotSize && askSize >= lotSize)) {
    return fail('Current option quote, bid/ask prices or executable depth could not be verified.');
  }
  // Modelled levels for a manual exception; these are NOT the verified
  // intraday breakout stops. Recheck current risk on actual paper open.
  const modelDistance = currentSpot * 0.0075;
  const stop = side === 'CE' ? currentSpot - modelDistance : currentSpot + modelDistance;
  const target = side === 'CE' ? currentSpot + modelDistance * 2 : currentSpot - modelDistance * 2;
  return {
    stock, side, status: 'MANUAL_RESEARCH', approvalState: 'STOCK_WATCH_85_MANUAL',
    manualOverride: true, strictEligible: false,
    score: watch.score, weekBias: watch.weekBias, dayBias: watch.dayBias,
    reason: watch.reason, stockLastPrice: currentSpot, underlyingSymbol,
    setup: 'Manual 85+ weekly/daily research; 5-minute/3-minute trigger not confirmed',
    confirmedAt: now, validUntil: Date.now() + 120000,
    symbol: leg.symbol, strike: number(leg.strike_price), expiry: dateIST(expiry * 1000),
    lotSize, delta, bid, ask, bidSize, askSize,
    spot: currentSpot, stop, target, min: currentSpot * 0.997, max: currentSpot * 1.003,
    entry: currentSpot, distance: modelDistance,
    warning: 'Manual research exception. Illustrative 0.75% underlying stop and 1.5% target; neither is an approved 5m/3m trigger nor guaranteed option loss.'
  };
}
