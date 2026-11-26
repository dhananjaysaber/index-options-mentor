// Estimate only: FYERS LTP is not a sellable bid and never guarantees execution.
// Never substitute persisted simulated position.currentPrice for a live option.
export const MAX_OPTION_MARK_AGE_MS = 5000;
export function freshOptionMark(quote, symbol, now = Date.now()) {
  if (!quote || typeof symbol !== 'string' || !symbol) return null;
  const at = Date.parse(quote.at || '');
  const ageMs = now - at;
  if (!Number.isFinite(at) || ageMs < -3000 || ageMs > MAX_OPTION_MARK_AGE_MS) return null;
  const prices = quote.optionPrices;
  const candidate = prices && Object.prototype.hasOwnProperty.call(prices, symbol)
    ? prices[symbol]
    : quote.optionSymbol === symbol ? quote.optionPrice : null;
  if (candidate == null || candidate === '') return null;
  const price = Number(candidate);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, at, ageMs, priceType: 'LTP' };
}
