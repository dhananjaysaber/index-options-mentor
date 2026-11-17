export function rankStockCandidates(candidates, settings, now = Date.now()) {
  const lots = Number(settings.defaultLots);
  const capital = Number(settings.capital);
  const budget = capital * Number(settings.riskPct) / 100;
  if (!Number.isSafeInteger(lots) || lots < 1 || lots > Number(settings.lotCap) || !(budget > 0)) return [];
  return candidates.flatMap(candidate => {
    const quantity = lots * candidate.lotSize;
    const spread = candidate.ask - candidate.bid;
    // Paper-model allowance. Delta is an estimate, and the actual loss can exceed it.
    const friction = spread * quantity + 100;
    const distance = Math.abs(candidate.spot - candidate.stop);
    const risk = (distance * candidate.delta * quantity) + friction;
    const reward = Math.abs(candidate.target - candidate.spot) * candidate.delta * quantity - friction;
    if (candidate.validUntil <= now || Math.min(candidate.bidSize, candidate.askSize) < quantity ||
        candidate.ask * quantity + 100 > capital || risk > budget || reward < 1.2 * risk) return [];
    return [{ ...candidate, quantity, lots, risk, reward, ratio: reward / risk }];
  }).sort((a, b) => b.ratio - a.ratio || (a.ask - a.bid) - (b.ask - b.bid) ||
    Math.min(b.askSize, b.bidSize) - Math.min(a.askSize, a.bidSize)).slice(0, 10);
}
