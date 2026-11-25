import { computeScalpOptionTrail } from './scalpOptionTrail.js';
import { computeCoreOptionTrail } from './coreOptionTrail.js';
import { computeCoreTargetIndexTrail } from './coreTargetIndexTrail.js';

export function updateLivePosition(current, liveOption, liveNifty, fallbackSpot, quoteAt = null) {
  if (!current) return current;
  const hasCurrentOptionQuote = Number.isFinite(liveOption) && liveOption > 0;
  const hasCurrentUnderlyingQuote = Number.isFinite(liveNifty) && liveNifty > 0;
  const currentPrice = hasCurrentOptionQuote ? liveOption : finite(current.currentPrice) ?? finite(current.entry) ?? 0;
  const underlyingCurrent = Number.isFinite(liveNifty) && liveNifty > 0 ? liveNifty : finite(fallbackSpot) ?? finite(current.underlyingCurrent) ?? finite(current.underlyingEntry) ?? 0;
  const riskPoints = Math.max(0.01, Math.abs(Number(current.underlyingEntry) - Number(current.underlyingStop)));
  const movePoints = current.side === 'CE' ? underlyingCurrent - Number(current.underlyingEntry) : Number(current.underlyingEntry) - underlyingCurrent;
  const currentR = Number.isFinite(movePoints) ? movePoints / riskPoints : Number(current.currentR || 0);
  const bestR = Math.max(Number.isFinite(Number(current.bestR)) ? Number(current.bestR) : 0, currentR);
  const worstR = Math.min(Number.isFinite(Number(current.worstR)) ? Number(current.worstR) : 0, currentR);
  const quantity = Math.max(0, Number(current.quantity) || 0);
  const currentUnrealizedPnl = (currentPrice - Number(current.entry || currentPrice)) * quantity;
  const peakUnrealizedPnl = Math.max(Number.isFinite(Number(current.peakUnrealizedPnl)) ? Number(current.peakUnrealizedPnl) : 0, currentUnrealizedPnl);
  const next = {
    ...current,
    currentPrice,
    lastOptionQuoteAt: hasCurrentOptionQuote && Number.isFinite(Date.parse(quoteAt || '')) ? quoteAt : (current.lastOptionQuoteAt || null),
    lastUnderlyingQuoteAt: hasCurrentUnderlyingQuote && Number.isFinite(Date.parse(quoteAt || '')) ? quoteAt : (current.lastUnderlyingQuoteAt || null),
    underlyingCurrent,
    currentR,
    bestR,
    worstR,
    currentUnrealizedPnl,
    peakUnrealizedPnl,
    bestOptionPrice: Math.max(Number.isFinite(Number(current.bestOptionPrice)) ? Number(current.bestOptionPrice) : Number(current.entry), currentPrice),
    worstOptionPrice: Math.min(Number.isFinite(Number(current.worstOptionPrice)) ? Number(current.worstOptionPrice) : Number(current.entry), currentPrice),
    oneRReached: Boolean(current.oneRReached || currentR >= 1 || bestR >= 1)
  };

  if (current.strategyFamily !== 'SCALP') {
    // Ignore a cached / missing NIFTY quote when arming a new target-based trail.
    // Once activated, it remains armed until the simulated trade closes.
    const indexTrail = computeCoreTargetIndexTrail({
      side: current.side,
      underlyingEntry: current.underlyingEntry,
      underlyingStop: current.underlyingStop,
      underlyingTarget: current.underlyingTarget,
      bestR: hasCurrentUnderlyingQuote ? bestR : null,
      previousFloorNifty: current.coreTargetIndexTrailStop
    });
    next.coreTargetIndexTrailActive = indexTrail.active;
    next.coreTargetIndexTrailStop = indexTrail.floorNifty;
    next.coreTargetIndexTrailArmAtNifty = indexTrail.armAtNifty;
    next.coreTargetIndexTrailBestR = indexTrail.bestR;
    next.coreTargetIndexTrailPolicy = 'PAPER ONLY: original NIFTY target is a milestone; after +0.25R beyond target the NIFTY stop moves to target, then trails 0.50R below the best NIFTY move (above for puts). Exits at fresh observed option price; never a broker stop or guaranteed fill.';
    if (indexTrail.active && !current.coreTargetIndexTrailActivatedAt) {
      next.coreTargetIndexTrailActivatedAt = new Date().toISOString();
    }
    const coreTrail = computeCoreOptionTrail({
      entryPrice: current.entry, quantity, peakGrossPnl: peakUnrealizedPnl,
      previousFloorPnl: current.coreOptionTrailingFloorPnl
    });
    next.coreOptionTrailingActive = coreTrail.active;
    next.coreOptionTrailingFloorPnl = coreTrail.floorPnl;
    next.coreOptionTrailKeepRatio = coreTrail.keepRatio;
    next.coreOptionTrailArmAtGrossPnl = coreTrail.armAtGrossPnl;
    next.coreOptionTrailPolicy = 'PAPER ONLY: arms after +5% option gain. Retains 35% / 50% / 60% / 70% of highest observed gross option profit at progressively larger peak gains. Not a FYERS order.';
    if (coreTrail.active && !current.coreOptionTrailingActivatedAt) next.coreOptionTrailingActivatedAt = new Date().toISOString();
  }
  if (current.strategyFamily === 'SCALP') {
    const trail = scalpTrail(bestR, current.scalpTrailingFloorR);
    next.scalpTrailingActive = trail.active;
    next.scalpTrailingPeakR = bestR;
    next.scalpTrailingFloorR = trail.floorR;
    next.scalpTrailingGivebackR = Math.max(0, bestR - currentR);
    next.scalpTrailPolicy = 'SIMULATION ONLY, using NIFTY-index R (not an exchange or FYERS stop): +0.50R protects 0R gross; +0.60R protects +0.50R; +0.75R protects +0.55R; +0.90R protects +0.75R; never lower the floor.';
    const optionTrail = computeScalpOptionTrail({
      entryPrice: current.entry,
      quantity,
      peakGrossPnl: peakUnrealizedPnl,
      previousFloorPnl: current.optionTrailingFloorPnl
    });
    next.optionTrailingActive = optionTrail.active;
    next.optionTrailingFloorPnl = optionTrail.floorPnl;
    next.optionTrailingArmAtGrossPnl = optionTrail.armAtGrossPnl;
    next.optionTrailPolicy = 'PAPER ONLY: arms after +3% option-premium gain; protects at least 50% of peak observed gross P&L. This is neither a broker-side stop nor a guaranteed fill.';
    if (optionTrail.active && !current.optionTrailingActivatedAt) next.optionTrailingActivatedAt = new Date().toISOString();
    if (trail.active && !current.scalpTrailingActivatedAt) next.scalpTrailingActivatedAt = new Date().toISOString();
  }
  return next;
}

function scalpTrail(bestR, previousFloorR = null) {
  // Paper-trade trail driven by observed NIFTY R. The PWA does not place or
  // modify exchange-side FYERS stop orders; quotes may gap past a floor.
  if (!Number.isFinite(bestR) || bestR < 0.5) return { active: false, floorR: null };
  let proposedFloorR = 0;
  if (bestR >= 0.90) proposedFloorR = Math.max(0.75, bestR - 0.15);
  else if (bestR >= 0.75) proposedFloorR = 0.55;
  else if (bestR >= 0.60) proposedFloorR = 0.50;
  const previous = previousFloorR == null || previousFloorR === '' ? null : Number(previousFloorR);
  const protectedFloorR = Number.isFinite(previous)
    ? Math.max(previous, proposedFloorR)
    : proposedFloorR;
  return { active: true, floorR: Math.min(bestR, protectedFloorR) };
}

function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
