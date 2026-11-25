const TZ = 'Asia/Kolkata';
const FO_MASTER_URL = 'https://public.fyers.in/sym_details/NSE_FO_sym_master.json';

export const LIVE_PARAMETERS = [
  { id: 'chop', label: 'Market regime', weight: 12, mandatory: true, detail: 'Measures directional efficiency, VWAP crossings and candle overlap. High score means cleaner, less choppy conditions.' },
  { id: 'trend', label: 'Trend structure', weight: 12, mandatory: true, detail: 'Checks directional slope plus higher-high/higher-low or lower-high/lower-low structure.' },
  { id: 'vwap', label: 'VWAP alignment', weight: 10, mandatory: true, detail: 'Checks whether recent closes are consistently on the correct side of session VWAP.' },
  { id: 'risk', label: 'Defined risk & room', weight: 10, mandatory: true, detail: 'Requires a structural invalidation and sufficient room before the nearest major barrier.' },
  { id: 'liquidity', label: 'Option liquidity', weight: 6, mandatory: true, detail: 'Uses live bid/ask spread, volume and open interest for the selected option.' },

  { id: 'orb', label: 'Opening-range break', weight: 8, mandatory: false, detail: 'Uses the first three regular-session 5-minute candles to calculate ORH and ORL.' },
  { id: 'close', label: '5-minute close confirmation', weight: 7, mandatory: false, detail: 'Requires a completed 5-minute candle to close beyond the relevant trigger level.' },
  { id: 'retest', label: 'Retest quality', weight: 10, mandatory: false, detail: 'Detects whether price returned to the breakout area and then held/rejected it.' },
  { id: 'pd', label: 'PDH / PDL confluence', weight: 6, mandatory: false, detail: 'Uses the previous completed trading session high/low as contextual confluence or resistance/support.' },
  { id: 'volume', label: 'Volume expansion', weight: 5, mandatory: false, detail: 'Compares recent 5-minute participation against the session median.' },
  { id: 'momentum', label: 'Momentum quality', weight: 5, mandatory: false, detail: 'Uses net movement, candle bodies and ATR-normalised velocity.' },
  { id: 'htf', label: 'Higher-timeframe alignment', weight: 5, mandatory: false, detail: 'Aggregates the 5-minute series into 15-minute candles and checks directional alignment.' },
  { id: 'time', label: 'Time-of-day quality', weight: 4, mandatory: false, detail: 'Rewards the preferred intraday windows and discounts lower-quality periods.' }
];

const MANDATORY_MIN = {
  chop: 0.58,
  trend: 0.60,
  vwap: 0.65,
  risk: 0.60,
  liquidity: 0.60
};

let symbolMasterCache = { fetchedAt: 0, data: null };

// Server-host injection reuses its verified FYERS master; public app callers
// retain the existing download/cache behaviour. No strategy rule changes.
export function setTrustedSymbolMaster(data, fetchedAt) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isFinite(fetchedAt) || Date.now()-fetchedAt < -1000 || Date.now()-fetchedAt > 86400000) throw Error('STALE_CONTRACT_MASTER');
  symbolMasterCache = {data, fetchedAt};
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function round(value, decimals = 2) {
  const p = 10 ** decimals;
  return Math.round((Number(value) || 0) * p) / p;
}

function median(values) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function zonedParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

export function dateKeyIST(date = new Date()) {
  const p = zonedParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function dateDaysAgoIST(days) {
  const now = new Date();
  const shifted = new Date(now.getTime() - days * 86400000);
  return dateKeyIST(shifted);
}

function candleIST(ts) {
  const p = zonedParts(new Date(Number(ts) * 1000));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    hm: `${p.hour}:${p.minute}`
  };
}

function minutesOfDay(hour, minute) {
  return Number(hour) * 60 + Number(minute);
}

export function marketPhase(now = new Date(), latestSessionDate = null) {
  const p = zonedParts(now);
  const minute = minutesOfDay(p.hour, p.minute);
  const today = `${p.year}-${p.month}-${p.day}`;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(now);
  const businessDay = !['Sat', 'Sun'].includes(weekday);

  if (!businessDay) return { phase: 'CLOSED', today, minute };
  if (minute < 9 * 60 + 15) return { phase: 'PREMARKET', today, minute };
  if (minute >= 15 * 60 + 30) return { phase: 'CLOSED', today, minute };

  if (minute < 9 * 60 + 30) return { phase: 'OPENING_RANGE', today, minute };
  if (latestSessionDate !== today) return { phase: 'DATA_PENDING', today, minute };
  return { phase: 'LIVE', today, minute };
}

