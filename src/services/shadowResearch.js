import { readTradingJson, writeTradingJson } from './tradingStorage.js';
import { derivePositionMentor } from '../engine/positionMentor.js';

const SETTINGS_KEY = 'index-options-mentor-settings-v2';
const HISTORY_KEY = 'index-options-mentor-history-v05';
const ACTIVE_KEY = 'index-options-mentor-shadow-positions-v1';
const LEDGER_KEY = 'index-options-mentor-shadow-ledger-v1';
const MAX_ACTIVE = 12;
const MAX_LEDGER = 300;
const MIN_SCORE = 60;
const MIN_CONFIRMATIONS = 4;
const MAX_HOLD_MINUTES = 90;
const HARD_GATE_IDS = new Set(['risk', 'liquidity']);

let installed = false;
let previousFetch = null;
let processing = false;
let queuedSnapshot = null;

export function installShadowResearchEngine() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  previousFetch = window.fetch.bind(window);

  window.fetch = async (...args) => {
    const response = await previousFetch(...args);
    try {
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input?.url || '', window.location.origin);
      if (url.origin === window.location.origin && url.pathname === '/api/fyers/mentor-snapshot' && response.ok) {
        response.clone().json().then(snapshot => enqueueSnapshot(snapshot)).catch(() => {});
      }
    } catch {}
    return response;
  };
}

function enqueueSnapshot(snapshot) {
  queuedSnapshot = snapshot;
  if (processing) return;
  processing = true;
  void (async () => {
    try {
      while (queuedSnapshot) {
        const next = queuedSnapshot;
        queuedSnapshot = null;
        await processSnapshot(next);
      }
    } finally {
      processing = false;
    }
  })();
}

async function processSnapshot(snapshot) {
  if (!snapshot?.generatedAt || !snapshot?.market?.sessionDate) return;

  const settings = readJson(SETTINGS_KEY, {});
  let active = readJson(ACTIVE_KEY, []);
  const ledger = readJson(LEDGER_KEY, {});
  const opened = [];

  const candidate = classifyShadowEntry(snapshot, settings);
  if (candidate.eligible && active.length < MAX_ACTIVE && !ledger[candidate.setupId]) {
    const ticket = buildShadowTicket(snapshot, candidate, settings);
    if (ticket) {
      active.push(ticket);
      opened.push(ticket);
      ledger[candidate.setupId] = {
        openedAt: ticket.openedAt,
        cohort: ticket.strategyTier,
        side: ticket.side,
        score: ticket.score,
        rr: ticket.rr
      };
      pruneLedger(ledger);
      writeJson(LEDGER_KEY, ledger);
    }
  }

  if (!active.length) {
    if (opened.length) writeJson(ACTIVE_KEY, active);
    publishStatus(active, opened, []);
    return;
  }

  active = await refreshQuotes(active, snapshot);
  const stillOpen = [];
  const closed = [];

  for (const position of active) {
    const decision = deriveShadowExit(position, snapshot);
    if (!decision.exit) {
      stillOpen.push(updateResearchMetrics(position, snapshot));
      continue;
    }
    closed.push(closeShadowPosition(position, snapshot, decision));
  }

  writeJson(ACTIVE_KEY, stillOpen);
  if (closed.length) appendHistory(closed);
  publishStatus(stillOpen, opened, closed);
}

