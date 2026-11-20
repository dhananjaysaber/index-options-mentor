/*
 * 13-Point runner option-premium trailing, simulated positions only.
 * Preserve the original structural stop, early strategy-deterioration exits,
 * 1R milestones and entry qualification unchanged.
 *
 * Unlike Scalp's 50% fixed peak-retention rule, this trail allows a larger
 * giveback early and gradually tightens as a winning option move extends.
 * Applies only to observed, fresh option-contract quotes: no broker orders.
 */
export const CORE_OPTION_TRAIL_ARM_PCT = 0.05;
export const CORE_OPTION_QUOTE_FRESH_MS = 6000;

const finite = value => value == null || value === '' ? null :
  Number.isFinite(Number(value)) ? Number(value) : null;

export function coreRunnerRetention(peakGainPct) {
  if (peakGainPct >= 0.50) return 0.70;
  if (peakGainPct >= 0.30) return 0.60;
  if (peakGainPct >= 0.15) return 0.50;
  return 0.35;
}

export function computeCoreOptionTrail({ entryPrice, quantity, peakGrossPnl, previousFloorPnl = null }) {
  const entry = finite(entryPrice);
  const qty = finite(quantity);
  const peak = finite(peakGrossPnl);
  const investment = entry != null && qty != null && entry > 0 && qty > 0 ? entry * qty : null;
  const armAtGrossPnl = investment == null ? null : investment * CORE_OPTION_TRAIL_ARM_PCT;
  const previous = finite(previousFloorPnl);
  if (investment == null || peak == null) {
    return { active: false, floorPnl: null, armAtGrossPnl, peakGainPct: null, keepRatio: null };
  }
  const peakGainPct = Math.max(0, peak / investment);
  const active = peak >= armAtGrossPnl && peak > 0 || previous != null;
  if (!active) {
    return { active: false, floorPnl: null, armAtGrossPnl, peakGainPct, keepRatio: null };
  }
  const keepRatio = coreRunnerRetention(peakGainPct);
  const proposed = Math.max(0, peak * keepRatio);
  return {
    active: true,
    floorPnl: previous == null ? proposed : Math.max(previous, proposed),
    armAtGrossPnl, peakGainPct, keepRatio
  };
}

export function isFreshCoreOptionQuote(position, nowMs = Date.now()) {
  const at = Date.parse(position?.lastOptionQuoteAt || '');
  return Number.isFinite(at) && at <= nowMs + 3000 &&
    nowMs - at >= -3000 && nowMs - at <= CORE_OPTION_QUOTE_FRESH_MS;
}

export function isCoreOptionTrailBreached(position, nowMs = Date.now()) {
  if (!position || position.strategyFamily === 'SCALP' ||
      position.coreOptionTrailingActive !== true ||
      !isFreshCoreOptionQuote(position, nowMs)) return false;
  const pnl = finite(position.currentUnrealizedPnl);
  const floor = finite(position.coreOptionTrailingFloorPnl);
  const qty = finite(position.quantity);
  return pnl != null && floor != null && qty != null && qty > 0 && pnl <= floor;
}
