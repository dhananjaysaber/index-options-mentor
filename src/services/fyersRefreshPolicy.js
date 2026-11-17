// FYERS Standard has a 5,000 market-data requests/day allowance. Keep ample
// headroom for chart switches, research, reconnection and manual refreshes.
// To use faster polling AFTER upgrading FYERS, set VITE_FYERS_TIER=prime
// for the frontend build; there is no need to change strategy rules.
const prime = import.meta.env?.VITE_FYERS_TIER === 'prime';

export const FYERS_REFRESH = Object.freeze(prime ? {
  tier: 'prime',
  quoteMs: 2000,
  mentorMs: 15000,
  chartMs: 30000,
  scalpCandlesMs: 45000
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
