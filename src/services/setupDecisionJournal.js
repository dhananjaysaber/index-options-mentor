const TRACKERS_KEY = 'index-options-mentor-setup-trackers-v1';
const QUEUE_KEY = 'index-options-mentor-setup-journal-queue-v1';
const API_URL = '/api/journal';
const MILESTONES = [5, 10, 15, 30];

let installed = false;
let flushTimer = null;
let nativeFetch = null;

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
  const nowMs = new Date(snapshot.generatedAt).getTime();
  if (!Number.isFinite(nowMs)) return;

  let changed = false;
  for (const tracker of Object.values(trackers)) {
    if (!tracker?.id || tracker.sessionDate !== snapshot.market.sessionDate || tracker.status === 'COMPLETE') continue;
    changed = updateTrackerOutcomes(tracker, snapshot, nowMs) || changed;
  }

  const setupId = snapshot?.setup?.setupId;
  const retestHeld = snapshot?.setup?.retestStatus === 'HELD';
  if (snapshot.live === true && setupId && retestHeld && snapshot?.decision?.side) {
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

  const activeIds = Object.keys(trackers);
  if (activeIds.length > 80) {
    activeIds
      .sort((a, b) => String(trackers[a]?.firstSeenAt || '').localeCompare(String(trackers[b]?.firstSeenAt || '')))
      .slice(0, activeIds.length - 80)
      .forEach(id => delete trackers[id]);
    changed = true;
  }

  if (changed) {
    writeJson(TRACKERS_KEY, trackers);
    for (const tracker of Object.values(trackers)) {
      if (tracker?.needsSync) queueSetup(tracker);
    }
    void flushQueue();
  }
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

function queueSetup(tracker) {
  const queue = readJson(QUEUE_KEY, {});
  const payload = serialiseTracker(tracker);
  queue[tracker.id] = payload;
  writeJson(QUEUE_KEY, queue);
  tracker.needsSync = false;
}

async function flushQueue({ keepalive = false } = {}) {
  if (!nativeFetch) nativeFetch = window.fetch.bind(window);
  const queue = readJson(QUEUE_KEY, {});
  for (const [id, payload] of Object.entries(queue)) {
    try {
      const response = await nativeFetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setup_decision', setup: payload }),
        cache: 'no-store',
        keepalive
      });
      if (!response.ok) break;
      const data = await response.json().catch(() => ({}));
      if (!data?.ok) break;
      const latestQueue = readJson(QUEUE_KEY, {});
      if (latestQueue[id]?.updatedAt === payload.updatedAt) {
        delete latestQueue[id];
        writeJson(QUEUE_KEY, latestQueue);
      }
    } catch {
      break;
    }
  }
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
    outcomes: tracker.outcomes
  };
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
