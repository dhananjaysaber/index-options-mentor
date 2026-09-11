import {
  buildMentorSnapshot as buildBaseMentorSnapshot,
  cleanCandles,
  resolveSetupStage,
  LIVE_PARAMETERS
} from './mentorBase.js';

const MANDATORY_MIN = {
  chop: 0.58,
  trend: 0.60,
  vwap: 0.65,
  risk: 0.60,
  liquidity: 0.60
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function round(value, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round((Number(value) || 0) * p) / p;
}

function regressionSlope(values) {
  if (values.length < 2) return 0;
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * (values[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den ? num / den : 0;
}

function directionStructure(rows, side) {
  const recent = rows.slice(-7);
  if (recent.length < 4) return 0.5;
  let hits = 0;
  let total = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const a = recent[i - 1];
    const b = recent[i];
    if (side === 'CE') {
      hits += b.high > a.high ? 1 : 0;
      hits += b.low > a.low ? 1 : 0;
    } else {
      hits += b.high < a.high ? 1 : 0;
      hits += b.low < a.low ? 1 : 0;
    }
    total += 2;
  }
  return total ? hits / total : 0.5;
}

function overlapRatio(a, b) {
  const overlap = Math.max(0, Math.min(a.high, b.high) - Math.max(a.low, b.low));
  const base = Math.max(0.01, Math.min(a.high - a.low, b.high - b.low));
  return clamp(overlap / base);
}

function computeRegime(rows, vwapValue) {
  const recent = rows.slice(-12);
  if (recent.length < 5) return 0.4;

  const path = recent.slice(1).reduce((sum, c, i) => sum + Math.abs(c.close - recent[i].close), 0);
  const net = Math.abs(recent.at(-1).close - recent[0].close);
  const efficiency = path ? clamp(net / path) : 0;

  let crosses = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1].close - vwapValue;
    const curr = recent[i].close - vwapValue;
    if ((prev > 0 && curr < 0) || (prev < 0 && curr > 0)) crosses += 1;
  }
  const crossScore = 1 - clamp(crosses / 4);

  const overlaps = [];
  for (let i = 1; i < recent.length; i += 1) overlaps.push(overlapRatio(recent[i - 1], recent[i]));
  const overlapScore = 1 - (overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : 0.5);

  return clamp(0.45 * efficiency + 0.30 * crossScore + 0.25 * overlapScore);
}

function trendQuality(rows, side, atrValue) {
  if (!side || rows.length < 4) return 0.25;
  const recent = rows.slice(-8);
  const structure = directionStructure(recent, side);
  const slope = regressionSlope(recent.map(c => c.close));
  const slopeStrength = atrValue ? clamp(Math.abs(slope) / (atrValue * 0.18)) : 0;
  return clamp(0.58 * structure + 0.42 * slopeStrength);
}

function detectBreakoutAndRetest(rows, side, orh, orl, atrValue) {
  const level = side === 'CE' ? orh : orl;
  const tolerance = Math.max(2, atrValue * 0.18);
  let breakoutIndex = -1;

  for (let i = 3; i < rows.length; i += 1) {
    const prev = rows[i - 1].close;
    const curr = rows[i].close;
    const crossed = side === 'CE'
      ? prev <= level && curr > level
      : prev >= level && curr < level;
    if (crossed) breakoutIndex = i;
  }

  if (breakoutIndex < 0) {
    return { breakoutIndex: -1, closeConfirmed: false, retest: 0.10, retestFound: false, failed: false, retestIndex: -1 };
  }

  let retestFound = false;
  let failed = false;
  let retestIndex = -1;

  for (let i = breakoutIndex + 1; i < rows.length; i += 1) {
    const c = rows[i];
    if (side === 'CE') {
      const touched = c.low <= level + tolerance;
      if (touched && c.close >= level) {
        retestFound = true;
        retestIndex = i;
      }
      if (c.close < level - tolerance) failed = true;
    } else {
      const touched = c.high >= level - tolerance;
      if (touched && c.close <= level) {
        retestFound = true;
        retestIndex = i;
      }
      if (c.close > level + tolerance) failed = true;
    }
  }

  return {
    breakoutIndex,
    closeConfirmed: true,
    retest: failed ? 0.15 : retestFound ? 0.95 : 0.38,
    retestFound,
    failed,
    retestIndex
  };
}

function rrQuality(availableRR) {
  return availableRR >= 2 ? 1
    : availableRR >= 1.5 ? 0.90
      : availableRR >= 1.3 ? 0.80
        : availableRR >= 1.0 ? 0.65
          : availableRR >= 0.8 ? 0.45
            : 0.25;
}

