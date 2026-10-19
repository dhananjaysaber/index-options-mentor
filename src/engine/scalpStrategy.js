const SCALP_TARGET_R = 1;
const SCALP_MAX_HOLD_MINUTES = 12;
const MIN_SCORE = 70;

export function evaluateScalpSetup(snapshot, candles = [], liveSpot = null, nowMs = Date.now()) {
  const rows = Array.isArray(candles) ? candles.map(normaliseCandle).filter(Boolean) : [];
  const currentBucket = Math.floor(Math.floor(nowMs / 1000) / 180) * 180;
  const completed = rows.filter(row => row.time < currentBucket).slice(-8);
  const latest = completed.at(-1) || null;
  const previous = completed.at(-2) || null;
  const snapshotAt = Date.parse(snapshot?.generatedAt || '');
  const snapshotFresh = Number.isFinite(snapshotAt) && nowMs >= snapshotAt - 3000 && nowMs - snapshotAt < 90000;
  const candlesFresh = Boolean(latest && previous && currentBucket >= latest.time && currentBucket - latest.time <= 720);


  const side = ['CE', 'PE'].includes(snapshot?.decision?.side)
    ? snapshot.decision.side
    : ['CE', 'PE'].includes(snapshot?.option?.optionType)
      ? snapshot.option.optionType
      : null;

  const spot = positive(liveSpot) ?? positive(snapshot?.market?.spot);
  const vwap = positive(snapshot?.market?.vwap);
  const atr = positive(snapshot?.market?.atr5);
  const params = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const trend = params.find(row => row.id === 'trend');
  const liquidity = params.find(row => row.id === 'liquidity');

  const live = snapshot?.live === true && snapshot?.market?.phase === 'LIVE' && snapshotFresh && candlesFresh;
  const optionReady = Boolean(snapshot?.option?.symbol && Number(snapshot?.option?.lotSize) > 0 && Number(snapshot?.option?.ltp) > 0);
  const biasReady = Boolean(side);
  const trendScore = Number(trend?.value);
  const trendOk = Number.isFinite(trendScore) && trendScore >= 0.50;
  const liquidityOk = liquidity?.gatePassed === true;
  const vwapOk = side === 'CE'
    ? spot != null && vwap != null && spot > vwap
    : side === 'PE'
      ? spot != null && vwap != null && spot < vwap
      : false;

  const candleReady = Boolean(latest && previous);
  const body = latest ? Math.abs(latest.close - latest.open) : 0;
  const span = latest ? Math.max(0.01, latest.high - latest.low) : 0.01;
  const bodyRatio = body / span;
  const impulseDirectionOk = side === 'CE'
    ? Boolean(latest && latest.close > latest.open)
    : side === 'PE'
      ? Boolean(latest && latest.close < latest.open)
      : false;
  const impulseOk = impulseDirectionOk && bodyRatio >= 0.35;

  const trigger = side === 'CE' ? positive(latest?.high) : side === 'PE' ? positive(latest?.low) : null;
  const triggerBroken = side === 'CE'
    ? spot != null && trigger != null && spot > trigger
    : side === 'PE'
      ? spot != null && trigger != null && spot < trigger
      : false;

  const stopBuffer = atr != null ? atr * 0.05 : 0;
  const stop = side === 'CE'
    ? positive(latest?.low) != null ? Number(latest.low) - stopBuffer : null
    : side === 'PE'
      ? positive(latest?.high) != null ? Number(latest.high) + stopBuffer : null
      : null;

  const riskPoints = spot != null && stop != null ? Math.abs(spot - stop) : null;
  const minRisk = atr != null ? Math.max(2, atr * 0.12) : 2;
  const maxRisk = atr != null ? Math.max(6, atr * 0.75) : 30;
  const riskOk = riskPoints != null && riskPoints >= minRisk && riskPoints <= maxRisk;

  const extension = spot != null && trigger != null ? Math.abs(spot - trigger) : null;
  const extensionOk = extension != null && (atr == null || extension <= atr * 0.35);
  const timeOk = isScalpWindow(nowMs);

  const checks = [
    check('bias', '5m bias', biasReady, 20, biasReady ? `${side} context is available` : 'Waiting for a clear CE/PE context'),
    check('trend', 'Trend quality', trendOk, 15, trendOk ? '5m trend quality is usable' : '5m trend quality is below the scalp floor'),
    check('vwap', 'VWAP side', vwapOk, 15, vwapOk ? `Price is on the ${side === 'CE' ? 'bullish' : 'bearish'} side of VWAP` : 'Price is not aligned with VWAP'),
    check('impulse', '3m impulse', impulseOk, 20, impulseOk ? `Latest completed 3m candle has ${Math.round(bodyRatio * 100)}% body` : 'Need a directional 3m impulse candle'),
    check('trigger', '3m trigger', triggerBroken, 15, triggerBroken ? 'Live NIFTY has crossed the 3m trigger' : 'Waiting for live price to cross the 3m trigger'),
    check('liquidity', 'Option liquidity', liquidityOk, 10, liquidityOk ? 'Candidate option liquidity gate passed' : 'Option liquidity is not acceptable'),
    check('time', 'Scalp window', timeOk, 5, timeOk ? 'Inside the scalp research window' : 'Outside the 09:30–14:45 scalp window')
  ];

  const score = checks.reduce((sum, item) => sum + (item.pass ? item.weight : 0), 0);
  const target = spot != null && riskPoints != null && side
    ? side === 'CE' ? spot + riskPoints * SCALP_TARGET_R : spot - riskPoints * SCALP_TARGET_R
    : null;

  const manualEligible = Boolean(live && optionReady && candleReady && biasReady && liquidityOk && timeOk && stop != null && riskPoints != null && riskPoints > 0);
  const hardReady = manualEligible && riskOk && extensionOk;
  const eligible = Boolean(hardReady && trendOk && vwapOk && impulseOk && triggerBroken && score >= MIN_SCORE);

  const reason = !snapshotFresh
    ? 'Waiting for a fresh FYERS mentor snapshot. No scalp entry on stale market data.'
    : !candlesFresh
      ? 'Waiting for recent verified 3-minute candles. No scalp entry on missing history.'
      : !live
        ? 'Scalp research waits for the live regular session.'
        : !optionReady
      ? 'Waiting for a live option candidate.'
      : !candleReady
        ? 'Waiting for at least two completed 3-minute candles.'
        : !biasReady
          ? 'Waiting for a clear 5-minute CE or PE context.'
          : !liquidityOk
            ? 'Option liquidity is blocking the scalp.'
            : !riskOk
              ? 'The 3-minute structural stop is either too tight or too wide for this scalp.'
              : !extensionOk
                ? 'Price has moved too far beyond the 3-minute trigger; do not chase.'
                : !timeOk
                  ? 'Scalp research is paused outside 09:30–14:45.'
                  : !trendOk
                    ? 'The 5-minute trend context is not strong enough.'
                    : !vwapOk
                      ? 'Live price is on the wrong side of VWAP for this direction.'
                      : !impulseOk
                        ? 'The latest completed 3-minute candle lacks directional impulse.'
                        : !triggerBroken
                          ? 'Waiting for the live 3-minute trigger break.'
                          : eligible
                            ? `${side} scalp research setup is ready.`
                            : 'Waiting for the scalp score to reach the research floor.';

  const setupId = latest && trigger != null
    ? [snapshot?.market?.sessionDate || 'session', 'SCALP', side || 'none', latest.time, trigger.toFixed(2)].join(':')
    : null;

  const manualReason = manualEligible
    ? eligible
      ? 'Manual entry is available, although this setup also qualifies for automatic scalp research.'
      : `Manual scalp research is available even though automatic entry is blocked: ${reason}`
    : !live
      ? 'Manual scalp research is available only during the live regular session.'
      : !optionReady
        ? 'Wait for a live option candidate before opening a manual scalp.'
        : !candleReady
          ? 'Wait for at least two completed 3-minute candles before a manual scalp.'
          : !biasReady
            ? 'Wait for a CE or PE context before a manual scalp.'
            : !liquidityOk
              ? 'Option liquidity is a hard safety requirement for manual scalp research.'
              : !timeOk
                ? 'Manual scalp research is paused outside 09:30–14:45.'
                : 'A measurable 3-minute stop is required before manual scalp research.';

  // Report all mandatory blockers independently of the signal score.
  // These are explanations only: they do not weaken the eligibility formula.
  const blockers = [
    !snapshotFresh && {id:'snapshot',title:'Market data',detail:'FYERS market snapshot is not current'},
    !candlesFresh && {id:'candles',title:'3-minute candles',detail:'Recent completed 3-minute candles are unavailable'},
    !optionReady && {id:'option',title:'Option contract',detail:'Option contract or quoted premium is unavailable'},
    !biasReady && {id:'direction',title:'Direction',detail:'No confirmed CE/PE context'},
    !liquidityOk && {id:'liquidity',title:'Liquidity',detail:'Selected option liquidity gate has not passed'},
    !riskOk && {id:'risk',title:'Structural stop',detail:`Modeled risk ${riskPoints == null ? 'unknown' : riskPoints.toFixed(2)} NIFTY points; permitted ${minRisk.toFixed(2)}–${maxRisk.toFixed(2)} points`},
    !extensionOk && {id:'extension',title:'Price extension',detail:'NIFTY has moved too far beyond the latest 3-minute trigger'},
    !timeOk && {id:'time',title:'Scalp entry window',detail:'New entries allowed only 09:30–14:45 IST'}
  ].filter(Boolean);

  return {
    eligible,
    manualEligible,
    blockers,
    researchOnly: true,
    score,
    minimumScore: MIN_SCORE,
    side,
    spot,
    vwap,
    atr,
    trigger,
    stop,
    target,
    riskPoints,
    rr: SCALP_TARGET_R,
    maxHoldMinutes: SCALP_MAX_HOLD_MINUTES,
    extension,
    bodyRatio,
    latestCompletedTime: latest?.time || null,
    setupId,
    checks,
    reason,
    manualReason
  };
}

