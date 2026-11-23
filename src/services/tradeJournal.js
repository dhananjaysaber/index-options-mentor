const HISTORY_KEY = 'index-options-mentor-history-v05';
const POSITION_KEY = 'index-options-mentor-open-position-v07';
const CORE_POSITION_KEY = 'index-options-mentor-core-position-v41';
const SCALP_POSITION_KEY = 'index-options-mentor-scalp-position-v41';
const METRICS_KEY = 'index-options-mentor-journal-metrics-v1';
const DB_NAME = 'index-options-mentor-journal-v1';
const STORE_NAME = 'outbox';
const API_URL = '/api/journal';
const HISTORY_EVENT = 'mentor:journal-history';

let dbPromise = null;
let flushPromise = null;
let journalFailureCount = 0;
let nextJournalSyncAt = 0;
let watchTimer = null;
let syncTimer = null;
let knownHistoryIds = new Set();
let currentPositionIds = new Set();
let onlineHandler = null;
let pageHideHandler = null;

export async function prepareJournalHistory({ maxWaitMs = 1800 } = {}) {
  const local = readJson(HISTORY_KEY, []);
  const remotePromise = syncJournalHistory(1000).then(merged => ({
    localCount: local.length,
    remoteCount: Math.max(0, merged.length - local.length),
    mergedCount: merged.length
  }));

  try {
    return await withTimeout(remotePromise, maxWaitMs);
  } catch {
    // The remote request deliberately continues and will dispatch HISTORY_EVENT
    // when it completes. App startup must never wait indefinitely for Sheets.
    return { localCount: local.length, remoteCount: 0, mergedCount: local.length };
  }
}

export async function syncJournalHistory(limit = 1000) {
  const remote = await loadRemoteTrades(limit);
  const local = readJson(HISTORY_KEY, []);
  const merged = mergeHistory(local, remote);
  writeJson(HISTORY_KEY, merged);
  dispatchHistory(merged);
  return merged;
}

export function startTradeJournalBridge() {
  if (watchTimer || syncTimer) return stopTradeJournalBridge;

  const history = readJson(HISTORY_KEY, []);
  knownHistoryIds = new Set(history.map(trade => trade?.id).filter(Boolean));
  const existingPositions = readActivePositions();
  currentPositionIds = new Set(existingPositions.map(position => position.id));

  // Migrate any browser-only completed trades into the permanent journal.
  for (const trade of history) {
    if (!trade?.id || !trade?.closedAt) continue;
    void queueJournalEvent({
      eventId: `close:${trade.id}`,
      type: 'TRADE_CLOSED',
      trade: withStoredMetrics(trade),
      source: journalSource(trade, 'browser_migration')
    });
  }

  for (const existingPosition of existingPositions) {
    const tracked = updateMetrics(existingPosition);
    void queueJournalEvent({
      eventId: `open:${existingPosition.id}`,
      type: 'TRADE_OPENED',
      trade: tracked,
      source: journalSource(tracked, 'browser_resume')
    });
  }

  watchTick();
  watchTimer = window.setInterval(watchTick, 1000);
  syncTimer = window.setInterval(() => { void flushJournalQueue(); }, 20000);

  onlineHandler = () => {
    void flushJournalQueue();
    void syncJournalHistory(1000).catch(() => {});
  };
  pageHideHandler = () => { void flushJournalQueue({ keepalive: true }); };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('pagehide', pageHideHandler);
  void flushJournalQueue();

  return stopTradeJournalBridge;
}

export function stopTradeJournalBridge() {
  if (watchTimer) window.clearInterval(watchTimer);
  if (syncTimer) window.clearInterval(syncTimer);
  watchTimer = null;
  syncTimer = null;
  if (onlineHandler) window.removeEventListener('online', onlineHandler);
  if (pageHideHandler) window.removeEventListener('pagehide', pageHideHandler);
  onlineHandler = null;
  pageHideHandler = null;
}