function stopAtrQuality(stopAtrRatio) {
  if (!Number.isFinite(stopAtrRatio) || stopAtrRatio <= 0) return 0.25;
  if (stopAtrRatio < 0.35) return 0.25;
  if (stopAtrRatio < 0.50) return 0.45;
  if (stopAtrRatio < 0.65) return 0.60;
  if (stopAtrRatio < 0.85) return 0.80;
  if (stopAtrRatio <= 1.80) return 1.00;
  if (stopAtrRatio <= 2.30) return 0.80;
  if (stopAtrRatio <= 3.00) return 0.60;
  return 0.40;
}

function entryFreshnessQuality(distanceAtr) {
  if (!Number.isFinite(distanceAtr)) return 0.25;
  if (distanceAtr <= 1.25) return 1.00;
  if (distanceAtr <= 1.75) return 0.80;
  if (distanceAtr <= 2.00) return 0.60;
  if (distanceAtr <= 2.50) return 0.45;
  return 0.25;
}

function qualityToRR(score, availableRR) {
  const desired = score >= 90 ? 2.0 : score >= 84 ? 1.5 : score >= 78 ? 1.3 : 1.0;
  const feasible = availableRR >= 2 ? 2.0 : availableRR >= 1.5 ? 1.5 : availableRR >= 1.3 ? 1.3 : availableRR >= 1.0 ? 1.0 : availableRR;
  return round(Math.min(desired, feasible), 1);
}

function buildRows(baseRows, overrides) {
  const baseById = new Map((baseRows || []).map(row => [row.id, row]));
  return LIVE_PARAMETERS.map(parameter => {
    const base = baseById.get(parameter.id) || parameter;
    const value = clamp(overrides[parameter.id] ?? base.value ?? 0);
    const weighted = value * parameter.weight;
    const status = value >= 0.75 ? 'green' : value >= 0.50 ? 'yellow' : 'red';
    const gatePassed = !parameter.mandatory || value >= MANDATORY_MIN[parameter.id];
    return {
      ...base,
      ...parameter,
      detail: parameter.id === 'risk'
        ? 'Requires viable reward room, an ATR-sized structural stop and an entry that is not too far from the confirmed trigger.'
        : base.detail || parameter.detail,
      value,
      weighted: round(weighted, 2),
      status,
      gatePassed
    };
  });
}