function classifyShadowEntry(snapshot, settings) {
  const parameters = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const mandatory = parameters.filter(row => row.mandatory);
  const confirmations = parameters.filter(row => !row.mandatory);
  const failedMandatory = mandatory.filter(row => row.gatePassed === false);
  const mandatoryPassCount = mandatory.length - failedMandatory.length;
  const confirmationPassCount = confirmations.filter(row => row.status === 'green').length;
  const hardSafetyPassed = [...HARD_GATE_IDS].every(id => parameters.find(row => row.id === id)?.gatePassed === true);
  const score = Number(snapshot?.decision?.score);
  const rr = Number(snapshot?.decision?.rr);
  const live = snapshot?.live === true && snapshot?.market?.phase === 'LIVE';
  const closeConfirmed = snapshot?.structure?.closeConfirmed === true;
  const retestHeld = snapshot?.setup?.retestStatus === 'HELD' && snapshot?.structure?.retestFailed !== true;
  const hasOption = Boolean(snapshot?.option?.symbol && Number(snapshot?.option?.lotSize) > 0 && Number(snapshot?.option?.ltp) > 0);
  const hasDirection = ['CE', 'PE'].includes(snapshot?.decision?.side || snapshot?.option?.optionType);
  const stop = Number(snapshot?.structure?.underlyingStop);
  const riskPoints = Number(snapshot?.structure?.riskPoints);
  const hasStructure = Number.isFinite(stop) && stop > 0 && Number.isFinite(riskPoints) && riskPoints > 0;
  const hasAllChecks = parameters.length >= 13 && mandatory.length >= 5 && confirmations.length >= 8;
  const setupId = snapshot?.setup?.setupId || [
    snapshot?.market?.sessionDate || 'session',
    snapshot?.decision?.side || 'none',
    snapshot?.setup?.breakoutTime || 'breakout',
    snapshot?.setup?.retestTime || 'retest'
  ].join(':');

  let cohort = null;
  if (mandatoryPassCount >= 5) cohort = 'SHADOW_5_OF_5';
  else if (mandatoryPassCount === 4 && settings?.controlledResearch !== false) cohort = 'SHADOW_4_OF_5';
  else if (mandatoryPassCount === 3 && settings?.experimentalResearch === true) cohort = 'SHADOW_3_OF_5';

  const eligible = Boolean(
    settings?.mentorAutoOpen !== false &&
    cohort &&
    live &&
    hasAllChecks &&
    hasOption &&
    hasDirection &&
    hasStructure &&
    closeConfirmed &&
    retestHeld &&
    hardSafetyPassed &&
    Number.isFinite(score) && score >= MIN_SCORE &&
    confirmationPassCount >= MIN_CONFIRMATIONS
  );

  return {
    eligible,
    cohort,
    setupId,
    score,
    rr: Number.isFinite(rr) ? rr : null,
    mandatoryPassCount,
    confirmationPassCount,
    failedMandatoryIds: failedMandatory.map(row => row.id),
    hardSafetyPassed,
    closeConfirmed,
    retestHeld
  };
}

function buildShadowTicket(snapshot, classification, settings) {
  const { market, option, structure, decision } = snapshot;
  const lots = clampInt(settings?.defaultLots, 1, Math.max(1, Number(settings?.lotCap) || 5));
  const lotSize = Number(option?.lotSize) || 0;
  const entry = Number(option?.ltp);
  const underlyingEntry = Number(market?.spot);
  const underlyingStop = Number(structure?.underlyingStop);
  if (!lotSize || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(underlyingEntry) || !Number.isFinite(underlyingStop)) return null;

  const label = classification.cohort === 'SHADOW_5_OF_5'
    ? 'Shadow research 5/5'
    : classification.cohort === 'SHADOW_4_OF_5'
      ? 'Shadow research 4/5'
      : 'Shadow research 3/5';

  return {
    id: crypto.randomUUID(),
    mode: 'SIMULATION',
    shadowResearch: true,
    autoManaged: true,
    initiatedBy: 'SHADOW_RESEARCH',
    openedByMentor: false,
    setupId: classification.setupId,
    openedAt: new Date().toISOString(),
    strategyTier: classification.cohort,
    strategyTierLabel: label,
    approvalState: decision?.state,
    mentorDecisionAtEntry: decision?.state,
    mentorSuggestionAtEntry: decision?.headline || '',
    score: classification.score,
    rr: classification.rr,
    side: option.optionType || decision.side,
    symbol: option.symbol,
    strike: option.strike,
    expiry: option.expiry,
    lotSize,
    lots,
    quantity: lots * lotSize,
    entry,
    currentPrice: entry,
    underlyingEntry,
    underlyingCurrent: underlyingEntry,
    underlyingStop,
    underlyingTarget: numberOrNull(structure?.underlyingTarget),
    currentR: 0,
    bestR: 0,
    worstR: 0,
    bestOptionPrice: entry,
    worstOptionPrice: entry,
    oneRReached: false,
    entryMandatoryPassCount: classification.mandatoryPassCount,
    entryConfirmationPassCount: classification.confirmationPassCount,
    failedMandatoryIds: classification.failedMandatoryIds,
    shadowEntryRules: {
      minMandatory: 3,
      minConfirmations: MIN_CONFIRMATIONS,
      minScore: MIN_SCORE,
      hardSafetyGates: [...HARD_GATE_IDS],
      closeConfirmedRequired: true,
      retestHeldRequired: true,
      rrRequiredForEntry: false
    },
    parameterSnapshot: snapshot.parameters,
    reasons: decision?.reasons || [],
    entryMarket: { ...market },
    entryStructure: { ...structure },
    entryDecision: { ...decision },
    entryOption: { ...option }
  };
}

