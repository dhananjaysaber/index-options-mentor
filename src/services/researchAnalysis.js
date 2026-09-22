export const COHORTS = [
  { id: 'legacy', label: 'Legacy Mentor', short: 'Legacy', copy: 'Earlier Mentor simulation records using the older target/target-zone position manager.' },
  { id: 'shadow', label: '13-point Shadow Research', short: 'Shadow', copy: 'Background research positions opened by the research engine even when the visible Mentor did not fully approve the setup.' },
  { id: 'core_auto', label: '13-point Auto Research', short: '13-point Auto', copy: 'Current 13-point research positions opened automatically by the Mentor under the active research-tier rules.' },
  { id: 'core_manual', label: '13-point Manual Research', short: '13-point Manual', copy: 'Current 13-point research positions opened manually by the user and then managed by the Mentor.' },
  { id: 'scalp_auto', label: 'Scalp Research · Auto', short: 'Scalp Auto', copy: 'Scalp research positions opened automatically only when the strict scalp entry checks pass.' },
  { id: 'scalp_manual', label: 'Scalp Research · Manual', short: 'Scalp Manual', copy: 'Scalp research positions opened manually when manual scalp safety requirements are available.' }
];

export function classifyTradeCohort(trade) {
  const tier = String(trade?.strategyTier || '');
  const label = String(trade?.strategyTierLabel || '');
  const mode = String(trade?.mode || '');
  const initiatedBy = String(trade?.initiatedBy || '').toUpperCase();
  const entryMethod = String(trade?.entryMethod || '').toUpperCase();
  const scalp = trade?.strategyFamily === 'SCALP' || tier === 'SCALP' || /scalp/i.test(label);

  if (
    trade?.shadowResearch === true ||
    mode === 'SHADOW_RESEARCH' ||
    tier.startsWith('SHADOW_') ||
    initiatedBy === 'RESEARCH_ENGINE'
  ) return 'shadow';

  if (scalp) {
    if (entryMethod === 'AUTO' || initiatedBy === 'MENTOR' || trade?.openedByMentor === true) return 'scalp_auto';
    return 'scalp_manual';
  }

  const hasCurrentResearchIdentity = ['FULL', 'CONTROLLED', 'EXPERIMENTAL'].includes(tier) ||
    trade?.manualResearch === true ||
    trade?.entryMandatoryPassCount != null ||
    trade?.entryConfirmationPassCount != null;

  if (!hasCurrentResearchIdentity && !trade?.strategyFamily) return 'legacy';
  if (trade?.manualResearch === true || initiatedBy === 'USER') return 'core_manual';
  return 'core_auto';
}

export function buildCohortAnalysis(history = []) {
  const rows = dedupe(history);
  return COHORTS.map(definition => {
    const trades = rows.filter(trade => classifyTradeCohort(trade) === definition.id);
    return {
      ...definition,
      trades,
      stats: summariseTrades(trades)
    };
  });
}

