/*
 * Scalp option-premium trailing protection for simulated/paper positions.
 *
 * The NIFTY structural R stop/trail remains unchanged. This is an additional
 * risk-exit simulation based on the actual FYERS option LTP and the already
 * persisted peak GROSS option P&L.
 *
 * A 3% favourable premium move arms a non-decreasing floor at 50% of the
 * best observed gross option profit. An observed quote at/below that floor
 * requests a paper exit at THAT quote, never at the historical floor price.
 *
 * This is NOT an exchange order, broker-side stop, guaranteed fill, or
 * prediction of the price obtainable during a gap/slow feed/closed PWA.
 */
export const SCALP_OPTION_TRAIL_ARM_PCT = 0.03;
export const SCALP_OPTION_TRAIL_KEEP_RATIO = 0.5;
export const SCALP_OPTION_QUOTE_FRESH_MS = 6000;

const valid = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function computeScalpOptionTrail({
  entryPrice,
  quantity,
  peakGrossPnl,
  previousFloorPnl = null
}) {
  const entry = valid(entryPrice);
  const qty = valid(quantity);
  const peak = valid(peakGrossPnl);
  const investment = entry != null && qty != null && entry > 0 && qty > 0
    ? entry * qty : null;
  const armAtGrossPnl = investment == null ? null : investment * SCALP_OPTION_TRAIL_ARM_PCT;
  const previousFloor = previousFloorPnl == null || previousFloorPnl === ''
    ? null : valid(previousFloorPnl);

  if (investment == null || peak == null) {
    return { active: false, floorPnl: null, armAtGrossPnl };
  }

  const active = (armAtGrossPnl != null && peak >= armAtGrossPnl && peak > 0)
    || (previousFloor != null && previousFloor >= 0);
  if (!active) return { active: false, floorPnl: null, armAtGrossPnl };

  const newFloor = Math.max(0, peak * SCALP_OPTION_TRAIL_KEEP_RATIO);
  const floorPnl = previousFloor == null ? newFloor : Math.max(previousFloor, newFloor);
  return { active: true, floorPnl, armAtGrossPnl };
}

export function isFreshScalpOptionQuote(position, nowMs = Date.now()) {
  const timestamp = Date.parse(position?.lastOptionQuoteAt || '');
  const age = nowMs - timestamp;
  return Boolean(
    Number.isFinite(timestamp) &&
    age >= -3000 &&
    age <= SCALP_OPTION_QUOTE_FRESH_MS
  );
}

export function isScalpOptionTrailBreached(position, nowMs = Date.now()) {
  if (position?.strategyFamily !== 'SCALP' ||
      position?.optionTrailingActive !== true ||
      !isFreshScalpOptionQuote(position, nowMs)) return false;
  const floor = valid(position?.optionTrailingFloorPnl);
  const pnl = valid(position?.currentUnrealizedPnl);
  const qty = valid(position?.quantity);
  return floor != null && pnl != null && qty != null && qty > 0 && pnl <= floor;
}