export function cleanCandles(rawCandles = [], now = new Date()) {
  const map = new Map();
  for (const row of rawCandles || []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [ts, open, high, low, close, volume] = row.map(Number);
    if (![ts, open, high, low, close].every(Number.isFinite)) continue;
    const z = candleIST(ts);
    const minute = minutesOfDay(z.hour, z.minute);
    if (minute < 9 * 60 + 15 || minute > 15 * 60 + 25) continue;
    map.set(ts, { ts, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0, ...z });
  }
  let rows = [...map.values()].sort((a, b) => a.ts - b.ts);
  const nowEpoch = Math.floor(now.getTime() / 1000);
  rows = rows.filter(c => c.ts + 300 <= nowEpoch || c.date !== dateKeyIST(now));
  return rows;
}

function groupSessions(candles) {
  const sessions = new Map();
  for (const candle of candles) {
    if (!sessions.has(candle.date)) sessions.set(candle.date, []);
    sessions.get(candle.date).push(candle);
  }
  return [...sessions.entries()]
    .map(([date, rows]) => ({ date, rows: rows.sort((a, b) => a.ts - b.ts) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function sessionVWAP(rows) {
  let pv = 0;
  let vol = 0;
  for (const c of rows) {
    const v = Math.max(0, c.volume || 0);
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * v;
    vol += v;
  }
  if (!vol) return rows.length ? rows.reduce((s, c) => s + c.close, 0) / rows.length : 0;
  return pv / vol;
}

function trueRanges(rows) {
  return rows.map((c, i) => {
    if (!i) return c.high - c.low;
    const prev = rows[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
}

function atr(rows, n = 14) {
  const tr = trueRanges(rows);
  const slice = tr.slice(-Math.min(n, tr.length));
  return slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
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

function computeBias(rows, vwapValue, atrValue) {
  const recent = rows.slice(-8);
  if (recent.length < 5 || !atrValue) return { side: null, raw: 0 };
  const close = recent.at(-1).close;
  const vwapComponent = clamp(Math.abs(close - vwapValue) / (atrValue * 0.8)) * Math.sign(close - vwapValue);
  const slope = regressionSlope(recent.map(c => c.close));
  const slopeComponent = clamp(Math.abs(slope) / (atrValue * 0.18)) * Math.sign(slope);
  const bullStructure = directionStructure(recent, 'CE');
  const bearStructure = directionStructure(recent, 'PE');
  const structureComponent = bullStructure - bearStructure;
  const raw = 0.40 * vwapComponent + 0.35 * slopeComponent + 0.25 * structureComponent;
  const side = raw >= 0.20 ? 'CE' : raw <= -0.20 ? 'PE' : null;
  return { side, raw };
}

function aggregate15(rows) {
  const buckets = [];
  for (let i = 0; i + 2 < rows.length; i += 3) {
    const group = rows.slice(i, i + 3);
    buckets.push({
      ts: group[0].ts,
      open: group[0].open,
      high: Math.max(...group.map(c => c.high)),
      low: Math.min(...group.map(c => c.low)),
      close: group.at(-1).close,
      volume: group.reduce((s, c) => s + (c.volume || 0), 0)
    });
  }
  return buckets;
}

function timeQuality(minute) {
  if (minute >= 9 * 60 + 30 && minute <= 11 * 60 + 15) return 1;
  if (minute >= 13 * 60 + 30 && minute <= 15 * 60) return 0.90;
  if (minute > 11 * 60 + 15 && minute < 13 * 60 + 30) return 0.55;
  if (minute > 15 * 60 && minute <= 15 * 60 + 20) return 0.65;
  return 0.40;
}

function detectBreakoutAndRetest(rows, side, orh, orl, atrValue) {
  const level = side === 'CE' ? orh : orl;
  const tolerance = Math.max(2, atrValue * 0.18);
  let breakoutIndex = -1;
  for (let i = 3; i < rows.length; i += 1) {
    const prev = rows[i - 1].close;
    const curr = rows[i].close;
    const crossed = side === 'CE' ? prev <= level && curr > level : prev >= level && curr < level;
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
      if (touched && c.close >= level) { retestFound = true; retestIndex = i; }
      if (c.close < level - tolerance) failed = true;
    } else {
      const touched = c.high >= level - tolerance;
      if (touched && c.close <= level) { retestFound = true; retestIndex = i; }
      if (c.close > level + tolerance) failed = true;
    }
  }
  return { breakoutIndex, closeConfirmed: true, retest: failed ? 0.15 : retestFound ? 0.95 : 0.38, retestFound, failed, retestIndex };
}

export function resolveSetupStage({ phase, side, failedMandatory, spotBeyondTrigger, breakInfo, score, rr }) {
  let liveState = 'BIAS_FORMING';
  let liveHeadline = 'Bias forming — wait';
  let liveTone = 'yellow';
  if (!side) { liveState = 'NO_TRADE_DIRECTION'; liveHeadline = 'No trade — direction unclear'; liveTone = 'red'; }
  else if (failedMandatory.length) { liveState = 'NO_TRADE_MANDATORY'; liveHeadline = `No trade — ${failedMandatory[0].label} failed`; liveTone = 'red'; }
  else if (!spotBeyondTrigger && !breakInfo.closeConfirmed) { liveState = 'BIAS_FORMING'; liveHeadline = `${side} bias forming — waiting for breakout`; liveTone = 'yellow'; }
  else if (spotBeyondTrigger && !breakInfo.closeConfirmed) { liveState = 'BREAKOUT_DETECTED'; liveHeadline = `${side} breakout detected — wait for 5-minute close`; liveTone = 'yellow'; }
  else if (breakInfo.failed) { liveState = 'RETEST_FAILED'; liveHeadline = `${side} setup cancelled — retest failed`; liveTone = 'red'; }
  else if (breakInfo.closeConfirmed && !breakInfo.retestFound) { liveState = 'RETESTING'; liveHeadline = `${side} close confirmed — retest pending`; liveTone = 'yellow'; }
  else if (breakInfo.retestFound && rr < 1) { liveState = 'NO_TRADE_RR'; liveHeadline = 'No trade — insufficient reward room'; liveTone = 'red'; }
  else if (breakInfo.retestFound && score >= 90) { liveState = 'STRONG_SETUP'; liveHeadline = `Strong ${side} setup — trade approved`; liveTone = 'green'; }
  else if (breakInfo.retestFound && score >= 80) { liveState = 'QUALIFIED'; liveHeadline = `${side} setup qualified — trade approved`; liveTone = 'green'; }
  else if (breakInfo.retestFound && score >= 72) { liveState = 'RETEST_HELD_WATCH'; liveHeadline = `${side} retest held — confirmation still weak`; liveTone = 'yellow'; }
  else if (breakInfo.retestFound) { liveState = 'RETEST_HELD_WAIT'; liveHeadline = `${side} retest held — wait for more confirmation`; liveTone = 'yellow'; }
  if (phase.phase === 'CLOSED') return { state: 'MARKET_CLOSED', headline: 'Market closed — review only', tone: 'neutral', reviewState: liveState, reviewHeadline: liveHeadline, reviewTone: liveTone };
  if (phase.phase === 'PREMARKET') return { state: 'PREMARKET', headline: 'Pre-market — no trade', tone: 'yellow', reviewState: liveState, reviewHeadline: liveHeadline, reviewTone: liveTone };
  if (phase.phase === 'OPENING_RANGE') return { state: 'OPENING_RANGE', headline: 'Opening range forming — wait', tone: 'yellow', reviewState: liveState, reviewHeadline: liveHeadline, reviewTone: liveTone };
  return { state: liveState, headline: liveHeadline, tone: liveTone, reviewState: liveState, reviewHeadline: liveHeadline, reviewTone: liveTone };
}

function optionLiquidity(option) {
  if (!option) return 0;
  const bid = Number(option.bid || 0);
  const ask = Number(option.ask || 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(option.ltp || 0);
  const spreadPct = mid > 0 && ask >= bid ? ((ask - bid) / mid) * 100 : 99;
  const spreadScore = spreadPct <= 0.5 ? 1 : spreadPct <= 1.0 ? 0.90 : spreadPct <= 2.0 ? 0.72 : spreadPct <= 3.0 ? 0.52 : 0.20;
  const volumeScore = clamp(Math.log10((Number(option.volume) || 0) + 1) / 7);
  const oiScore = clamp(Math.log10((Number(option.oi) || 0) + 1) / 6.5);
  return clamp(0.55 * spreadScore + 0.25 * volumeScore + 0.20 * oiScore);
}

function selectOption(chain, side) {
  if (!side) return null;
  const candidates = (chain?.data?.optionsChain || chain?.optionsChain || [])
    .filter(x => x?.option_type === side)
    .filter(x => Number(x.ltp) > 0 && Number(x.bid) > 0 && Number(x.ask) > 0)
    .map(x => {
      const delta = Math.abs(Number(x?.greeks?.delta || 0));
      const liquidity = optionLiquidity(x);
      const deltaPenalty = Math.abs(delta - 0.60);
      const preferredBandBonus = delta >= 0.55 && delta <= 0.70 ? 0.20 : 0;
      const rank = liquidity + preferredBandBonus - deltaPenalty * 2.2;
      return { ...x, _liquidity: liquidity, _rank: rank };
    })
    .sort((a, b) => b._rank - a._rank);
  return candidates[0] || null;
}

async function lotSizeFor(symbol) {
  if (!symbol) return null;
  try {
    const age = Date.now() - symbolMasterCache.fetchedAt;
    if (!symbolMasterCache.data || age > 6 * 60 * 60 * 1000) {
      const response = await fetch(FO_MASTER_URL, { headers: { 'User-Agent': 'Index-Options-Mentor/0.2' } });
      if (!response.ok) throw new Error(`Symbol master HTTP ${response.status}`);
      symbolMasterCache = { fetchedAt: Date.now(), data: await response.json() };
    }
    const record = symbolMasterCache.data?.[symbol];
    const lot = Number(record?.minLotSize);
    return Number.isFinite(lot) && lot > 0 ? lot : null;
  } catch (error) {
    console.warn('FYERS symbol master lot-size lookup failed:', error.message);
    return null;
  }
}

function buildRows(values) {
  return LIVE_PARAMETERS.map(parameter => {
    const value = clamp(values[parameter.id] ?? 0);
    const weighted = value * parameter.weight;
    const status = value >= 0.75 ? 'green' : value >= 0.50 ? 'yellow' : 'red';
    const gatePassed = !parameter.mandatory || value >= MANDATORY_MIN[parameter.id];
    return { ...parameter, value, weighted: round(weighted, 2), status, gatePassed };
  });
}

function qualityToRR(score, availableRR) {
  const desired = score >= 90 ? 2.0 : score >= 84 ? 1.5 : score >= 78 ? 1.3 : 1.0;
  const feasible = availableRR >= 2 ? 2.0 : availableRR >= 1.5 ? 1.5 : availableRR >= 1.3 ? 1.3 : availableRR >= 1.0 ? 1.0 : availableRR;
  return round(Math.min(desired, feasible), 1);
}

function buildReasons(rows, context) {
  const failed = rows.filter(r => r.mandatory && !r.gatePassed);
  if (failed.length) return failed.map(r => `${r.label} failed the mandatory gate.`);
  const reasons = [];
  if (context.bias) reasons.push(`${context.bias === 'CE' ? 'Bullish' : 'Bearish'} bias is supported by the current structure.`);
  if (context.retestFound) reasons.push('Breakout retest has been detected and held.');
  else if (context.breakoutIndex >= 0) reasons.push('Breakout is present but the retest is not fully confirmed.');
  const weak = rows.filter(r => !r.mandatory && r.status !== 'green').sort((a, b) => a.value - b.value).slice(0, 3);
  reasons.push(...weak.map(r => `${r.label} is ${r.status === 'red' ? 'weak' : 'only partially confirmed'}.`));
  return reasons.slice(0, 5);
}

export async function buildMentorSnapshot({ quoteResponse, historyResponse, chainResponse, now = new Date() }) {
  const allCandles = cleanCandles(historyResponse?.candles || [], now);
  const sessions = groupSessions(allCandles);
  if (!sessions.length) throw new Error('No regular-session 5-minute candles were returned.');
  const today = dateKeyIST(now);
  const latestSession = sessions.at(-1);
  const clockPhase = marketPhase(now, latestSession?.date || null);
  const todaySession = sessions.find(session => session.date === today) || null;
  const priorSessions = sessions.filter(session => session.date < today);
  const priorSession = priorSessions.at(-1) || null;
  const quoteNode = quoteResponse?.d?.[0]?.v;
  const fallbackClose = latestSession?.rows?.at(-1)?.close || 0;
  const spot = Number(quoteNode?.lp || fallbackClose || 0);

  if (clockPhase.phase === 'PREMARKET' || clockPhase.phase === 'OPENING_RANGE' || clockPhase.phase === 'DATA_PENDING') {
    const todayRows = todaySession?.rows || [];
    const opening = todayRows.slice(0, 3);
    const latestToday = todayRows.at(-1) || null;
    const priorHigh = priorSession ? Math.max(...priorSession.rows.map(c => c.high)) : null;
    const priorLow = priorSession ? Math.min(...priorSession.rows.map(c => c.low)) : null;
    const openingHigh = opening.length ? Math.max(...opening.map(c => c.high)) : null;
    const openingLow = opening.length ? Math.min(...opening.map(c => c.low)) : null;
    const currentVwap = todayRows.length ? sessionVWAP(todayRows) : null;
    const currentAtr = todayRows.length ? atr(todayRows, 14) : null;
    const phase = clockPhase.phase;
    const headline = phase === 'PREMARKET' ? 'Pre-market — no trade' : phase === 'OPENING_RANGE' ? 'Opening range forming — wait' : 'Live data pending — trading locked';
    const reason = phase === 'PREMARKET' ? 'The regular session has not opened yet.' : phase === 'OPENING_RANGE' ? `Opening range is forming (${opening.length}/3 completed 5-minute candles).` : 'FYERS has not yet returned a completed candle from today. The mentor will not reuse yesterday’s setup as a live signal.';
    return {
      ok: true, live: false, generatedAt: new Date().toISOString(),
      market: { phase, sessionDate: today, lastCandleTime: latestToday?.hm || null, lastCompleteClose: latestToday ? round(latestToday.close, 2) : null, spot: round(spot, 2), change: round(Number(quoteNode?.ch || 0), 2), changePct: round(Number(quoteNode?.chp || 0), 2), vwap: currentVwap != null ? round(currentVwap, 2) : null, atr5: currentAtr != null ? round(currentAtr, 2) : null, orh: openingHigh != null ? round(openingHigh, 2) : null, orl: openingLow != null ? round(openingLow, 2) : null, pdh: priorHigh != null ? round(priorHigh, 2) : null, pdl: priorLow != null ? round(priorLow, 2) : null, vix: round(Number(chainResponse?.data?.indiavixData?.ltp || chainResponse?.indiavixData?.ltp || 0), 2), vixChangePct: round(Number(chainResponse?.data?.indiavixData?.ltpchp || chainResponse?.indiavixData?.ltpchp || 0), 2), putCallOiRatio: round(Number(chainResponse?.data?.putOi || chainResponse?.putOi || 0) / Math.max(1, Number(chainResponse?.data?.callOi || chainResponse?.callOi || 0)), 2) },
      decision: { state: phase, headline, tone: 'yellow', reviewState: phase, reviewHeadline: headline, reviewTone: 'yellow', stage: phase, side: null, score: null, rr: 0, availableRR: 0, canSuggestTrade: false, reasons: [reason] },
      parameters: [],
      structure: { breakoutDetected: false, closeConfirmed: false, spotBeyondTrigger: false, trigger: null, retestFound: false, retestFailed: false, underlyingStop: null, underlyingTarget: null, riskPoints: 0, roomPoints: 0 },
      setup: { openingRangeReady: opening.length >= 3, biasReady: false, mandatoryReady: false, breakoutDetected: false, closeConfirmed: false, retestStatus: 'NOT_STARTED', approvalReady: false, currentStage: phase, reviewStage: phase },
      option: null,
      diagnostics: { rawCandleCount: Array.isArray(historyResponse?.candles) ? historyResponse.candles.length : 0, cleanedCandleCount: allCandles.length, currentSessionCandles: todayRows.length, duplicateOrPreopenRowsRemoved: Math.max(0, (historyResponse?.candles?.length || 0) - allCandles.length), lotSizeSource: 'Not requested while entry is locked' }
    };
  }

  const current = clockPhase.phase === 'LIVE' ? todaySession : latestSession;
  const currentIndex = sessions.findIndex(session => session.date === current.date);
  const previous = currentIndex > 0 ? sessions[currentIndex - 1] : null;
  const rows = current.rows;
  const latest = rows.at(-1);
  const vwapValue = sessionVWAP(rows);
  const atrValue = atr(rows, 14);
  const regime = computeRegime(rows, vwapValue);
  const biasInfo = computeBias(rows, vwapValue, atrValue);
  const side = biasInfo.side;
  const opening = rows.slice(0, 3);
  const orh = opening.length ? Math.max(...opening.map(c => c.high)) : null;
  const orl = opening.length ? Math.min(...opening.map(c => c.low)) : null;
  const previousHigh = previous ? Math.max(...previous.rows.map(c => c.high)) : null;
  const previousLow = previous ? Math.min(...previous.rows.map(c => c.low)) : null;
  const selected = selectOption(chainResponse, side);
  const lotSize = await lotSizeFor(selected?.symbol);
  const recent = rows.slice(-8);
  const structure = side ? directionStructure(recent, side) : 0.35;
  const slope = regressionSlope(recent.map(c => c.close));
  const slopeStrength = atrValue ? clamp(Math.abs(slope) / (atrValue * 0.18)) : 0;
  const trendQuality = side ? clamp(0.58 * structure + 0.42 * slopeStrength) : 0.25;
  const recent6 = rows.slice(-6);
  const sameSide = side && recent6.length ? recent6.filter(c => side === 'CE' ? c.close >= vwapValue : c.close <= vwapValue).length / recent6.length : 0;
  const vwapDistance = atrValue ? clamp(Math.abs(spot - vwapValue) / (atrValue * 0.8)) : 0;
  const vwapQuality = side ? clamp(0.72 * sameSide + 0.28 * vwapDistance) : 0.25;
  const breakInfo = side && orh != null && orl != null ? detectBreakoutAndRetest(rows, side, orh, orl, atrValue || 1) : { breakoutIndex: -1, closeConfirmed: false, retest: 0.1, retestFound: false, failed: false, retestIndex: -1 };
  const trigger = side === 'CE' ? orh : orl;
  const spotBeyondTrigger = side && trigger != null ? (side === 'CE' ? spot > trigger : spot < trigger) : false;
  const closeBeyondTrigger = side && trigger != null ? (side === 'CE' ? latest.close > trigger : latest.close < trigger) : false;
  const breakoutDistance = side && trigger != null && atrValue ? Math.abs(spot - trigger) / atrValue : 0;
  const orbQuality = (spotBeyondTrigger || breakInfo.closeConfirmed) ? clamp(0.70 + breakoutDistance * 0.30) : 0.20;
  const closeQuality = breakInfo.closeConfirmed && closeBeyondTrigger ? 0.95 : breakInfo.closeConfirmed ? 0.72 : 0.20;
  const recentVol = rows.slice(-3).map(c => c.volume || 0);
  const baseVol = median(rows.slice(Math.max(3, rows.length - 24), -3).map(c => c.volume || 0));
  const volRatio = baseVol > 0 ? (recentVol.reduce((a, b) => a + b, 0) / Math.max(1, recentVol.length)) / baseVol : 1;
  const volumeQuality = volRatio >= 1.5 ? 1 : volRatio >= 1.2 ? 0.85 : volRatio >= 1.0 ? 0.70 : volRatio >= 0.8 ? 0.55 : 0.35;
  const last3 = rows.slice(-3);
  const netMove = last3.length >= 2 ? Math.abs(last3.at(-1).close - last3[0].open) : 0;
  const bodyRatios = last3.map(c => Math.abs(c.close - c.open) / Math.max(0.01, c.high - c.low));
  const bodyQuality = bodyRatios.length ? bodyRatios.reduce((a, b) => a + b, 0) / bodyRatios.length : 0;
  const velocity = atrValue ? clamp(netMove / (atrValue * 1.5)) : 0;
  const momentumQuality = clamp(0.62 * velocity + 0.38 * bodyQuality);
  const fifteen = aggregate15(rows);
  const htfSlope = regressionSlope(fifteen.slice(-6).map(c => c.close));
  const htfSideAligned = side && htfSlope ? (side === 'CE' ? htfSlope > 0 : htfSlope < 0) : false;
  const htfStructure = side ? directionStructure(fifteen.slice(-6), side) : 0.3;
  const htfQuality = side ? clamp((htfSideAligned ? 0.55 : 0.15) + 0.45 * htfStructure) : 0.25;
  let pdQuality = 0.55;
  if (side === 'CE' && previousHigh != null) {
    if (spot > previousHigh) pdQuality = 0.95;
    else { const distance = previousHigh - spot; pdQuality = atrValue && distance < atrValue * 0.5 ? 0.38 : atrValue && distance > atrValue * 1.5 ? 0.70 : 0.55; }
  } else if (side === 'PE' && previousLow != null) {
    if (spot < previousLow) pdQuality = 0.95;
    else { const distance = spot - previousLow; pdQuality = atrValue && distance < atrValue * 0.5 ? 0.38 : atrValue && distance > atrValue * 1.5 ? 0.70 : 0.55; }
  }
  const recentForStop = rows.slice(-4);
  let underlyingStop = null;
  if (side === 'CE') underlyingStop = Math.min(...recentForStop.map(c => c.low));
  if (side === 'PE') underlyingStop = Math.max(...recentForStop.map(c => c.high));
  const riskPoints = side && underlyingStop != null ? Math.abs(spot - underlyingStop) : 0;
  const barriers = [];
  if (side === 'CE') {
    if (previousHigh != null && previousHigh > spot) barriers.push(previousHigh);
    const dayHigh = Math.max(...rows.map(c => c.high));
    if (dayHigh > spot) barriers.push(dayHigh);
  } else if (side === 'PE') {
    if (previousLow != null && previousLow < spot) barriers.push(previousLow);
    const dayLow = Math.min(...rows.map(c => c.low));
    if (dayLow < spot) barriers.push(dayLow);
  }
  let roomPoints = atrValue * 2.2;
  if (barriers.length) roomPoints = side === 'CE' ? Math.min(...barriers.map(x => x - spot).filter(x => x > 0)) : Math.min(...barriers.map(x => spot - x).filter(x => x > 0));
  const availableRR = riskPoints > 0 ? roomPoints / riskPoints : 0;
  const riskQuality = availableRR >= 2 ? 1 : availableRR >= 1.5 ? 0.90 : availableRR >= 1.3 ? 0.80 : availableRR >= 1.0 ? 0.65 : availableRR >= 0.8 ? 0.45 : 0.25;
  const phase = marketPhase(now, current.date);
  const phaseMinute = phase.phase === 'LIVE' || phase.phase === 'OPENING_RANGE' ? phase.minute : minutesOfDay(latest.hour, latest.minute);
  const timeScore = timeQuality(phaseMinute);
  const liquidityQuality = optionLiquidity(selected);
  const values = { chop: regime, trend: trendQuality, vwap: vwapQuality, risk: riskQuality, liquidity: liquidityQuality, orb: orbQuality, close: closeQuality, retest: breakInfo.retest, pd: pdQuality, volume: volumeQuality, momentum: momentumQuality, htf: htfQuality, time: timeScore };
  const parameterRows = buildRows(values);
  const score = Math.round(parameterRows.reduce((sum, r) => sum + r.weighted, 0));
  const failedMandatory = parameterRows.filter(r => r.mandatory && !r.gatePassed);
  const rr = qualityToRR(score, availableRR);
  const setupDecision = resolveSetupStage({ phase, side, failedMandatory, spotBeyondTrigger, breakInfo, score, rr });
  const { state, headline, tone, reviewState, reviewHeadline, reviewTone } = setupDecision;
  let optionPlan = null;
  if (selected) {
    const entry = Number(selected.ltp);
    const delta = Math.abs(Number(selected?.greeks?.delta || 0));
    const gamma = Number(selected?.greeks?.gamma || 0);
    const underlyingReward = riskPoints * Math.max(rr, 0);
    const estimatedLoss = Math.max(0, delta * riskPoints - 0.5 * gamma * riskPoints * riskPoints);
    const estimatedGain = Math.max(0, delta * underlyingReward + 0.5 * gamma * underlyingReward * underlyingReward);
    optionPlan = { symbol: selected.symbol, optionType: selected.option_type, strike: Number(selected.strike_price), ltp: round(entry, 2), bid: round(Number(selected.bid), 2), ask: round(Number(selected.ask), 2), spreadPct: round(((Number(selected.ask) - Number(selected.bid)) / Math.max(0.01, (Number(selected.ask) + Number(selected.bid)) / 2)) * 100, 2), volume: Number(selected.volume || 0), oi: Number(selected.oi || 0), delta: round(Number(selected?.greeks?.delta || 0), 3), gamma: Number(selected?.greeks?.gamma || 0), theta: round(Number(selected?.greeks?.theta || 0), 2), vega: round(Number(selected?.greeks?.vega || 0), 2), iv: round(Number(selected?.greeks?.iv || 0), 2), lotSize, estimatedPremiumStop: round(Math.max(0.05, entry - estimatedLoss), 2), estimatedPremiumTarget: round(entry + estimatedGain, 2), expiry: chainResponse?.data?.expiryData?.[0]?.date || chainResponse?.expiryData?.[0]?.date || null };
  }
  const canSuggestTrade = ['STRONG_SETUP', 'QUALIFIED'].includes(state) && rr >= 1 && optionPlan && lotSize;
  return {
    ok: true, live: phase.phase === 'LIVE', generatedAt: new Date().toISOString(),
    market: { phase: phase.phase, sessionDate: current.date, lastCandleTime: latest.hm, lastCompleteClose: round(latest.close, 2), spot: round(spot, 2), change: round(Number(quoteNode?.ch || 0), 2), changePct: round(Number(quoteNode?.chp || 0), 2), vwap: round(vwapValue, 2), atr5: round(atrValue, 2), orh: round(orh, 2), orl: round(orl, 2), pdh: previousHigh != null ? round(previousHigh, 2) : null, pdl: previousLow != null ? round(previousLow, 2) : null, vix: round(Number(chainResponse?.data?.indiavixData?.ltp || chainResponse?.indiavixData?.ltp || 0), 2), vixChangePct: round(Number(chainResponse?.data?.indiavixData?.ltpchp || chainResponse?.indiavixData?.ltpchp || 0), 2), putCallOiRatio: round(Number(chainResponse?.data?.putOi || chainResponse?.putOi || 0) / Math.max(1, Number(chainResponse?.data?.callOi || chainResponse?.callOi || 0)), 2) },
    decision: { state, headline, tone, reviewState, reviewHeadline, reviewTone, stage: state, side, score, rr, availableRR: round(availableRR, 2), canSuggestTrade, reasons: buildReasons(parameterRows, { bias: side, retestFound: breakInfo.retestFound, breakoutIndex: breakInfo.breakoutIndex }) },
    parameters: parameterRows,
    structure: { breakoutDetected: spotBeyondTrigger || breakInfo.breakoutIndex >= 0, closeConfirmed: breakInfo.closeConfirmed, spotBeyondTrigger, trigger: trigger != null ? round(trigger, 2) : null, retestFound: breakInfo.retestFound, retestFailed: breakInfo.failed, underlyingStop: underlyingStop != null ? round(underlyingStop, 2) : null, underlyingTarget: side && underlyingStop != null && rr >= 1 ? round(side === 'CE' ? spot + riskPoints * rr : spot - riskPoints * rr, 2) : null, riskPoints: round(riskPoints, 2), roomPoints: round(roomPoints, 2) },
    setup: { openingRangeReady: opening.length >= 3, biasReady: Boolean(side), mandatoryReady: failedMandatory.length === 0 && Boolean(side), breakoutDetected: Boolean(spotBeyondTrigger || breakInfo.breakoutIndex >= 0), closeConfirmed: Boolean(breakInfo.closeConfirmed), retestStatus: breakInfo.failed ? 'FAILED' : breakInfo.retestFound ? 'HELD' : breakInfo.closeConfirmed ? 'PENDING' : 'NOT_STARTED', approvalReady: ['STRONG_SETUP', 'QUALIFIED'].includes(reviewState), currentStage: state, reviewStage: reviewState },
    option: optionPlan,
    diagnostics: { rawCandleCount: Array.isArray(historyResponse?.candles) ? historyResponse.candles.length : 0, cleanedCandleCount: allCandles.length, currentSessionCandles: rows.length, duplicateOrPreopenRowsRemoved: Math.max(0, (historyResponse?.candles?.length || 0) - allCandles.length), lotSizeSource: lotSize ? 'FYERS NSE_FO symbol master' : 'Unavailable' }
  };
}