export function buildScalpTicket(snapshot, evaluation, settings, initiatedBy = 'USER', overrides = {}) {
  const automaticEntry = initiatedBy === 'MENTOR';
  const allowed = automaticEntry ? evaluation?.eligible : evaluation?.manualEligible;
  if (!allowed || !snapshot?.option?.symbol) return null;

  const quote = readLiveQuote();
  const optionEntry = quote?.optionSymbol === snapshot.option.symbol
    ? positive(quote.optionPrice) ?? positive(snapshot.option.ltp)
    : positive(snapshot.option.ltp);
  const underlyingEntry = positive(quote?.nifty) ?? positive(evaluation.spot) ?? positive(snapshot?.market?.spot);
  if (optionEntry == null || underlyingEntry == null) return null;

  const side = evaluation.side;
  const rawStop = Number(evaluation.stop);
  if (!Number.isFinite(rawStop)) return null;
  const riskPoints = Math.abs(underlyingEntry - rawStop);
  if (!(riskPoints > 0)) return null;

  const underlyingTarget = side === 'CE'
    ? underlyingEntry + riskPoints * SCALP_TARGET_R
    : underlyingEntry - riskPoints * SCALP_TARGET_R;

  const maxLots = Math.max(1, Number(settings?.lotCap) || 5);
  const requestedLots = initiatedBy === 'MENTOR' ? settings?.defaultLots : (overrides?.lots ?? settings?.defaultLots);
  const lots = clampInt(requestedLots, 1, maxLots);
  const lotSize = Number(snapshot.option.lotSize) || 0;
  if (!lotSize) return null;
  const openedAt = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    mode: 'SIMULATION',
    strategyFamily: 'SCALP',
    setupId: evaluation.setupId,
    openedAt,
    initiatedBy,
    openedByMentor: initiatedBy === 'MENTOR',
    entryMethod: initiatedBy === 'MENTOR' ? 'AUTO' : 'MANUAL',
    strategyTier: 'SCALP',
    strategyTierLabel: initiatedBy === 'MENTOR' ? 'Scalp research · Auto' : 'Scalp research · Manual',
    autoManaged: true,
    manualResearch: initiatedBy !== 'MENTOR',
    scalpAutoEligibleAtEntry: Boolean(evaluation.eligible),
    scalpManualOverride: initiatedBy !== 'MENTOR' && !evaluation.eligible,
    scalpAutoRejectReason: evaluation.eligible ? '' : evaluation.reason,
    approvalState: 'SCALP_READY',
    mentorDecisionAtEntry: 'SCALP_READY',
    mentorSuggestionAtEntry: `SCALP RESEARCH — ${evaluation.reason}`,
    score: evaluation.score,
    rr: SCALP_TARGET_R,
    side,
    symbol: snapshot.option.symbol,
    strike: snapshot.option.strike,
    expiry: snapshot.option.expiry,
    lotSize,
    lots,
    quantity: lots * lotSize,
    entry: optionEntry,
    currentPrice: optionEntry,
    underlyingEntry,
    underlyingCurrent: underlyingEntry,
    underlyingStop: rawStop,
    underlyingTarget,
    currentR: 0,
    bestR: 0,
    worstR: 0,
    bestOptionPrice: optionEntry,
    worstOptionPrice: optionEntry,
    oneRReached: false,
    scalpMaxHoldMinutes: SCALP_MAX_HOLD_MINUTES,
    scalpTrigger: evaluation.trigger,
    scalpChecks: evaluation.checks,
    scalpChecksPassCount: evaluation.checks.filter(item => item.pass).length,
    scalpChecksTotal: evaluation.checks.length,
    scalpScoreAtEntry: evaluation.score,
    scalpBodyRatioAtEntry: evaluation.bodyRatio,
    scalpExtensionAtEntry: evaluation.extension,
    scalpAtrAtEntry: evaluation.atr,
    scalpVwapAtEntry: evaluation.vwap,
    scalpLatestCompletedCandleTime: evaluation.latestCompletedTime,
    scalpEntryEvaluation: {
      eligible: Boolean(evaluation.eligible),
      manualEligible: Boolean(evaluation.manualEligible),
      score: evaluation.score,
      minimumScore: evaluation.minimumScore,
      side: evaluation.side,
      spot: evaluation.spot,
      vwap: evaluation.vwap,
      atr: evaluation.atr,
      trigger: evaluation.trigger,
      stop: evaluation.stop,
      target: evaluation.target,
      riskPoints: evaluation.riskPoints,
      rr: evaluation.rr,
      extension: evaluation.extension,
      bodyRatio: evaluation.bodyRatio,
      latestCompletedTime: evaluation.latestCompletedTime,
      reason: evaluation.reason,
      manualReason: evaluation.manualReason,
      checks: evaluation.checks
    },
    riskBudgetEligible: false,
    requiredRiskAmount: null,
    requiredRiskPct: null,
    riskBudget: Number(settings?.capital || 0) * (Number(settings?.riskPct || 0) / 100),
    liveQuoteAtEntry: quote?.at || null,
    settingsSnapshot: {
      capital: Number(settings?.capital) || 0,
      riskPct: Number(settings?.riskPct) || 0,
      defaultLots: lots,
      selectedLots: lots,
      lotCap: Number(settings?.lotCap) || lots,
      mentorAutoOpen: Boolean(settings?.mentorAutoOpen),
      mentorAutoClose: Boolean(settings?.mentorAutoClose),
      scalpAutoOpen: settings?.scalpAutoOpen !== false,
      scalpAutoClose: settings?.scalpAutoClose !== false
    },
    parameterSnapshot: snapshot.parameters,
    reasons: evaluation.checks.filter(item => !item.pass).map(item => item.detail),
    entryMarket: {
      sessionDate: snapshot?.market?.sessionDate,
      spot: underlyingEntry,
      vwap: snapshot?.market?.vwap,
      orh: snapshot?.market?.orh,
      orl: snapshot?.market?.orl,
      pdh: snapshot?.market?.pdh,
      pdl: snapshot?.market?.pdl,
      atr5: snapshot?.market?.atr5
    },
    entryStructure: {
      scalp: true,
      trigger: evaluation.trigger,
      underlyingStop: rawStop,
      underlyingTarget,
      riskPoints,
      maxHoldMinutes: SCALP_MAX_HOLD_MINUTES
    },
    entryDecision: {
      state: 'SCALP_READY',
      side,
      score: evaluation.score,
      rr: SCALP_TARGET_R,
      headline: 'Scalp research setup'
    },
    entryOption: { ...snapshot.option, ltp: optionEntry }
  };
}

