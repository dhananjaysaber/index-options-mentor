// Shared presentation diagnosis; all new paper entries must pass BOTH gates.
export const MAX_SNAPSHOT_AGE_MS = 12000;
export const MAX_NIFTY_QUOTE_AGE_MS = 5000;
function ageOf(iso, now) {
  const timestamp = Date.parse(iso || '');
  return Number.isFinite(timestamp) ? now - timestamp : null;
}
function within(age, maxAge) {
  return age !== null && age >= -3000 && age <= maxAge;
}
export function assessMarketFreshness({ snapshot, quote, authenticated = false, error = '', now = Date.now() } = {}) {
  const snapshotAgeMs = ageOf(snapshot?.generatedAt, now);
  const quoteAgeMs = ageOf(quote?.at, now);
  const snapshotFresh = within(snapshotAgeMs, MAX_SNAPSHOT_AGE_MS);
  const quoteFresh = Number(quote?.nifty) > 0 && within(quoteAgeMs, MAX_NIFTY_QUOTE_AGE_MS);
  const ready = Boolean(authenticated && !error && snapshotFresh && quoteFresh);
  let label, message;
  if (!authenticated) {
    label = 'FYERS CONNECTION REQUIRED';
    message = 'Connect FYERS before preparing any new entry.';
  } else if (error) {
    label = 'MENTOR DATA NEEDS ATTENTION';
    message = 'Mentor refresh failed. Entries are paused until both streams recover.';
  } else if (!quoteFresh && snapshotFresh) {
    label = 'WAITING FOR FRESH NIFTY QUOTE';
    message = 'Mentor analysis is current, but NIFTY quotes are missing or stale. Retrying quotes automatically; new entries stay disabled.';
  } else if (!snapshotFresh && quoteFresh) {
    label = 'REFRESHING MENTOR ANALYSIS';
    message = 'The NIFTY quote is fresh, but Mentor analysis is missing or stale. Retrying analysis automatically; new entries stay disabled.';
  } else if (!snapshotFresh && !quoteFresh) {
    label = 'REFRESHING LIVE MARKET DATA';
    message = 'Checking NIFTY quotes and Mentor analysis. No new entry is allowed until both are fresh.';
  } else {
    label = 'LIVE MARKET DATA VERIFIED';
    message = 'Both independent data streams are fresh.';
  }
  return { ready, snapshotFresh, quoteFresh, snapshotAgeMs, quoteAgeMs, label, message };
}