export function summariseTrades(trades = []) {
  const rows = trades.filter(Boolean);
  const total = rows.length;
  const pnlValues = rows.map(row => finite(row?.pnl)).filter(value => value != null);
  const rValues = rows.map(row => finite(row?.rAchieved)).filter(value => value != null);
  const holds = rows.map(row => finite(row?.heldMinutes)).filter(value => value != null);
  const wins = pnlValues.filter(value => value > 0);
  const losses = pnlValues.filter(value => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const pnl = pnlValues.reduce((sum, value) => sum + value, 0);
  const maxDrawdown = calculateMaxDrawdown(rows);

  return {
    total,
    pnl,
    wins: wins.length,
    losses: losses.length,
    flat: Math.max(0, total - wins.length - losses.length),
    winRate: total ? (wins.length / total) * 100 : 0,
    avgPnl: pnlValues.length ? pnl / pnlValues.length : 0,
    avgR: average(rValues),
    medianR: median(rValues),
    avgHold: average(holds),
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    maxDrawdown,
    bestTrade: pnlValues.length ? Math.max(...pnlValues) : 0,
    worstTrade: pnlValues.length ? Math.min(...pnlValues) : 0
  };
}

export function explainTrade(trade) {
  const cohort = classifyTradeCohort(trade);
  const reasons = [];

  if (cohort === 'legacy') {
    reasons.push('This is an earlier Mentor simulation record, not a manual user trade.');
    reasons.push('The older position manager used the original structural stop plus planned target/target-zone behaviour before the current managed-runner logic was introduced.');
    reasons.push('Older records do not contain all of today’s research-gate fields, so they should be analysed as a separate historical cohort.');
  }

  if (cohort === 'shadow') {
    const gates = trade?.entryMandatoryPassCount != null ? String(trade.entryMandatoryPassCount) + '/5 mandatory gates' : 'a partial mandatory-gate setup';
    reasons.push('The background research engine opened this as Shadow Research with ' + gates + '.');
    reasons.push('Shadow Research is deliberately broader than the visible Mentor recommendation: hard risk/liquidity safety must remain intact, a completed 5-minute close is required, and the setup is tracked for evidence even when full approval is absent.');
    if (trade?.mentorApprovedAtEntry === false) reasons.push('The visible Mentor did not approve this entry at the time; the trade exists specifically to measure what happened anyway.');
  }

  if (cohort === 'core_auto') {
    reasons.push('The current 13-point research engine opened this automatically rather than the user pressing a manual-entry control.');
    if (trade?.strategyTierLabel || trade?.strategyTier) reasons.push('Research tier at entry: ' + (trade.strategyTierLabel || trade.strategyTier) + '.');
    if (trade?.entryMandatoryPassCount != null) reasons.push('Entry evidence recorded ' + trade.entryMandatoryPassCount + '/5 mandatory gates and ' + (trade.entryConfirmationPassCount ?? '—') + '/8 confirmations.');
  }

  if (cohort === 'core_manual') {
    reasons.push('This was a user-selected 13-point research entry. The Mentor then tracked and managed the simulated position.');
    reasons.push('Manual research does not mean the visible Mentor fully approved the entry; it preserves the entry snapshot so the outcome can later be compared with automatic and shadow cohorts.');
    if (trade?.entryMandatoryPassCount != null) reasons.push('Entry evidence recorded ' + trade.entryMandatoryPassCount + '/5 mandatory gates and ' + (trade.entryConfirmationPassCount ?? '—') + '/8 confirmations.');
  }

  if (cohort === 'scalp_auto') {
    reasons.push('The Scalp Mentor opened this automatically.');
    reasons.push('Automatic scalp entry requires the strict 5-minute context + completed 3-minute execution checks, including trend, VWAP side, directional impulse, trigger break, liquidity, time window and hard risk/extension protection.');
    if (trade?.scalpScoreAtEntry != null) reasons.push('Scalp score at entry: ' + trade.scalpScoreAtEntry + '/100 with ' + (trade.scalpChecksPassCount ?? '—') + '/' + (trade.scalpChecksTotal || 7) + ' checks passing.');
  }

  if (cohort === 'scalp_manual') {
    reasons.push('This was a user-selected Scalp Research entry, not an automatic Mentor scalp.');
    reasons.push('Manual scalp research keeps the hard live-session, option, liquidity, time and measurable-stop requirements, but it can be available while stricter automatic checks such as risk width, extension, trend, VWAP, impulse, trigger or score are still blocking auto-entry.');
    if (trade?.scalpAutoEligibleAtEntry === false) reasons.push('Automatic entry was blocked at the time: ' + (trade?.scalpAutoRejectReason || 'one or more automatic scalp conditions were not satisfied.'));
    if (trade?.scalpScoreAtEntry != null) reasons.push('Scalp score at entry: ' + trade.scalpScoreAtEntry + '/100 with ' + (trade.scalpChecksPassCount ?? '—') + '/' + (trade.scalpChecksTotal || 7) + ' checks passing.');
  }

  if (trade?.exitReasonCode) reasons.push('Recorded exit: ' + humanExit(trade.exitReasonCode) + '.');

  return {
    cohort,
    cohortLabel: COHORTS.find(row => row.id === cohort)?.label || cohort,
    reasons
  };
}

export function buildMarketEvidence(fiveMinute = [], threeMinute = []) {
  const rows5 = normaliseCandles(fiveMinute);
  const rows3 = normaliseCandles(threeMinute);
  const sessions = groupSessions(rows5).map(session => {
    const first = session.rows[0];
    const last = session.rows.at(-1);
    const high = Math.max(...session.rows.map(row => row.high));
    const low = Math.min(...session.rows.map(row => row.low));
    const range = high - low;
    const net = last.close - first.open;
    const efficiency = range > 0 ? Math.abs(net) / range : 0;
    const scheduledTuesday = weekdayIST(first.time * 1000) === 2;
    return {
      date: session.date,
      open: first.open,
      close: last.close,
      high,
      low,
      range,
      net,
      efficiency,
      scheduledTuesday
    };
  });

  const ranges = sessions.map(row => row.range).filter(Number.isFinite);
  const medianRange = median(ranges);
  const highVolThreshold = medianRange > 0 ? medianRange * 1.5 : 0;
  const highVolSessions = sessions.filter(row => highVolThreshold > 0 && row.range >= highVolThreshold);
  const trendSessions = sessions.filter(row => row.efficiency >= 0.55);
  const choppySessions = sessions.filter(row => row.efficiency <= 0.25);
  const tuesday = sessions.filter(row => row.scheduledTuesday);
  const nonTuesday = sessions.filter(row => !row.scheduledTuesday);

  return {
    sessions,
    coverage: {
      sessions: sessions.length,
      fiveMinuteCandles: rows5.length,
      threeMinuteCandles: rows3.length,
      from: sessions[0]?.date || '',
      to: sessions.at(-1)?.date || ''
    },
    range: {
      average: average(ranges),
      median: medianRange,
      highVolThreshold,
      highVolSessions: highVolSessions.length,
      highVolShare: sessions.length ? (highVolSessions.length / sessions.length) * 100 : 0
    },
    regime: {
      trendSessions: trendSessions.length,
      trendShare: sessions.length ? (trendSessions.length / sessions.length) * 100 : 0,
      choppySessions: choppySessions.length,
      choppyShare: sessions.length ? (choppySessions.length / sessions.length) * 100 : 0
    },
    scheduledExpiryProxy: {
      tuesdaySessions: tuesday.length,
      tuesdayAverageRange: average(tuesday.map(row => row.range)),
      otherSessions: nonTuesday.length,
      otherAverageRange: average(nonTuesday.map(row => row.range))
    }
  };
}

export function analyseExpiryProxy(trades = []) {
  const groups = { tuesday: [], other: [] };
  for (const trade of dedupe(trades)) {
    const time = new Date(trade?.openedAt || trade?.closedAt || 0).getTime();
    if (!Number.isFinite(time) || time <= 0) continue;
    const key = weekdayIST(time) === 2 ? 'tuesday' : 'other';
    groups[key].push(trade);
  }
  return {
    tuesday: summariseTrades(groups.tuesday),
    other: summariseTrades(groups.other)
  };
}

function normaliseCandles(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (!Array.isArray(row) || row.length < 5) return null;
    const [time, open, high, low, close, volume] = row.map(Number);
    if (![time, open, high, low, close].every(Number.isFinite)) return null;
    return { time, open, high, low, close, volume: Number(volume) || 0 };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function groupSessions(rows) {
  const map = new Map();
  for (const row of rows) {
    const date = dateKeyIST(row.time * 1000);
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(row);
  }
  return [...map.entries()].map(([date, sessionRows]) => ({ date, rows: sessionRows }));
}

function dateKeyIST(ms) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date(ms));
    const year = parts.find(part => part.type === 'year')?.value;
    const month = parts.find(part => part.type === 'month')?.value;
    const day = parts.find(part => part.type === 'day')?.value;
    return year && month && day ? year + '-' + month + '-' + day : '';
  } catch {
    return '';
  }
}

