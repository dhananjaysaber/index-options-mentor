// Shared, read-only summary for the Positions page. Trading history is never mutated.
const IST = 'Asia/Kolkata';
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: '2-digit', month: '2-digit', year: 'numeric'
});
const labelFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST, day: '2-digit', month: 'short', year: 'numeric'
});

function dayKey(input) {
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = dayFormat.formatToParts(date);
  const field = type => parts.find(part => part.type === type)?.value;
  return `${field('year')}-${field('month')}-${field('day')}`;
}

function isScalp(trade) {
  return trade?.strategyFamily === 'SCALP' ||
    trade?.strategyTier === 'SCALP' ||
    /scalp/i.test(String(trade?.strategyTierLabel || ''));
}

export function summarisePositionToday(history, now = new Date()) {
  const date = new Date(now);
  const today = dayKey(date);
  const create = () => ({ total: 0, wins: 0, losses: 0, pnl: 0 });
  const summary = {
    ...create(),
    dayLabel: Number.isFinite(date.getTime()) ? labelFormat.format(date) : '',
    core: create(),
    scalp: create()
  };
  if (!today) return summary;

  for (const trade of Array.isArray(history) ? history : []) {
    if (!trade?.closedAt || dayKey(trade.closedAt) !== today) continue;
    const pnl = Number(trade.pnl);
    const amount = Number.isFinite(pnl) ? pnl : 0;
    const section = isScalp(trade) ? summary.scalp : summary.core;
    for (const target of [summary, section]) {
      target.total += 1;
      target.pnl += amount;
      if (amount > 0) target.wins += 1;
      if (amount < 0) target.losses += 1;
    }
  }
  return summary;
}