async function refreshQuotes(active, snapshot) {
  const symbols = [...new Set(active.map(row => row.symbol).filter(Boolean))];
  if (!symbols.length) return active.map(row => updateUnderlying(row, Number(snapshot?.market?.spot)));

  try {
    const query = [...symbols, 'NSE:NIFTY50-INDEX'].join(',');
    const response = await previousFetch(`/api/fyers/quote?symbol=${encodeURIComponent(query)}`, { cache: 'no-store' });
    if (!response.ok) return active.map(row => updateUnderlying(row, Number(snapshot?.market?.spot)));
    const data = await response.json();
    const nodes = Array.isArray(data?.d) ? data.d : [];
    const prices = new Map();
    for (const node of nodes) {
      const symbol = node?.n || node?.v?.symbol;
      const price = Number(node?.v?.lp);
      if (symbol && Number.isFinite(price)) prices.set(symbol, price);
    }
    const nifty = prices.get('NSE:NIFTY50-INDEX') ?? Number(snapshot?.market?.spot);
    return active.map(row => {
      const optionPrice = prices.get(row.symbol);
      return updateLive(row, optionPrice, nifty);
    });
  } catch {
    return active.map(row => updateUnderlying(row, Number(snapshot?.market?.spot)));
  }
}

function deriveShadowExit(position, snapshot) {
  const currentUnderlying = Number(position?.underlyingCurrent);
  if (!Number.isFinite(currentUnderlying)) return { exit: false };

  const riskPoints = Math.max(0.01, Math.abs(Number(position.underlyingEntry) - Number(position.underlyingStop)));
  const movePoints = position.side === 'CE'
    ? currentUnderlying - Number(position.underlyingEntry)
    : Number(position.underlyingEntry) - currentUnderlying;
  const rMultiple = movePoints / riskPoints;
  const target = numberOrNull(position.underlyingTarget);
  const targetHit = target != null && (position.side === 'CE' ? currentUnderlying >= target : currentUnderlying <= target);

  if (targetHit) {
    return {
      exit: true,
      reasonCode: 'STRUCTURAL_TARGET_REACHED',
      title: 'TARGET EXIT',
      reason: `The original structural target at ${target.toFixed(2)} was reached.`,
      rMultiple
    };
  }

  const mentor = derivePositionMentor(position, snapshot, currentUnderlying);
  if (mentor?.alertLevel === 'exit') {
    return {
      exit: true,
      reasonCode: mentor.reasonCode,
      title: mentor.title,
      reason: mentor.reason,
      rMultiple: mentor.rMultiple
    };
  }

  if (target == null && rMultiple >= 1.5) {
    return {
      exit: true,
      reasonCode: 'RESEARCH_1_5R_EXIT',
      title: 'RESEARCH PROFIT EXIT',
      reason: 'No structural target was available, so the standard research runner was closed at +1.5R.',
      rMultiple
    };
  }

  const heldMinutes = Math.max(0, (Date.now() - new Date(position.openedAt).getTime()) / 60000);
  if (heldMinutes >= MAX_HOLD_MINUTES) {
    return {
      exit: true,
      reasonCode: 'RESEARCH_TIME_EXIT',
      title: 'TIME EXIT',
      reason: `The research position reached the ${MAX_HOLD_MINUTES}-minute intraday time limit.`,
      rMultiple
    };
  }

  const currentSession = snapshot?.market?.sessionDate;
  const entrySession = position?.entryMarket?.sessionDate;
  if ((entrySession && currentSession && entrySession !== currentSession) || snapshot?.market?.phase === 'CLOSED') {
    return {
      exit: true,
      reasonCode: 'SESSION_EXIT',
      title: 'SESSION EXIT',
      reason: 'The regular trading session ended; shadow research positions are intraday only.',
      rMultiple
    };
  }

  return { exit: false, rMultiple };
}