function buildReasons(rows, context) {
  const failed = rows.filter(row => row.mandatory && !row.gatePassed);
  if (failed.length) {
    return failed.map(row => {
      if (row.id === 'risk') {
        const parts = [];
        if (context.stopAtrRatio < 0.5) parts.push('structural stop is too tight for the current 5-minute ATR');
        if (context.stopAtrRatio > 3) parts.push('structural stop is too wide for a fresh entry');
        if (context.distanceFromTriggerAtr > 2) parts.push('price is too far from the confirmed trigger to chase');
        if (context.availableRR < 1) parts.push('reward room is below 1R');
        return parts.length
          ? `Defined risk & room failed because ${parts.join(' and ')}.`
          : 'Defined risk & room failed the mandatory gate.';
      }
      return `${row.label} failed the mandatory gate.`;
    });
  }

  const reasons = [];
  if (context.adaptiveMode) reasons.push('Post-retest structure is being weighted more heavily than the earlier opening noise.');
  if (context.retestFound) reasons.push('Breakout retest has been detected and held.');
  const weak = rows
    .filter(row => !row.mandatory && row.status !== 'green')
    .sort((a, b) => a.value - b.value)
    .slice(0, 3);
  reasons.push(...weak.map(row => `${row.label} is ${row.status === 'red' ? 'weak' : 'only partially confirmed'}.`));
  return reasons.slice(0, 5);
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function buildMentorSnapshot(args) {
  const snapshot = await buildBaseMentorSnapshot(args);
  const { historyResponse, now = new Date() } = args;

  if (!snapshot?.ok || !snapshot?.decision?.side || !snapshot?.market?.sessionDate || !snapshot?.parameters?.length) {
    return snapshot;
  }

  const rows = cleanCandles(historyResponse?.candles || [], now)
    .filter(candle => candle.date === snapshot.market.sessionDate);
  if (rows.length < 5) return snapshot;

  const side = snapshot.decision.side;
  const atrValue = numberOrNull(snapshot.market.atr5) || 0;
  const vwapValue = numberOrNull(snapshot.market.vwap) || 0;
  const orh = numberOrNull(snapshot.market.orh);
  const orl = numberOrNull(snapshot.market.orl);
  const spot = numberOrNull(snapshot.market.spot);
  if (!atrValue || !spot || orh == null || orl == null) return snapshot;

  const breakInfo = detectBreakoutAndRetest(rows, side, orh, orl, atrValue);
  const trigger = side === 'CE' ? orh : orl;
  const adaptiveMode = Boolean(breakInfo.retestFound && !breakInfo.failed && breakInfo.retestIndex >= 0);

  const baseRegime = numberOrNull(snapshot.parameters.find(row => row.id === 'chop')?.value) ?? 0.4;
  const baseTrend = numberOrNull(snapshot.parameters.find(row => row.id === 'trend')?.value) ?? 0.25;

  let recentRegime = baseRegime;
  let recentTrend = baseTrend;
  if (adaptiveMode) {
    const start = Math.max(0, breakInfo.retestIndex - 1);
    const postRetestRows = rows.slice(start).slice(-8);
    if (postRetestRows.length >= 5) recentRegime = computeRegime(postRetestRows, vwapValue);
    if (postRetestRows.length >= 4) recentTrend = trendQuality(postRetestRows, side, atrValue);
  }

  const regime = adaptiveMode ? clamp(0.30 * baseRegime + 0.70 * recentRegime) : baseRegime;
  const trend = adaptiveMode ? clamp(0.30 * baseTrend + 0.70 * recentTrend) : baseTrend;

  let underlyingStop = numberOrNull(snapshot.structure?.underlyingStop);
  const stopBuffer = Math.max(1.5, atrValue * 0.08);
  if (adaptiveMode) {
    const retestCandle = rows[breakInfo.retestIndex];
    if (retestCandle) {
      underlyingStop = side === 'CE'
        ? Math.min(retestCandle.low, trigger) - stopBuffer
        : Math.max(retestCandle.high, trigger) + stopBuffer;
    }
  }

  const riskPoints = underlyingStop != null ? Math.abs(spot - underlyingStop) : 0;
  const barriers = [];
  const previousHigh = numberOrNull(snapshot.market.pdh);
  const previousLow = numberOrNull(snapshot.market.pdl);
  if (side === 'CE') {
    if (previousHigh != null && previousHigh > spot) barriers.push(previousHigh);
    const dayHigh = Math.max(...rows.map(c => c.high));
    if (dayHigh > spot) barriers.push(dayHigh);
  } else {
    if (previousLow != null && previousLow < spot) barriers.push(previousLow);
    const dayLow = Math.min(...rows.map(c => c.low));
    if (dayLow < spot) barriers.push(dayLow);
  }

  let roomPoints = atrValue * 2.2;
  const positiveRooms = side === 'CE'
    ? barriers.map(level => level - spot).filter(value => value > 0)
    : barriers.map(level => spot - level).filter(value => value > 0);
  if (positiveRooms.length) roomPoints = Math.min(...positiveRooms);

  const availableRR = riskPoints > 0 ? roomPoints / riskPoints : 0;
  const stopAtrRatio = atrValue > 0 ? riskPoints / atrValue : 0;
  const distanceFromTrigger = Math.abs(spot - trigger);
  const distanceFromTriggerAtr = atrValue > 0 ? distanceFromTrigger / atrValue : 0;
  const rewardRoomQuality = rrQuality(availableRR);
  const structuralStopQuality = stopAtrQuality(stopAtrRatio);
  const freshnessQuality = adaptiveMode ? entryFreshnessQuality(distanceFromTriggerAtr) : 1;
  const riskQuality = Math.min(rewardRoomQuality, structuralStopQuality, freshnessQuality);

  const overrides = {
    chop: regime,
    trend,
    risk: riskQuality
  };
  const parameterRows = buildRows(snapshot.parameters, overrides);
  const score = Math.round(parameterRows.reduce((sum, row) => sum + row.weighted, 0));
  const failedMandatory = parameterRows.filter(row => row.mandatory && !row.gatePassed);
  const rr = qualityToRR(score, availableRR);

  const latest = rows.at(-1);
  const spotBeyondTrigger = side === 'CE' ? spot > trigger : spot < trigger;
  const phase = { phase: snapshot.market.phase };
  const setupDecision = resolveSetupStage({
    phase,
    side,
    failedMandatory,
    spotBeyondTrigger,
    breakInfo,
    score,
    rr
  });

  const { state, headline, tone, reviewState, reviewHeadline, reviewTone } = setupDecision;
  const option = snapshot.option ? { ...snapshot.option } : null;
  if (option) {
    const entry = numberOrNull(option.ltp) || 0;
    const delta = Math.abs(numberOrNull(option.delta) || 0);
    const gamma = numberOrNull(option.gamma) || 0;
    const underlyingReward = riskPoints * Math.max(rr, 0);
    const estimatedLoss = Math.max(0, delta * riskPoints - 0.5 * gamma * riskPoints * riskPoints);
    const estimatedGain = Math.max(0, delta * underlyingReward + 0.5 * gamma * underlyingReward * underlyingReward);
    option.estimatedPremiumStop = round(Math.max(0.05, entry - estimatedLoss), 2);
    option.estimatedPremiumTarget = round(entry + estimatedGain, 2);
  }

  const canSuggestTrade = ['STRONG_SETUP', 'QUALIFIED'].includes(state) && rr >= 1 && option && option.lotSize;
  const breakoutCandle = breakInfo.breakoutIndex >= 0 ? rows[breakInfo.breakoutIndex] : null;
  const retestCandle = breakInfo.retestIndex >= 0 ? rows[breakInfo.retestIndex] : null;
  const setupId = adaptiveMode && breakoutCandle && retestCandle
    ? `${snapshot.market.sessionDate}:${side}:${breakoutCandle.ts}:${retestCandle.ts}`
    : null;

  return {
    ...snapshot,
    decision: {
      ...snapshot.decision,
      state,
      headline,
      tone,
      reviewState,
      reviewHeadline,
      reviewTone,
      stage: state,
      score,
      rr,
      availableRR: round(availableRR, 2),
      canSuggestTrade,
      reasons: buildReasons(parameterRows, {
        adaptiveMode,
        retestFound: breakInfo.retestFound,
        stopAtrRatio,
        distanceFromTriggerAtr,
        availableRR
      })
    },
    parameters: parameterRows,
    structure: {
      ...snapshot.structure,
      breakoutDetected: Boolean(spotBeyondTrigger || breakInfo.breakoutIndex >= 0),
      closeConfirmed: Boolean(breakInfo.closeConfirmed),
      spotBeyondTrigger,
      trigger: round(trigger, 2),
      retestFound: Boolean(breakInfo.retestFound),
      retestFailed: Boolean(breakInfo.failed),
      underlyingStop: underlyingStop != null ? round(underlyingStop, 2) : null,
      underlyingTarget: underlyingStop != null && rr >= 1
        ? round(side === 'CE' ? spot + riskPoints * rr : spot - riskPoints * rr, 2)
        : null,
      riskPoints: round(riskPoints, 2),
      roomPoints: round(roomPoints, 2),
      stopAtrRatio: round(stopAtrRatio, 2),
      distanceFromTrigger: round(distanceFromTrigger, 2),
      distanceFromTriggerAtr: round(distanceFromTriggerAtr, 2),
      rewardRoomQuality: round(rewardRoomQuality, 2),
      stopQuality: round(structuralStopQuality, 2),
      entryFreshnessQuality: round(freshnessQuality, 2)
    },
    setup: {
      ...snapshot.setup,
      setupId,
      breakoutTime: breakoutCandle?.hm || null,
      retestTime: retestCandle?.hm || null,
      retestStatus: breakInfo.failed ? 'FAILED' : breakInfo.retestFound ? 'HELD' : breakInfo.closeConfirmed ? 'PENDING' : 'NOT_STARTED',
      mandatoryReady: failedMandatory.length === 0 && Boolean(side),
      approvalReady: ['STRONG_SETUP', 'QUALIFIED'].includes(reviewState),
      currentStage: state,
      reviewStage: reviewState,
      adaptiveRegimeActive: adaptiveMode
    },
    option,
    diagnostics: {
      ...snapshot.diagnostics,
      adaptiveRegime: {
        active: adaptiveMode,
        baseRegime: round(baseRegime, 3),
        recentRegime: round(recentRegime, 3),
        finalRegime: round(regime, 3),
        baseTrend: round(baseTrend, 3),
        recentTrend: round(recentTrend, 3),
        finalTrend: round(trend, 3),
        breakoutIndex: breakInfo.breakoutIndex,
        retestIndex: breakInfo.retestIndex,
        lastCompleteClose: latest?.close != null ? round(latest.close, 2) : null
      },
      riskModel: {
        stopAtrRatio: round(stopAtrRatio, 2),
        distanceFromTriggerAtr: round(distanceFromTriggerAtr, 2),
        rewardRoomQuality: round(rewardRoomQuality, 2),
        stopQuality: round(structuralStopQuality, 2),
        entryFreshnessQuality: round(freshnessQuality, 2)
      }
    }
  };
}
