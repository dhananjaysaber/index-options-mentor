/*
 * 13-Point NIFTY target-based runner stop — simulated positions only.
 * Separate from the option-premium profit trail and from Scalp.
 *
 * Today (20 Nov 2026) a strong CE trade exceeded its planned NIFTY target.
 * We therefore treat that target as the FIRST PROFIT STOP, not a sell trigger:
 * - The target itself never closes the 13-Point position.
 * - Arm only after NIFTY moves another +0.25 original-risk units (R)
 *   past the target, to avoid an exit on the first target touch.
 * - Once armed, the stop starts at the original NIFTY target.
 * - Continue raising the stop to 0.50R behind the best observed NIFTY
 *   move, without ever allowing it to fall below the target or retreat.
 * - The same rules work in reverse for PE positions.
 * - Exit only if a FRESH, matching NIFTY quote breaches that stop AND a
 *   fresh quote for the exact open option contract exists. The simulated exit
 *   is priced at the actual observed OPTION LTP, not at the NIFTY stop.
 *
 * THIS IS NOT a FYERS / exchange stop order, a guaranteed fill, a trade
 * recommendation, or protection while the PWA is suspended/offline.
 */
export const CORE_TARGET_INDEX_ARM_BUFFER_R = 0.25;
export const CORE_TARGET_INDEX_GIVEBACK_R = 0.50;
export const CORE_TARGET_INDEX_QUOTE_FRESH_MS = 6000;

const positive = value => value == null || value === '' ? null :
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const finite = value => value == null || value === '' ? null :
  Number.isFinite(Number(value)) ? Number(value) : null;

export function computeCoreTargetIndexTrail({
  side, underlyingEntry, underlyingStop, underlyingTarget, bestR,
  previousFloorNifty = null
}) {
  const direction = side === 'CE' ? 1 : side === 'PE' ? -1 : 0;
  const entry = positive(underlyingEntry);
  const hardStop = positive(underlyingStop);
  const target = positive(underlyingTarget);
  const best = finite(bestR);
  const previous = positive(previousFloorNifty);
  const riskPoints = entry != null && hardStop != null ? Math.abs(entry - hardStop) : null;
  const targetR = direction && entry != null && target != null && riskPoints > 0
    ? direction * (target - entry) / riskPoints : null;

  const invalid = !direction || riskPoints == null || riskPoints < .01 ||
    targetR == null || targetR <= 0 ||
    direction * (entry - hardStop) <= 0;
  if (invalid) {
    return { active: false, floorNifty: null, targetR: null, armAtNifty: null,
      bestR: best, riskPoints: null, givebackR: CORE_TARGET_INDEX_GIVEBACK_R };
  }

  const armAtR = targetR + CORE_TARGET_INDEX_ARM_BUFFER_R;
  const armAtNifty = entry + direction * riskPoints * armAtR;
  const wasActive = previous != null && direction * (previous - target) >= -0.000001;
  const active = wasActive || best != null && best >= armAtR - 0.000001;
  if (!active) {
    return { active: false, floorNifty: null, targetR, armAtNifty,
      bestR: best, riskPoints, givebackR: CORE_TARGET_INDEX_GIVEBACK_R };
  }

  // Target is the baseline profit stop. A strong trend can keep running.
  const proposedFloorR = Math.max(targetR, (best ?? targetR) - CORE_TARGET_INDEX_GIVEBACK_R);
  const proposed = entry + direction * proposedFloorR * riskPoints;
  const floorNifty = previous == null ? proposed :
    direction === 1 ? Math.max(previous, proposed, target) :
      Math.min(previous, proposed, target);

  return { active: true, floorNifty, targetR, armAtNifty,
    bestR: best, riskPoints, givebackR: CORE_TARGET_INDEX_GIVEBACK_R };
}

export function isFreshCoreIndexTargetQuotes(position, nowMs = Date.now()) {
  const underlyingAt = Date.parse(position?.lastUnderlyingQuoteAt || '');
  const optionAt = Date.parse(position?.lastOptionQuoteAt || '');
  return [underlyingAt, optionAt].every(at =>
    Number.isFinite(at) &&
    at <= nowMs + 3000 && nowMs - at >= -3000 &&
    nowMs - at <= CORE_TARGET_INDEX_QUOTE_FRESH_MS
  );
}

export function isCoreTargetIndexTrailBreached(position, nowMs = Date.now()) {
  if (!position || position.strategyFamily === 'SCALP' ||
      position.coreTargetIndexTrailActive !== true ||
      !isFreshCoreIndexTargetQuotes(position, nowMs)) return false;
  const spot = positive(position.underlyingCurrent);
  const stop = positive(position.coreTargetIndexTrailStop);
  const premium = positive(position.currentPrice);
  const qty = positive(position.quantity);
  if (spot == null || stop == null || premium == null || qty == null) return false;
  return position.side === 'CE' ? spot <= stop :
    position.side === 'PE' ? spot >= stop : false;
}