export async function loadRemoteTrades(limit = 500) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(`${API_URL}?limit=${Math.max(1, Math.min(1000, Number(limit) || 500))}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    return Array.isArray(data?.trades) ? data.trades.filter(trade => trade?.id && trade?.closedAt) : [];
  } finally {
    window.clearTimeout(timeout);
  }
}

function readActivePositions() {
  const core = readJson(CORE_POSITION_KEY, null);
  const scalp = readJson(SCALP_POSITION_KEY, null);
  const active = [core, scalp].filter(position => Boolean(position?.id));
  // Legacy key was a pointer to only one of two simultaneous positions.
  // Consult it only for a genuinely old build that has neither keyed position.
  if (!active.length) {
    const legacy = readJson(POSITION_KEY, null);
    const closedIds = new Set(readJson(HISTORY_KEY, [])
      .filter(trade => Boolean(trade?.closedAt)).map(trade => trade.id));
    if (legacy?.id && !closedIds.has(legacy.id)) active.push(legacy);
  }
  return [...new Map(active.map(position => [position.id, position])).values()];
}

async function watchTick() {
  const positions = readActivePositions();
  const history = readJson(HISTORY_KEY, []);
  const latestIds = new Set();

  for (const position of positions) {
    latestIds.add(position.id);
    const tracked = updateMetrics(position);
    const metrics = getMetrics(position.id);

    if (!currentPositionIds.has(position.id)) {
      void queueJournalEvent({
        eventId: `open:${position.id}`,
        type: 'TRADE_OPENED',
        trade: tracked,
        source: journalSource(tracked, 'mentor')
      });
    }

    const minuteBucket = Math.floor(Date.now() / 60000);
    if (metrics?.lastCheckpointBucket !== minuteBucket) {
      setMetricFields(position.id, { lastCheckpointBucket: minuteBucket });
      void queueJournalEvent({
        eventId: `checkpoint:${position.id}:${minuteBucket}`,
        type: 'POSITION_CHECKPOINT',
        trade: tracked,
        source: journalSource(tracked, 'mentor')
      });
    }
  }
  currentPositionIds = latestIds;

  for (const trade of history) {
    if (!trade?.id || !trade?.closedAt || knownHistoryIds.has(trade.id)) continue;
    knownHistoryIds.add(trade.id);
    void queueJournalEvent({
      eventId: `close:${trade.id}`,
      type: 'TRADE_CLOSED',
      trade: withStoredMetrics(trade),
      source: journalSource(trade, 'mentor')
    });
  }
}

function journalSource(trade, fallback = 'mentor') {
  if (trade?.strategyFamily === 'SCALP' || trade?.strategyTier === 'SCALP') {
    const entry = trade.entryMethod || (trade.initiatedBy === 'MENTOR' ? 'AUTO' : 'MANUAL');
    const exit = trade.exitMethod || (trade.closedBy === 'MENTOR' ? 'AUTO' : trade.closedAt ? 'MANUAL' : '');
    return `scalp_${String(entry).toLowerCase()}${exit ? `_exit_${String(exit).toLowerCase()}` : ''}`;
  }
  return fallback;
}

function updateMetrics(position) {
  const id = position?.id;
  if (!id) return position;

  const underlying = numberOrNull(position.underlyingCurrent);
  const entryUnderlying = numberOrNull(position.underlyingEntry);
  const stopUnderlying = numberOrNull(position.underlyingStop);
  const optionPrice = numberOrNull(position.currentPrice);
  const optionEntry = numberOrNull(position.entry);
  const stored = getMetrics(id) || {};

  let currentR = numberOrNull(position.currentR) ?? numberOrNull(stored.currentR) ?? 0;
  if (underlying != null && entryUnderlying != null && stopUnderlying != null) {
    const risk = Math.max(0.01, Math.abs(entryUnderlying - stopUnderlying));
    const move = position.side === 'CE'
      ? underlying - entryUnderlying
      : entryUnderlying - underlying;
    currentR = move / risk;
  }

  const bestR = Math.max(numberOrNull(position.bestR) ?? numberOrNull(stored.bestR) ?? 0, currentR);
  const worstR = Math.min(numberOrNull(position.worstR) ?? numberOrNull(stored.worstR) ?? 0, currentR);
  const bestOptionPrice = optionPrice == null
    ? (numberOrNull(position.bestOptionPrice) ?? numberOrNull(stored.bestOptionPrice) ?? optionEntry)
    : Math.max(numberOrNull(position.bestOptionPrice) ?? numberOrNull(stored.bestOptionPrice) ?? optionEntry ?? optionPrice, optionPrice);
  const worstOptionPrice = optionPrice == null
    ? (numberOrNull(position.worstOptionPrice) ?? numberOrNull(stored.worstOptionPrice) ?? optionEntry)
    : Math.min(numberOrNull(position.worstOptionPrice) ?? numberOrNull(stored.worstOptionPrice) ?? optionEntry ?? optionPrice, optionPrice);

  setMetricFields(id, {
    currentR,
    bestR,
    worstR,
    bestOptionPrice,
    worstOptionPrice,
    oneRReached: Boolean(position.oneRReached || bestR >= 1),
    lastSeenAt: new Date().toISOString()
  });

  return {
    ...position,
    currentR,
    bestR,
    worstR,
    bestOptionPrice,
    worstOptionPrice,
    oneRReached: Boolean(position.oneRReached || bestR >= 1)
  };
}

function withStoredMetrics(trade) {
  if (!trade?.id) return trade;
  const stored = getMetrics(trade.id) || {};
  return {
    ...trade,
    currentR: trade.currentR ?? stored.currentR,
    bestR: trade.bestR ?? stored.bestR,
    worstR: trade.worstR ?? stored.worstR,
    bestOptionPrice: trade.bestOptionPrice ?? stored.bestOptionPrice,
    worstOptionPrice: trade.worstOptionPrice ?? stored.worstOptionPrice,
    oneRReached: trade.oneRReached ?? stored.oneRReached
  };
}

async function queueJournalEvent({ eventId, type, trade, source }) {
  if (!trade?.id || !type) return;
  const event = {
    id: eventId || makeId(),
    type,
    queuedAt: new Date().toISOString(),
    source: source || 'mentor',
    trade: compactTrade(trade)
  };
  await putOutbox(event);
  void flushJournalQueue();
}

async function flushJournalQueue({ keepalive = false } = {}) {
  // Sheet/Apps Script failures must never compete with market-data requests.
  // Keep all journal events in IndexedDB/localStorage and retry later.
  // A pagehide must not bypass the failed journal's retry window.
  if (Date.now() < nextJournalSyncAt) return;
  if (flushPromise) return flushPromise;
  flushPromise = (async () => {
    const events = await getOutbox();
    events.sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));

    for (const event of events) {
      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'journal_event', event }),
          cache: 'no-store',
          keepalive
        });
        if (!response.ok) {
          journalFailureCount = Math.min(5, journalFailureCount + 1);
          nextJournalSyncAt = Date.now() + Math.min(120000, 5000 * (2 ** (journalFailureCount - 1)));
          break;
        }
        const data = await response.json().catch(() => ({}));
        if (!data?.ok) {
          journalFailureCount = Math.min(5, journalFailureCount + 1);
          nextJournalSyncAt = Date.now() + Math.min(120000, 5000 * (2 ** (journalFailureCount - 1)));
          break;
        }
        journalFailureCount = 0;
        nextJournalSyncAt = 0;
        await deleteOutbox(event.id);
      } catch {
        journalFailureCount = Math.min(5, journalFailureCount + 1);
        nextJournalSyncAt = Date.now() + Math.min(120000, 5000 * (2 ** (journalFailureCount - 1)));
        break;
      }
    }
  })();

  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
}

function compactTrade(trade) {
  const entrySnapshot = {
    market: trade.entryMarket || null,
    structure: trade.entryStructure || null,
    decision: trade.entryDecision || null,
    option: trade.entryOption || null,
    parameters: trade.parameterSnapshot || null
  };

  return {
    ...trade,
    entrySnapshot,
    exitSnapshot: trade.exitSnapshot || null
  };
}

function mergeHistory(local, remote) {
  const map = new Map();
  for (const trade of local || []) {
    if (trade?.id) map.set(trade.id, trade);
  }
  for (const trade of remote || []) {
    if (!trade?.id) continue;
    map.set(trade.id, { ...(map.get(trade.id) || {}), ...trade });
  }
  return [...map.values()]
    .filter(trade => trade?.closedAt)
    .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
    .slice(0, 1000);
}

function dispatchHistory(history) {
  try {
    window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { history } }));
  } catch {}
}

function getMetrics(id) {
  const all = readJson(METRICS_KEY, {});
  return all?.[id] || null;
}

function setMetricFields(id, patch) {
  const all = readJson(METRICS_KEY, {});
  all[id] = { ...(all[id] || {}), ...patch };
  const ids = Object.keys(all);
  if (ids.length > 100) {
    ids
      .sort((a, b) => String(all[a]?.lastSeenAt || '').localeCompare(String(all[b]?.lastSeenAt || '')))
      .slice(0, ids.length - 100)
      .forEach(oldId => delete all[oldId]);
  }
  writeJson(METRICS_KEY, all);
  return all[id];
}

function readJson(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function makeId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => window.setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

function openDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function putOutbox(event) {
  const db = await openDb();
  if (!db) return putFallback(event);
  await transact(db, 'readwrite', store => store.put(event));
}

async function getOutbox() {
  const db = await openDb();
  if (!db) return getFallback();
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

async function deleteOutbox(id) {
  const db = await openDb();
  if (!db) return deleteFallback(id);
  await transact(db, 'readwrite', store => store.delete(id));
}

function transact(db, mode, action) {
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE_NAME, mode);
      action(tx.objectStore(STORE_NAME));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

const FALLBACK_KEY = 'index-options-mentor-journal-outbox-v1';
function getFallback() { return readJson(FALLBACK_KEY, []); }
function putFallback(event) {
  const rows = getFallback().filter(row => row?.id !== event.id);
  rows.push(event);
  writeJson(FALLBACK_KEY, rows.slice(-500));
}
function deleteFallback(id) {
  writeJson(FALLBACK_KEY, getFallback().filter(row => row?.id !== id));
}
