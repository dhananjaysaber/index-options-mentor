export function calculateTradeAmountSizing(settings, optionPrice, lotSize) {
  const price = Number(optionPrice);
  const units = Number(lotSize);
  const empty = { lots: 0, quantity: 0, premiumCost: 0, tradeAmount: null, amountRemaining: null };
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(units) || units < 1) return empty;

  // Older callers retain their lot settings until they adopt the amount setting.
  if (settings?.tradeAmount === undefined) {
    const cap = Math.max(1, Math.floor(Number(settings?.lotCap) || 20));
    const lots = Math.max(1, Math.min(cap, Math.round(Number(settings?.defaultLots) || 1)));
    return { ...empty, lots, quantity: lots * units, premiumCost: lots * units * price };
  }

  const amount = Number(settings.tradeAmount);
  const budgetPaise = Math.floor(amount * 100);
  const pricePaise = Math.ceil(price * 100 - 1e-7);
  const costPerLot = pricePaise * units;
  if (!Number.isSafeInteger(budgetPaise) || budgetPaise <= 0 ||
      !Number.isSafeInteger(costPerLot) || costPerLot <= 0) return empty;
  const lots = Math.floor(budgetPaise / costPerLot);
  const quantity = lots * units;
  if (!Number.isSafeInteger(quantity)) return empty;
  return {
    lots, quantity, tradeAmount: budgetPaise / 100,
    premiumCost: quantity * pricePaise / 100,
    amountRemaining: (budgetPaise - lots * costPerLot) / 100
  };
}
