import { readTradingJson, writeTradingJson } from './tradingStorage.js';
import { sendJournalWrite } from './journalTransport.js';
import {
  advanceShadowResearchTrade,
  buildShadowResearchTrade,
  classifyShadowResearchEntry,
  closeShadowResearchTrade
} from '../engine/shadowResearch.js';

const TRACKERS_KEY = 'index-options-mentor-setup-trackers-v1';
const QUEUE_KEY = 'index-options-mentor-setup-journal-queue-v1';
const SHADOW_TRADES_KEY = 'index-options-mentor-shadow-research-v1';
const SHADOW_EVENT_QUEUE_KEY = 'index-options-mentor-shadow-journal-queue-v1';
const API_URL = '/api/journal';
const MILESTONES = [5, 10, 15, 30];

let installed = false;
let flushTimer = null;
let nativeFetch = null;
let journalFlushPromise = null;
let journalFailureCount = 0;
let nextJournalAttemptAt = 0;

export function installSetupDecisionObserver() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  nativeFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input?.url || '', window.location.origin);
      if (url.origin === window.location.origin && url.pathname === '/api/fyers/mentor-snapshot' && response.ok) {
        response.clone().json().then(snapshot => {
          try { observeSnapshot(snapshot); } catch {}
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  flushTimer = window.setInterval(() => { void flushQueue(); }, 20000);
  window.addEventListener('online', () => { void flushQueue(); });
  window.addEventListener('pagehide', () => { void flushQueue({ keepalive: true }); });
  void flushQueue();
}

function observeSnapshot(snapshot) {
  if (!snapshot?.generatedAt || !snapshot?.market?.sessionDate || !Number.isFinite(Number(snapshot?.market?.spot))) return;

  const trackers = readJson(TRACKERS_KEY, {});
  const shadowTrades = readJson(SHADOW_TRADES_KEY, {});
  const nowMs = new Date(snapshot.generatedAt).getTime();
  if (!Number.isFinite(nowMs)) return;

  let changed = false;
  let shadowChanged = false;

  for (const tracker of Object.values(trackers)) {
    if (!tracker?.id || tracker.sessionDate !== snapshot.market.sessionDate || tracker.status === 'COMPLETE') continue;
    changed = updateTrackerOutcomes(tracker, snapshot, nowMs) || changed;
  }

  // Background shadow positions are independent of the single visible simulated
  // position. They let us collect 3/5, 4/5 and 5/5 research evidence in parallel.
  for (const [tradeId, trade] of Object.entries(shadowTrades)) {
    if (!trade?.id || trade.status !== 'OPEN') continue;
    const result = advanceShadowResearchTrade(trade, snapshot);
    if (!result?.trade) continue;
    shadowTrades[tradeId] = result.trade;
    shadowChanged = true;

    if (result.exit) {
      shadowTrades[tradeId] = {
        ...result.trade,
        status: 'CLOSING',
        pendingExit: result.exit
      };
      void finaliseShadowExit(tradeId, snapshot, result.exit);
    }
  }

  const setupId = snapshot?.setup?.setupId;
  const hasDirection = snapshot?.decision?.side === 'CE' || snapshot?.decision?.side === 'PE';
  const allChecksAvailable = Array.isArray(snapshot?.parameters) && snapshot.parameters.length >= 13;
  const closeConfirmed = snapshot?.structure?.closeConfirmed === true;
  const trackable = snapshot.live === true && setupId && hasDirection && allChecksAvailable && closeConfirmed;

  if (trackable) {
    if (!trackers[setupId]) {
      trackers[setupId] = createTracker(snapshot);
      changed = true;
    } else {
      changed = updateTrackerOutcomes(trackers[setupId], snapshot, nowMs) || changed;
      trackers[setupId].latestState = snapshot.decision.state;
      trackers[setupId].latestScore = snapshot.decision.score;
      trackers[setupId].latestSpot = Number(snapshot.market.spot);
      trackers[setupId].updatedAt = snapshot.generatedAt;
    }
  }

  const shadowClass = classifyShadowResearchEntry(snapshot);
  if (shadowClass.eligible) {
    const shadowId = `shadow:${shadowClass.key}`;
    if (!shadowTrades[shadowId]) {
      const trade = buildShadowResearchTrade(snapshot, shadowClass);
      if (trade) {
        shadowTrades[shadowId] = trade;
        shadowChanged = true;
        queueShadowEvent({
          eventId: `shadow-open:${trade.id}`,
          type: 'TRADE_OPENED',
          trade
        });

        const tracker = trackers[setupId] || (trackers[setupId] = createTracker(snapshot));
        tracker.shadowTradeId = trade.id;
        tracker.shadowStatus = 'OPEN';
        tracker.shadowCohort = trade.shadowCohort;
        tracker.shadowOpenedAt = trade.openedAt;
        tracker.shadowEntryRetestStatus = trade.retestStatusAtEntry;
        tracker.shadowEntryRRBand = trade.rrBand;
        tracker.shadowEntryConfirmationPassCount = trade.entryConfirmationPassCount;
        tracker.shadowMentorApprovedAtEntry = trade.mentorApprovedAtEntry;
        tracker.needsSync = true;
        changed = true;
      }
    }
  }

  pruneShadowTrades(shadowTrades);

  const activeIds = Object.keys(trackers);
  if (activeIds.length > 120) {
    activeIds
      .sort((a, b) => String(trackers[a]?.firstSeenAt || '').localeCompare(String(trackers[b]?.firstSeenAt || '')))
      .slice(0, activeIds.length - 120)
      .forEach(id => delete trackers[id]);
    changed = true;
  }

  if (shadowChanged) writeJson(SHADOW_TRADES_KEY, shadowTrades);

  if (changed) {
    writeJson(TRACKERS_KEY, trackers);
    for (const tracker of Object.values(trackers)) {
      if (tracker?.needsSync) queueSetup(tracker);
    }
  }

  if (changed || shadowChanged) void flushQueue();
}

function createTracker(snapshot) {
  const parameters = Array.isArray(snapshot.parameters) ? snapshot.parameters.map(row => ({
    id: row.id,
    label: row.label,
    value: row.value,
    status: row.status,
    mandatory: row.mandatory,
    gatePassed: row.gatePassed,
    weight: row.weight
  })) : [];
  const mandatory = parameters.filter(row => row.mandatory);
  const failed = mandatory.filter(row => row.gatePassed === false);
  const approved = Boolean(snapshot.decision.canSuggestTrade);
  const atr = Number(snapshot.market.atr5 || 0);
  const trigger = Number(snapshot.structure?.trigger || 0);
  const spot = Number(snapshot.market.spot);
  const riskPoints = Number(snapshot.structure?.riskPoints || 0);
  const distanceFromTrigger = Math.abs(spot - trigger);

  return {
    id: snapshot.setup.setupId,
    sessionDate: snapshot.market.sessionDate,
    firstSeenAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
    status: 'WATCHING',
    side: snapshot.decision.side,
    initialDecisionState: snapshot.decision.state,
    latestState: snapshot.decision.state,
    approvedAtCapture: approved,
    rejectionReason: approved ? '' : (snapshot.decision.reasons || []).join(' | '),
    initialScore: snapshot.decision.score,
    latestScore: snapshot.decision.score,
    plannedRR: snapshot.decision.rr,
    availableRR: snapshot.decision.availableRR,
    optionSymbol: snapshot.option?.symbol || '',
    optionStrike: snapshot.option?.strike ?? '',
    optionLtp: snapshot.option?.ltp ?? '',
    entrySpot: spot,
    latestSpot: spot,
    trigger,
    retestTime: snapshot.setup?.retestTime || '',
    breakoutTime: snapshot.setup?.breakoutTime || '',
    structuralStop: snapshot.structure?.underlyingStop ?? '',
    plannedTarget: snapshot.structure?.underlyingTarget ?? '',
    riskPoints,
    stopAtrRatio: snapshot.structure?.stopAtrRatio ?? (atr > 0 ? riskPoints / atr : ''),
    roomPoints: snapshot.structure?.roomPoints ?? '',
    atr5: atr,
    vwap: snapshot.market.vwap ?? '',
    orh: snapshot.market.orh ?? '',
    orl: snapshot.market.orl ?? '',
    pdh: snapshot.market.pdh ?? '',
    pdl: snapshot.market.pdl ?? '',
    distanceFromTrigger,
    distanceFromTriggerAtr: snapshot.structure?.distanceFromTriggerAtr ?? (atr > 0 ? distanceFromTrigger / atr : ''),
    mandatoryPassCount: mandatory.length - failed.length,
    mandatoryFailIds: failed.map(row => row.id),
    parameters,
    bestFavourablePoints: 0,
    worstAdversePoints: 0,
    bestHypotheticalR: 0,
    worstHypotheticalR: 0,
    outcomes: {},
    shadowTradeId: '',
    shadowStatus: '',
    shadowCohort: '',
    shadowOpenedAt: '',
    shadowClosedAt: '',
    shadowExitReasonCode: '',
    shadowExitR: '',
    shadowEntryRetestStatus: '',
    shadowEntryRRBand: '',
    shadowEntryConfirmationPassCount: '',
    shadowMentorApprovedAtEntry: false,
    lastSyncBucket: -1,
    needsSync: true
  };
}

function updateTrackerOutcomes(tracker, snapshot, nowMs) {
  const firstMs = new Date(tracker.firstSeenAt).getTime();
  if (!Number.isFinite(firstMs)) return false;
  const elapsedMinutes = Math.max(0, (nowMs - firstMs) / 60000);
  const spot = Number(snapshot.market.spot);
  const entrySpot = Number(tracker.entrySpot);
  if (!Number.isFinite(spot) || !Number.isFinite(entrySpot)) return false;

  const directionalMove = tracker.side === 'CE' ? spot - entrySpot : entrySpot - spot;
  const favourable = Math.max(0, directionalMove);
  const adverse = Math.max(0, -directionalMove);
  const risk = Math.max(0.01, Number(tracker.riskPoints || 0));
  let changed = false;

  if (favourable > Number(tracker.bestFavourablePoints || 0)) {
    tracker.bestFavourablePoints = favourable;
    tracker.bestHypotheticalR = favourable / risk;
    changed = true;
  }
  if (adverse > Number(tracker.worstAdversePoints || 0)) {
    tracker.worstAdversePoints = adverse;
    tracker.worstHypotheticalR = -(adverse / risk);
    changed = true;
  }

  for (const minute of MILESTONES) {
    const key = String(minute);
    if (elapsedMinutes >= minute && !tracker.outcomes[key]) {
      tracker.outcomes[key] = {
        capturedAt: snapshot.generatedAt,
        nifty: spot,
        movePoints: directionalMove,
        hypotheticalR: directionalMove / risk,
        decisionState: snapshot.decision?.state || '',
        score: snapshot.decision?.score ?? ''
      };
      changed = true;
    }
  }

  tracker.latestSpot = spot;
  tracker.latestState = snapshot.decision?.state || tracker.latestState;
  tracker.latestScore = snapshot.decision?.score ?? tracker.latestScore;
  tracker.updatedAt = snapshot.generatedAt;

  const syncBucket = Math.floor(elapsedMinutes);
  if (syncBucket !== tracker.lastSyncBucket) {
    tracker.lastSyncBucket = syncBucket;
    changed = true;
  }

  if (elapsedMinutes >= 30 && tracker.status !== 'COMPLETE') {
    tracker.status = 'COMPLETE';
    changed = true;
  }

  if (changed) tracker.needsSync = true;
  return changed;
}

async function finaliseShadowExit(tradeId, snapshot, exitMeta) {
  const shadowTrades = readJson(SHADOW_TRADES_KEY, {});
  const trade = shadowTrades[tradeId];
  if (!trade || (trade.status !== 'CLOSING' && trade.status !== 'OPEN')) return;

  const optionExit = await quoteOptionWithTimeout(trade.symbol);
  const closed = closeShadowResearchTrade(trade, snapshot, exitMeta, optionExit);
  shadowTrades[tradeId] = closed;
  writeJson(SHADOW_TRADES_KEY, shadowTrades);

  queueShadowEvent({
    eventId: `shadow-close:${closed.id}`,
    type: 'TRADE_CLOSED',
    trade: closed
  });

  const trackers = readJson(TRACKERS_KEY, {});
  const tracker = trackers[closed.setupId];
  if (tracker) {
    tracker.shadowTradeId = closed.id;
    tracker.shadowStatus = 'CLOSED';
    tracker.shadowCohort = closed.shadowCohort;
    tracker.shadowClosedAt = closed.closedAt;
    tracker.shadowExitReasonCode = closed.exitReasonCode;
    tracker.shadowExitR = closed.rAchieved;
    tracker.updatedAt = closed.closedAt;
    tracker.needsSync = true;
    writeJson(TRACKERS_KEY, trackers);
    queueSetup(tracker);
  }

  void flushQueue();
}

async function quoteOptionWithTimeout(symbol) {
  if (!symbol || !nativeFetch) return null;
  try {
    const quotePromise = (async () => {
      const response = await nativeFetch(`/api/fyers/quote?symbol=${encodeURIComponent(symbol)}`, { cache: 'no-store' });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      const nodes = Array.isArray(data?.d) ? data.d : [];
      const node = nodes.find(row => row?.n === symbol || row?.v?.symbol === symbol);
      const ltp = Number(node?.v?.lp);
      return Number.isFinite(ltp) && ltp > 0 ? ltp : null;
    })();
    return await Promise.race([
      quotePromise,
      new Promise(resolve => window.setTimeout(() => resolve(null), 2500))
    ]);
  } catch {
    return null;
  }
}

function pruneShadowTrades(shadowTrades) {
  const entries = Object.entries(shadowTrades || {});
  if (entries.length <= 250) return;
  entries
    .filter(([, trade]) => trade?.status === 'CLOSED')
    .sort((a, b) => String(a[1]?.closedAt || '').localeCompare(String(b[1]?.closedAt || '')))
    .slice(0, Math.max(0, entries.length - 250))
    .forEach(([id]) => delete shadowTrades[id]);
}

function queueSetup(tracker) {
  const queue = readJson(QUEUE_KEY, {});
  const payload = serialiseTracker(tracker);
  queue[tracker.id] = payload;
  writeJson(QUEUE_KEY, queue);
  tracker.needsSync = false;
}

function queueShadowEvent({ eventId, type, trade }) {
  if (!eventId || !type || !trade?.id) return;
  const queue = readJson(SHADOW_EVENT_QUEUE_KEY, {});
  queue[eventId] = {
    id: eventId,
    type,
    queuedAt: new Date().toISOString(),
    source: 'shadow_research',
    trade
  };
  writeJson(SHADOW_EVENT_QUEUE_KEY, queue);
}

async function flushQueue({ keepalive = false } = {}) {
  // One writer per tab; do not bypass a failed Google Sheets backoff even
  // during pagehide or repeated mentor-snapshot events.
  if (journalFlushPromise) return journalFlushPromise;
  if (Date.now() < nextJournalAttemptAt) return;
  if (!nativeFetch) nativeFetch = window.fetch.bind(window);

  journalFlushPromise = (async () => {
    const fail = () => {
      journalFailureCount = Math.min(6, journalFailureCount + 1);
      nextJournalAttemptAt = Date.now() +
        Math.min(180000, 10000 * 2 ** (journalFailureCount - 1));
    };
    const success = () => {
      journalFailureCount = 0;
      nextJournalAttemptAt = 0;
    };

    // Limit one flush to 4 events so a large offline queue cannot overwhelm
    // Apps Script. Unacknowledged events remain in localStorage for retry.
    let attempts = 0;
    const queues = [
      {
        key: QUEUE_KEY,
        action: 'setup_decision',
        field: 'setup',
        identity: 'updatedAt'
      },
      {
        key: SHADOW_EVENT_QUEUE_KEY,
        action: 'journal_event',
        field: 'event',
        identity: 'queuedAt'
      }
    ];

    for (const batch of queues) {
      const pending = readJson(batch.key, {});
      for (const [id, payload] of Object.entries(pending)) {
        if (attempts >= 4) return;
        attempts++;
        let response;
        try {
          response = await sendJournalWrite(
            { action: batch.action, [batch.field]: payload },
            { keepalive }
          );
          if (!response.ok) { fail(); return; }
          const data = await response.json().catch(() => ({}));
          if (!data?.ok) { fail(); return; }
        } catch { fail(); return; }

        const current = readJson(batch.key, {});
        if (current[id]?.[batch.identity] === payload[batch.identity]) {
          delete current[id];
          writeJson(batch.key, current);
        }
        success();
      }
    }
  })();

  try { await journalFlushPromise; }
  finally { journalFlushPromise = null; }
}

function serialiseTracker(tracker) {
  return {
    id: tracker.id,
    sessionDate: tracker.sessionDate,
    firstSeenAt: tracker.firstSeenAt,
    updatedAt: tracker.updatedAt,
    status: tracker.status,
    side: tracker.side,
    initialDecisionState: tracker.initialDecisionState,
    latestState: tracker.latestState,
    approvedAtCapture: tracker.approvedAtCapture,
    rejectionReason: tracker.rejectionReason,
    initialScore: tracker.initialScore,
    latestScore: tracker.latestScore,
    plannedRR: tracker.plannedRR,
    availableRR: tracker.availableRR,
    optionSymbol: tracker.optionSymbol,
    optionStrike: tracker.optionStrike,
    optionLtp: tracker.optionLtp,
    entrySpot: tracker.entrySpot,
    latestSpot: tracker.latestSpot,
    trigger: tracker.trigger,
    breakoutTime: tracker.breakoutTime,
    retestTime: tracker.retestTime,
    structuralStop: tracker.structuralStop,
    plannedTarget: tracker.plannedTarget,
    riskPoints: tracker.riskPoints,
    stopAtrRatio: tracker.stopAtrRatio,
    roomPoints: tracker.roomPoints,
    atr5: tracker.atr5,
    vwap: tracker.vwap,
    orh: tracker.orh,
    orl: tracker.orl,
    pdh: tracker.pdh,
    pdl: tracker.pdl,
    distanceFromTrigger: tracker.distanceFromTrigger,
    distanceFromTriggerAtr: tracker.distanceFromTriggerAtr,
    mandatoryPassCount: tracker.mandatoryPassCount,
    mandatoryFailIds: tracker.mandatoryFailIds,
    parameters: tracker.parameters,
    bestFavourablePoints: tracker.bestFavourablePoints,
    worstAdversePoints: tracker.worstAdversePoints,
    bestHypotheticalR: tracker.bestHypotheticalR,
    worstHypotheticalR: tracker.worstHypotheticalR,
    outcomes: tracker.outcomes,
    shadowTradeId: tracker.shadowTradeId,
    shadowStatus: tracker.shadowStatus,
    shadowCohort: tracker.shadowCohort,
    shadowOpenedAt: tracker.shadowOpenedAt,
    shadowClosedAt: tracker.shadowClosedAt,
    shadowExitReasonCode: tracker.shadowExitReasonCode,
    shadowExitR: tracker.shadowExitR,
    shadowEntryRetestStatus: tracker.shadowEntryRetestStatus,
    shadowEntryRRBand: tracker.shadowEntryRRBand,
    shadowEntryConfirmationPassCount: tracker.shadowEntryConfirmationPassCount,
    shadowMentorApprovedAtEntry: tracker.shadowMentorApprovedAtEntry
  };
}

function readJson(key, fallback) { return readTradingJson(key, fallback); }

function writeJson(key, value) { writeTradingJson(key, value); }


