// Stock-only virtual fill suitability. No Normal / Scalp calculation is used.
export function explainStockPaperEligibility(candidate, settings = {}, now = Date.now()) {
  const reasons = [];
  if (!candidate) return { eligible: false, reasons: ['Select a verified option contract first.'], metrics: null };
  const lots = Number(settings.defaultLots), capital = Number(settings.capital),
    cap = Number(settings.lotCap), riskPct = Number(settings.riskPct);
  const lotSize = Number(candidate.lotSize), delta = Math.abs(Number(candidate.delta));
  const ask = Number(candidate.ask), bid = Number(candidate.bid);
  const quantity = lots * lotSize, spread = ask - bid;
  const distance = Math.abs(Number(candidate.spot) - Number(candidate.stop));
  const friction = spread * quantity + 100;
  const budget = capital * riskPct / 100;
  const risk = distance * delta * quantity + friction;
  const reward = Math.abs(Number(candidate.target) - Number(candidate.spot)) * delta * quantity - friction;
  const ratio = risk > 0 ? reward / risk : 0;
  if (!(Number(candidate.validUntil) > now)) reasons.push('The contract preview expired; select Review paper trade again.');
  if (!Number.isSafeInteger(lots) || lots < 1 || lots > cap) reasons.push('Choose a whole number of lots within your configured lot cap.');
  if (!(Number.isSafeInteger(lotSize) && lotSize > 0 && delta > 0 && delta <= 1)) reasons.push('The current option lot size or delta is invalid.');
  if (!(ask > 0 && bid > 0 && spread >= 0)) reasons.push('Current option bid/ask is unavailable or invalid.');
  if (!(quantity > 0 && Number(candidate.askSize) >= quantity && Number(candidate.bidSize) >= quantity)) reasons.push('Not enough verified bid/ask depth for the selected lot quantity.');
  if (!(capital > 0 && budget > 0)) reasons.push('Set a positive paper capital and risk percentage in Settings.');
  if (!(ask * quantity + 100 <= capital)) reasons.push('Selected paper lots exceed the available paper capital.');
  if (!(Number.isFinite(risk) && risk > 0 && risk <= budget)) reasons.push('Estimated loss exceeds the configured paper risk budget.');
  if (!(Number.isFinite(reward) && reward >= 1.2 * risk)) reasons.push('Estimated reward is below the minimum 1.2R requirement after spread and friction.');
  const metrics = { lots, quantity, risk, reward, ratio, budget, capital, spread };
  return { eligible: reasons.length === 0, reasons, metrics };
}

export function rankStockCandidates(candidates, settings, now = Date.now()) {
  return candidates.flatMap(candidate => {
    const result = explainStockPaperEligibility(candidate, settings, now);
    if (!result.eligible) return [];
    return [{ ...candidate, ...result.metrics }];
  }).sort((a, b) => b.ratio - a.ratio || (a.ask - a.bid) - (b.ask - b.bid) ||
    Math.min(b.askSize, b.bidSize) - Math.min(a.askSize, a.bidSize)).slice(0, 10);
}
