// Paper-only bridge to AWS via the authenticated Netlify backend.
// Writes are queued locally so network failures never block the PWA's SELL flow.
// This module cannot place or modify broker orders.
const KEY = 'iom-paper-sync-outbox-v1';
const MAX = 100;
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
}

export function queuePaperOpen(strategy, position) {
  if (!position?.id || position.mode !== 'SIMULATION') return;
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
      storeQueue(queue.slice(1));
    }
  } finally { busy = false; }
}

export function installPaperSyncQueue() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', flushPaperSyncQueue);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushPaperSyncQueue();
  });
  window.setInterval(() => { void flushPaperSyncQueue(); }, 15000);
  void flushPaperSyncQueue();
}
