// Time rules for background RESEARCH (shadow) paper trades only.
// Owner decision 27 Nov 2026. Entry scoring, stops, trailing, Scalp and real orders do not use this file.
const ENTRY_LAST = 15 * 3600 + 15 * 60; // no new research trade after 3:15:00 PM IST
const CLOSE_FROM = 15 * 3600 + 18 * 60; // close open research trades from 3:18 PM IST
const MARKET_END = 15 * 3600 + 30 * 60; // a first chance at or after this is too late

function ist(value) {
  const ms = new Date(value || NaN).getTime();
  if (!Number.isFinite(ms)) return null;
  const text = new Date(ms + 19800000).toISOString();
  return { date: text.slice(0, 10), seconds: Number(text.slice(11, 13)) * 3600 + Number(text.slice(14, 16)) * 60 + Number(text.slice(17, 19)) };
}

export function researchEntryOpen(at) {
  const now = ist(at);
  return Boolean(now && now.seconds <= ENTRY_LAST);
}

// 'open': normal rules apply. 'close': timed close now. 'missed': too late for a fair result.
export function researchCloseTiming(openedAt, at) {
  const opened = ist(openedAt);
  const now = ist(at);
  if (!opened || !now || now.date < opened.date) return 'open';
  if (now.date > opened.date || now.seconds >= MARKET_END) return 'missed';
  return now.seconds >= CLOSE_FROM ? 'close' : 'open';
}

export function missedCloseExit() {
  return {
    exit: true,
    reasonCode: 'MISSED_CLOSE',
    title: 'MISSED CLOSE',
    reason: 'No check closed this research trade in time. A later price is not counted as its result.',
    rMultiple: null
  };
}

// The journal needs a price on every closed record, so this keeps the last one already seen.
// It is flagged as missed and carries no profit, loss or R.
export function missedCloseFields(position) {
  const lastSeen = Number(position?.currentPrice) > 0 ? Number(position.currentPrice) : Number(position?.entry);
  return { closeMissed: true, exit: lastSeen, underlyingExit: null, pnl: null, rAchieved: null };
}

function isResearch(trade) {
  return trade?.shadowResearch === true || trade?.mode === 'SHADOW_RESEARCH' ||
    String(trade?.strategyTier || '').startsWith('SHADOW_') ||
    ['RESEARCH_ENGINE', 'SHADOW_RESEARCH'].includes(String(trade?.initiatedBy || '').toUpperCase());
}

// Why a saved research trade is left out of totals, or '' when it counts. Never edits the record.
export function resultExclusion(trade) {
  if (!isResearch(trade)) return '';
  if (trade.closeMissed === true || trade.exitReasonCode === 'MISSED_CLOSE') return 'Missed close';
  const opened = ist(trade.openedAt);
  const closed = ist(trade.closedAt);
  return opened && closed && closed.date > opened.date ? 'Carried overnight' : '';
}

export const countedTrades = rows => (Array.isArray(rows) ? rows : []).filter(trade => trade && !resultExclusion(trade));