function closeShadowPosition(position, snapshot, decision) {
  const optionExit = Number.isFinite(Number(position.currentPrice)) ? Number(position.currentPrice) : Number(position.entry);
  const underlyingExit = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
  const pnl = (optionExit - Number(position.entry)) * Number(position.quantity || 0);
  const riskPoints = Math.max(0.01, Math.abs(Number(position.underlyingEntry) - Number(position.underlyingStop)));
  const movePoints = position.side === 'CE'
    ? underlyingExit - Number(position.underlyingEntry)
    : Number(position.underlyingEntry) - underlyingExit;
  const rAchieved = movePoints / riskPoints;
  const closedAt = new Date().toISOString();
  const heldMinutes = Math.max(0, Math.round((Date.now() - new Date(position.openedAt).getTime()) / 60000));
  const exitClass = classifyShadowEntry(snapshot, readJson(SETTINGS_KEY, {}));

  return {
    ...position,
    exit: optionExit,
    underlyingExit,
    pnl,
    rAchieved,
    heldMinutes,
    closedAt,
    closedBy: 'SHADOW_RESEARCH',
    exitReasonCode: decision.reasonCode,
    exitReason: decision.reason,
    exitMentorState: decision.title,
    mentorSuggestionAtExit: snapshot?.decision?.headline || '',
    exitMandatoryPassCount: exitClass.mandatoryPassCount,
    exitConfirmationPassCount: exitClass.confirmationPassCount,
    exitSnapshot: snapshot ? {
      market: { ...snapshot.market },
      decision: { ...snapshot.decision },
      parameters: snapshot.parameters,
      structure: { ...snapshot.structure },
      setup: { ...snapshot.setup }
    } : null
  };
}

function updateResearchMetrics(position, snapshot) {
  const currentUnderlying = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
  if (!Number.isFinite(currentUnderlying)) return position;
  const risk = Math.max(0.01, Math.abs(Number(position.underlyingEntry) - Number(position.underlyingStop)));
  const move = position.side === 'CE'
    ? currentUnderlying - Number(position.underlyingEntry)
    : Number(position.underlyingEntry) - currentUnderlying;
  const currentR = move / risk;
  return {
    ...position,
    currentR,
    bestR: Math.max(Number(position.bestR) || 0, currentR),
    worstR: Math.min(Number(position.worstR) || 0, currentR),
    oneRReached: Boolean(position.oneRReached || currentR >= 1),
    currentScore: snapshot?.decision?.score,
    lastMentorAt: snapshot?.generatedAt
  };
}

function updateLive(position, optionPrice, underlying) {
  const next = updateUnderlying(position, underlying);
  if (!Number.isFinite(Number(optionPrice)) || Number(optionPrice) <= 0) return next;
  const price = Number(optionPrice);
  return {
    ...next,
    currentPrice: price,
    bestOptionPrice: Math.max(Number(position.bestOptionPrice) || Number(position.entry), price),
    worstOptionPrice: Math.min(Number(position.worstOptionPrice) || Number(position.entry), price)
  };
}

function updateUnderlying(position, underlying) {
  if (!Number.isFinite(Number(underlying))) return position;
  return { ...position, underlyingCurrent: Number(underlying) };
}

function appendHistory(closed) {
  const history = readJson(HISTORY_KEY, []);
  const map = new Map(history.filter(row => row?.id).map(row => [row.id, row]));
  for (const trade of closed) map.set(trade.id, trade);
  const merged = [...map.values()]
    .sort((a, b) => new Date(b.closedAt || b.openedAt || 0).getTime() - new Date(a.closedAt || a.openedAt || 0).getTime())
    .slice(0, 1000);
  writeJson(HISTORY_KEY, merged);
  try {
    window.dispatchEvent(new CustomEvent('mentor:journal-history', { detail: { history: merged } }));
  } catch {}
}

function publishStatus(active, opened, closed) {
  try {
    window.dispatchEvent(new CustomEvent('mentor:shadow-research', {
      detail: {
        active,
        opened,
        closed,
        activeCount: active.length,
        updatedAt: new Date().toISOString()
      }
    }));
  } catch {}
}

function pruneLedger(ledger) {
  const rows = Object.entries(ledger);
  if (rows.length <= MAX_LEDGER) return;
  rows
    .sort((a, b) => String(a[1]?.openedAt || '').localeCompare(String(b[1]?.openedAt || '')))
    .slice(0, rows.length - MAX_LEDGER)
    .forEach(([key]) => delete ledger[key]);
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || min);
  return Math.max(min, Math.min(max, n));
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function readJson(key, fallback) { return readTradingJson(key, fallback); }

function writeJson(key, value) { writeTradingJson(key, value); }


