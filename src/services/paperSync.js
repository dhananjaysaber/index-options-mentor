// Paper-only bridge to AWS via the authenticated Netlify backend.
// Writes are queued locally so network failures never block the PWA's SELL flow.
// This module cannot place or modify broker orders.
const KEY = 'iom-paper-sync-outbox-v1';
const MAX = 100;
const MAX_POSITION_AGE_MS = 24 * 60 * 60 * 1000;
const MONITOR_POLL_MS = 15000;
let busy = false;

function readQueue() {
  try {
    const rows = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(rows) ? rows.slice(0, MAX) : [];
  } catch { return []; }
}

function storeQueue(rows) {
  try { localStorage.setItem(KEY, JSON.stringify(rows.slice(0, MAX))); }
  catch { /* Local quota/storage unavailable: do not interrupt trading UI */ }
}

function enqueue(row) {
  if (!row?.id || !['core','scalp'].includes(row.strategy)) return;
  const queue = readQueue();
  if (queue.some(x => x.action === row.action && x.id === row.id && x.strategy === row.strategy)) return;
  queue.push(row);
  storeQueue(queue);
  void flushPaperSyncQueue();
  void pollPaperMonitor();
}

export function queuePaperOpen(strategy, position) {
  if (!position?.id || position.mode !== 'SIMULATION') return;
  const opened = Date.parse(position.openedAt || '');
  if (!Number.isFinite(opened) || Date.now() - opened > MAX_POSITION_AGE_MS || opened > Date.now() + 30000) {
    window.dispatchEvent(new CustomEvent('mentor:paper-sync-warning', {
      detail: { strategy, status: 'POSITION_TOO_OLD_FOR_AWS_SYNC' }
    }));
    return;
  }
  const {
    id, strategyFamily, mode, openedAt, initiatedBy, side, symbol,
    entry, underlyingEntry, underlyingStop, underlyingTarget,
    lotSize, lots, quantity
  } = position;
  enqueue({
    action: 'sync', strategy, id,
    payload: { strategy, position: {
      id, strategyFamily, mode, openedAt, initiatedBy, side, symbol,
      entry, underlyingEntry, underlyingStop, underlyingTarget,
      lotSize, lots, quantity
    } }
  });
}

export function queuePaperClose(strategy, id, closedByMentor = false) {
  if (!id) return;
  enqueue({
    action: 'reconcile', strategy, id,
    payload: {
      strategy, id,
      reason: closedByMentor ? 'PWA_AUTO_EXIT' : 'USER_EXIT'
    }
  });
}

export async function flushPaperSyncQueue() {
  if (busy || typeof window === 'undefined' || document.visibilityState !== 'visible') return;
  busy = true;
  try {
    // Process in insertion order: a new position must arrive before its closure.
    for (let count = 0; count < MAX; count++) {
      const queue = readQueue();
      const job = queue[0];
      if (!job) break;
      let response;
      try {
        response = await fetch('/api/monitor/' + job.action, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(job.payload),
          cache: 'no-store'
        });
      } catch { break; }
      if (!response.ok) {
        // Preserve conflicting/missing positions for investigation, never
        // discard them or silently overwrite an existing AWS position.
        if (response.status === 409 || response.status === 400) {
          window.dispatchEvent(new CustomEvent('mentor:paper-sync-warning', {
            detail: { action: job.action, strategy: job.strategy, status: response.status }
          }));
        }
        break;
      }
      // Re-read the queue after awaiting network: a SELL/close may have
      // been queued while this request was in flight. Never erase it.
      const latest = readQueue();
      const index = latest.findIndex(item =>
        item.id === job.id && item.strategy === job.strategy &&
        item.action === job.action
      );
      if (index >= 0) {
        latest.splice(index, 1);
        storeQueue(latest);
      }
    }
  } finally { busy = false; }
}

export function acknowledgeAwsPaperExit(strategy, id) {
  // A confirmed AWS paper exit supersedes any outstanding local open/close
  // reconciliation for that exact position, without disturbing other trades.
  storeQueue(readQueue().filter(job =>
    !(job.strategy === strategy && job.id === id)
  ));
}

// Only an AWS-verified observed-quote exit for the same paper position
// may close a locally open PWA trade. Never close on an empty AWS slot.
export function findVerifiedAwsPaperExit(receipts, strategy, id, now = Date.now()) {
  if (!Array.isArray(receipts) || !['core', 'scalp'].includes(strategy) ||
      typeof id !== 'string' || !id) return null;
  return receipts.find(receipt => {
    const closedAt = Date.parse(receipt?.closedAt || '');
    return receipt?.id === id &&
      receipt.strategy === strategy &&
      receipt.exitPriceSource === 'OBSERVED_OPTION_QUOTE' &&
      receipt.executionMode === 'PAPER_ONLY' &&
      receipt.brokerOrderPlaced === false &&
      typeof receipt.exitPrice === 'number' &&
      Number.isFinite(receipt.exitPrice) && receipt.exitPrice > 0 &&
      Number.isFinite(closedAt) && closedAt <= now + 30000;
  }) || null;
}

export async function pollPaperMonitor() {
  if (typeof window === 'undefined' || document.visibilityState !== 'visible') return;
  try {
    const response = await fetch('/api/monitor/status', { cache: 'no-store' });
    if (!response.ok) return;
    const data = await response.json();
    if (data?.bridge !== 'AUTHENTICATED' || !data?.paperSync) return;
    window.dispatchEvent(new CustomEvent('mentor:paper-sync-status', { detail: data.paperSync }));
  } catch { /* Keep the PWA trading UI independent from bridge availability. */ }
}

export function installPaperSyncQueue() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', flushPaperSyncQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushPaperSyncQueue();
  });
  window.setInterval(() => {
    void flushPaperSyncQueue();
    void pollPaperMonitor();
  }, MONITOR_POLL_MS);
  void flushPaperSyncQueue();
}