export function scalpTimeRemaining(position, nowMs = Date.now()) {
  const opened = new Date(position?.openedAt || 0).getTime();
  if (!Number.isFinite(opened)) return 0;
  const limit = Math.max(1, Number(position?.scalpMaxHoldMinutes) || SCALP_MAX_HOLD_MINUTES) * 60000;
  return Math.max(0, limit - (nowMs - opened));
}

function check(id, label, pass, weight, detail) {
  return { id, label, pass: Boolean(pass), weight, detail };
}

function normaliseCandle(row) {
  if (Array.isArray(row)) {
    const [time, open, high, low, close, volume] = row.map(Number);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, volume: Number(volume) || 0 };
  }
  if (!row || typeof row !== 'object') return null;
  const item = {
    time: Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume) || 0
  };
  return [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite) ? item : null;
}

function isScalpWindow(nowMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find(part => part.type === 'hour')?.value);
    const minute = Number(parts.find(part => part.type === 'minute')?.value);
    const total = hour * 60 + minute;
    return total >= 570 && total <= 885;
  } catch {
    return false;
  }
}

function readLiveQuote() {
  try { return typeof window !== 'undefined' ? window.__indexOptionsLiveQuote : null; } catch { return null; }
}

function positive(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || min);
  return Math.max(min, Math.min(max, n));
}
