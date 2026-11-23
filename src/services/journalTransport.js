// Shared PWA journal transport: one writer for trade, setup and shadow events.
// Google Apps Script accepts the same event IDs idempotently; failed writes
// remain in the existing persistent outboxes and are retried later.
const MIN_GAP_MS = 3000;
const BASE_BACKOFF_MS = 12000;
const MAX_BACKOFF_MS = 180000;

let tail = Promise.resolve();
let nextStartAt = 0;
let cooldownUntil = 0;
let failures = 0;

export function journalTransportState() {
  return { nextStartAt, cooldownUntil, failures };
}

export async function sendJournalWrite(payload, { keepalive = false } = {}) {
  const run = tail.catch(() => {}).then(async () => {
    if (Date.now() < cooldownUntil) throw new Error('JOURNAL_RETRY_COOLDOWN');

    const delay = Math.max(0, nextStartAt - Date.now());
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (Date.now() < cooldownUntil) throw new Error('JOURNAL_RETRY_COOLDOWN');

    nextStartAt = Date.now() + MIN_GAP_MS;
    let response;
    try {
      response = await fetch('/api/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
        keepalive
      });
    } catch (error) {
      registerFailure();
      throw error;
    }

    if (!response.ok) registerFailure();
    else {
      failures = 0;
      cooldownUntil = 0;
    }
    return response;
  });
  tail = run.then(() => {}, () => {});
  return run;
}

function registerFailure() {
  failures = Math.min(5, failures + 1);
  const backoff = Math.min(MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** (failures - 1));
  cooldownUntil = Date.now() + backoff;
}