function weekdayIST(ms) {
  try {
    const label = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short'
    }).format(new Date(ms));
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(label);
  } catch {
    return -1;
  }
}

function dedupe(history) {
  const map = new Map();
  for (const trade of Array.isArray(history) ? history : []) {
    if (!trade) continue;
    const key = trade.id || [
      trade.symbol,
      trade.openedAt,
      trade.closedAt,
      trade.entry,
      trade.exit
    ].join('|');
    const previous = map.get(key);
    map.set(key, previous ? { ...previous, ...trade } : trade);
  }
  return [...map.values()];
}

function calculateMaxDrawdown(trades) {
  const ordered = [...trades].sort((a, b) => new Date(a?.closedAt || a?.openedAt || 0) - new Date(b?.closedAt || b?.openedAt || 0));
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of ordered) {
    equity += finite(trade?.pnl) || 0;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  return maxDrawdown;
}

function humanExit(code) {
  const map = {
    STRUCTURE_INVALIDATED: 'hard structural stop',
    STRATEGY_DETERIORATION: 'strategy deterioration',
    PROFIT_PROTECTION_EXIT: 'profit-protection exit',
    TARGET_REACHED: 'legacy target reached',
    TARGET_APPROACHING: 'legacy target-zone exit',
    ONE_R_REACHED: 'legacy 1R protection',
    STRUCTURAL_TARGET_REACHED: 'structural target reached',
    RESEARCH_1_5R_EXIT: 'research +1.5R exit',
    RESEARCH_TIME_EXIT: 'research time exit',
    SESSION_EXIT: 'session exit',
    SCALP_STOP: 'scalp hard stop',
    SCALP_TARGET: 'scalp +1R target',
    SCALP_TIME_EXIT: 'scalp time exit',
    SCALP_CONTEXT_EXIT: 'scalp context exit',
    SCALP_PROFIT_PROTECT: 'scalp profit protection',
    MANUAL_EXIT: 'manual exit'
  };
  return map[code] || String(code).replaceAll('_', ' ').toLowerCase();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const rows = values.filter(Number.isFinite);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : 0;
}

function median(values) {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return 0;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}
