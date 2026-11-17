// FYERS API rate limits changed on 16 October 2026.
// Standard: 5,000/day, 50/min; Prime: 500,000/day, 500/min.
// Keep the strategy engine unchanged: only the market-data refresh rates differ.
// Prime REST is faster than Standard REST but is NOT a tick-by-tick WebSocket.
const prime = import.meta.env?.VITE_FYERS_TIER === 'prime';

export const FYERS_REFRESH = Object.freeze(prime ? {
  tier: 'prime',
  quoteMs: 1000,
  mentorMs: 4000,
  chartMs: 4000,
  scalpCandlesMs: 4000
} : {
  tier: 'standard',
  quoteMs: 15000,
  mentorMs: 60000,
  chartMs: 90000,
  scalpCandlesMs: 90000
});

export function isNseMarketHours(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const day = parts.find(part => part.type === 'weekday')?.value;
  if (day === 'Sat' || day === 'Sun') return false;
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  const time = hour * 60 + minute;
  return time >= 9 * 60 + 15 && time < 15 * 60 + 30;
}
