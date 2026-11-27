import { derivePositionMentor } from './positionMentor.js';
import { missedCloseExit, missedCloseFields, researchCloseTiming, researchEntryOpen } from './researchHours.js';

const HARD_SAFETY_IDS = ['risk', 'liquidity'];
const MIN_RESEARCH_SCORE = 72;

export function classifyShadowResearchEntry(snapshot) {
  const parameters = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const mandatory = parameters.filter(row => row?.mandatory);
  const confirmations = parameters.filter(row => !row?.mandatory);
  const mandatoryPassCount = mandatory.filter(row => row?.gatePassed === true).length;
  const confirmationPassCount = confirmations.filter(row => row?.status === 'green').length;
  const hardSafetyPassed = HARD_SAFETY_IDS.every(id => parameters.find(row => row?.id === id)?.gatePassed === true);
  const score = Number(snapshot?.decision?.score);
  const rr = Number(snapshot?.decision?.rr);
  const live = snapshot?.live === true && snapshot?.market?.phase === 'LIVE';
  const hasAllChecks = parameters.length >= 13;
  const hasDirection = snapshot?.decision?.side === 'CE' || snapshot?.decision?.side === 'PE';
  const hasOption = Boolean(snapshot?.option?.symbol && Number(snapshot?.option?.lotSize) > 0 && Number(snapshot?.option?.ltp) > 0);
  const hasStructure = Number.isFinite(Number(snapshot?.structure?.underlyingStop)) && Number(snapshot?.structure?.riskPoints) > 0;
  const closeConfirmed = snapshot?.structure?.closeConfirmed === true;
  const retestFailed = snapshot?.structure?.retestFailed === true || snapshot?.setup?.retestStatus === 'FAILED';
  const setupId = snapshot?.setup?.setupId || '';

  // 72 is already the Mentor's WATCH / CAUTION floor. Shadow research therefore
  // broadens data collection without inventing a new strategy threshold.
  const eligible = Boolean(
    live &&
    setupId &&
    hasAllChecks &&
    hasDirection &&
    hasOption &&
    hasStructure &&
    hardSafetyPassed &&
    closeConfirmed &&
    !retestFailed &&
    mandatoryPassCount >= 3 &&
    Number.isFinite(score) &&
    score >= MIN_RESEARCH_SCORE
  );

  const cohort = mandatoryPassCount >= 5
    ? 'SHADOW_5_OF_5'
    : mandatoryPassCount === 4
      ? 'SHADOW_4_OF_5'
      : mandatoryPassCount === 3
        ? 'SHADOW_3_OF_5'
        : null;

  return {
    eligible,
    cohort: eligible ? cohort : null,
    setupId,
    key: setupId && hasDirection ? `${snapshot.market?.sessionDate || 'session'}:${setupId}:${snapshot.decision.side}` : '',
    score,
    rr,
    rrBand: Number.isFinite(rr) ? (rr >= 1 ? 'RR_1_OR_BETTER' : 'RR_BELOW_1') : 'RR_UNAVAILABLE',
    mandatoryPassCount,
    confirmationPassCount,
    failedMandatoryIds: mandatory.filter(row => row?.gatePassed === false).map(row => row.id),
    hardSafetyPassed,
    closeConfirmed,
    retestStatus: snapshot?.setup?.retestStatus || (snapshot?.structure?.retestFailed ? 'FAILED' : 'PENDING'),
    mentorApproved: snapshot?.decision?.canSuggestTrade === true,
    reason: eligible
      ? `${mandatoryPassCount}/5 mandatory gates, ${confirmationPassCount}/8 green confirmations, score ${Math.round(score)}. Shadow research only.`
      : buildBlockedReason({ live, setupId, hasAllChecks, hasDirection, hasOption, hasStructure, hardSafetyPassed, closeConfirmed, retestFailed, mandatoryPassCount, score })
  };
}

export function buildShadowResearchTrade(snapshot, classification = classifyShadowResearchEntry(snapshot)) {
  if (!classification?.eligible) return null;

  const now = snapshot?.generatedAt || new Date().toISOString();
  if (!researchEntryOpen(now)) return null;
  const market = snapshot.market || {};
  const structure = snapshot.structure || {};
  const option = snapshot.option || {};
  const decision = snapshot.decision || {};
  const id = `shadow:${classification.key}`;

  return {
    id,
    mode: 'SHADOW_RESEARCH',
    researchOnly: true,
    shadowResearch: true,
    status: 'OPEN',
    setupId: classification.setupId,
    openedAt: now,
    initiatedBy: 'RESEARCH_ENGINE',
    strategyTier: classification.cohort,
    strategyTierLabel: labelForCohort(classification.cohort),
    shadowCohort: classification.cohort,
    approvalState: decision.state || '',
    mentorDecisionAtEntry: decision.state || '',
    mentorSuggestionAtEntry: decision.headline || '',
    mentorApprovedAtEntry: classification.mentorApproved,
    score: decision.score,
    rr: decision.rr,
    rrBand: classification.rrBand,
    side: option.optionType || decision.side,
    symbol: option.symbol,
    strike: option.strike,
    expiry: option.expiry,
    lotSize: Number(option.lotSize) || 0,
    lots: 1,
    quantity: Number(option.lotSize) || 0,
    entry: Number(option.ltp),
    currentPrice: Number(option.ltp),
    underlyingEntry: Number(market.spot),
    underlyingCurrent: Number(market.spot),
    underlyingStop: Number(structure.underlyingStop),
    underlyingTarget: finiteOrNull(structure.underlyingTarget),
    currentR: 0,
    bestR: 0,
    worstR: 0,
    bestOptionPrice: Number(option.ltp),
    worstOptionPrice: Number(option.ltp),
    oneRReached: false,
    entryMandatoryPassCount: classification.mandatoryPassCount,
    entryConfirmationPassCount: classification.confirmationPassCount,
    failedMandatoryIds: classification.failedMandatoryIds,
    retestStatusAtEntry: classification.retestStatus,
    closeConfirmedAtEntry: classification.closeConfirmed,
    hardSafetyPassedAtEntry: classification.hardSafetyPassed,
    parameterSnapshot: snapshot.parameters,
    reasons: decision.reasons || [],
    entryMarket: {
      sessionDate: market.sessionDate,
      spot: market.spot,
      vwap: market.vwap,
      orh: market.orh,
      orl: market.orl,
      pdh: market.pdh,
      pdl: market.pdl,
      vix: market.vix,
      putCallOiRatio: market.putCallOiRatio,
      atr5: market.atr5
    },
    entryStructure: { ...structure },
    entryDecision: { ...decision },
    entryOption: { ...option },
    entrySnapshot: {
      market: { ...market },
      structure: { ...structure },
      decision: { ...decision },
      option: { ...option },
      parameters: snapshot.parameters
    }
  };
}

export function advanceShadowResearchTrade(trade, snapshot) {
  if (!trade || trade.status !== 'OPEN' || !snapshot?.market) return { trade, exit: null };

  // Checked first, so a later price never moves this trade's stop, target or best/worst figures.
  const timing = researchCloseTiming(trade.openedAt, snapshot.generatedAt || new Date().toISOString());
  if (timing === 'missed') return { trade, exit: missedCloseExit() };

  const currentUnderlying = Number(snapshot.market.spot);
  if (!Number.isFinite(currentUnderlying)) return { trade, exit: null };

  const riskPoints = Math.max(0.01, Math.abs(Number(trade.underlyingEntry) - Number(trade.underlyingStop)));
  const movePoints = trade.side === 'CE'
    ? currentUnderlying - Number(trade.underlyingEntry)
    : Number(trade.underlyingEntry) - currentUnderlying;
  const currentR = movePoints / riskPoints;
  const bestR = Math.max(Number.isFinite(Number(trade.bestR)) ? Number(trade.bestR) : currentR, currentR);
  const worstR = Math.min(Number.isFinite(Number(trade.worstR)) ? Number(trade.worstR) : currentR, currentR);
  const sameOption = snapshot?.option?.symbol === trade.symbol;
  const currentPrice = sameOption && Number(snapshot?.option?.ltp) > 0 ? Number(snapshot.option.ltp) : trade.currentPrice;
  const bestOptionPrice = Number.isFinite(Number(currentPrice))
    ? Math.max(Number(trade.bestOptionPrice || trade.entry || currentPrice), Number(currentPrice))
    : trade.bestOptionPrice;
  const worstOptionPrice = Number.isFinite(Number(currentPrice))
    ? Math.min(Number(trade.worstOptionPrice || trade.entry || currentPrice), Number(currentPrice))
    : trade.worstOptionPrice;

  const updated = {
    ...trade,
    underlyingCurrent: currentUnderlying,
    currentPrice,
    currentR,
    bestR,
    worstR,
    bestOptionPrice,
    worstOptionPrice,
    oneRReached: Boolean(trade.oneRReached || bestR >= 1),
    currentScore: snapshot?.decision?.score,
    lastMentorAt: snapshot?.generatedAt || new Date().toISOString()
  };

  if (timing === 'close') {
    return {
      trade: updated,
      exit: { reasonCode: 'SESSION_END', title: 'SESSION EXIT', reason: 'Research trades are closed from 3:18 PM.', rMultiple: currentR }
    };
  }

  if (targetReached(updated, currentUnderlying)) {
    return {
      trade: updated,
      exit: {
        reasonCode: 'STRUCTURAL_TARGET_REACHED',
        title: 'TARGET REACHED',
        reason: `NIFTY reached the planned structural target at ${formatNumber(updated.underlyingTarget)}.`,
        rMultiple: currentR
      }
    };
  }

  const mentor = derivePositionMentor(updated, snapshot, currentUnderlying);
  if (mentor?.alertLevel === 'exit') {
    return {
      trade: updated,
      exit: {
        reasonCode: mentor.reasonCode,
        title: mentor.title,
        reason: mentor.reason,
        rMultiple: mentor.rMultiple
      }
    };
  }

  if (sessionEnded(updated, snapshot)) {
    return {
      trade: updated,
      exit: {
        reasonCode: 'SESSION_END',
        title: 'SESSION EXIT',
        reason: 'The intraday research session has ended, so the shadow position is closed rather than carried overnight.',
        rMultiple: currentR
      }
    };
  }

  return { trade: updated, exit: null };
}

export function closeShadowResearchTrade(trade, snapshot, exitMeta, optionExit = null) {
  const closedAt = snapshot?.generatedAt || new Date().toISOString();
  const underlyingExit = Number(trade?.underlyingCurrent ?? snapshot?.market?.spot);
  const exitOption = Number.isFinite(Number(optionExit)) && Number(optionExit) > 0 ? Number(optionExit) : finiteOrNull(trade?.currentPrice);
  const entryOption = Number(trade?.entry);
  const quantity = Number(trade?.quantity) || 0;
  const pnl = Number.isFinite(entryOption) && Number.isFinite(exitOption) ? (exitOption - entryOption) * quantity : null;
  const heldMinutes = Math.max(0, Math.round((new Date(closedAt).getTime() - new Date(trade.openedAt).getTime()) / 60000));

  return {
    ...trade,
    status: 'CLOSED',
    exit: exitOption,
    underlyingExit,
    pnl,
    rAchieved: Number.isFinite(Number(exitMeta?.rMultiple)) ? Number(exitMeta.rMultiple) : trade.currentR,
    heldMinutes,
    closedAt,
    ...(exitMeta?.reasonCode === 'MISSED_CLOSE' ? missedCloseFields(trade) : {}),
    closedBy: 'RESEARCH_ENGINE',
    exitReasonCode: exitMeta?.reasonCode || 'RESEARCH_EXIT',
    exitReason: exitMeta?.reason || 'Shadow research exit.',
    exitMentorState: exitMeta?.title || 'RESEARCH EXIT',
    mentorSuggestionAtExit: snapshot?.decision?.headline || '',
    exitSnapshot: snapshot ? {
      market: { ...snapshot.market },
      decision: { ...snapshot.decision },
      parameters: snapshot.parameters,
      structure: { ...snapshot.structure },
      setup: { ...snapshot.setup }
    } : null
  };
}

function targetReached(trade, currentUnderlying) {
  const target = Number(trade?.underlyingTarget);
  if (!Number.isFinite(target)) return false;
  return trade.side === 'CE' ? currentUnderlying >= target : currentUnderlying <= target;
}

function sessionEnded(trade, snapshot) {
  const entrySession = trade?.entryMarket?.sessionDate;
  const currentSession = snapshot?.market?.sessionDate;
  if (entrySession && currentSession && entrySession !== currentSession) return true;
  const phase = String(snapshot?.market?.phase || '').toUpperCase();
  return phase === 'CLOSED' || phase === 'POST_MARKET' || phase === 'AFTER_HOURS';
}

function buildBlockedReason({ live, setupId, hasAllChecks, hasDirection, hasOption, hasStructure, hardSafetyPassed, closeConfirmed, retestFailed, mandatoryPassCount, score }) {
  if (!live) return 'Regular live session is required.';
  if (!setupId) return 'No active setup ID.';
  if (!hasAllChecks) return 'All 13 checks are not available yet.';
  if (!hasDirection) return 'No CE/PE direction exists.';
  if (!hasOption) return 'No valid candidate option is available.';
  if (!hasStructure) return 'No measurable structural invalidation exists.';
  if (!hardSafetyPassed) return 'Risk or liquidity safety failed.';
  if (!closeConfirmed) return 'The completed 5-minute close is not confirmed.';
  if (retestFailed) return 'The setup retest has explicitly failed.';
  if (mandatoryPassCount < 3) return 'Fewer than three mandatory gates passed.';
  if (!Number.isFinite(score) || score < MIN_RESEARCH_SCORE) return `Confluence is below the existing ${MIN_RESEARCH_SCORE} watch threshold.`;
  return 'Shadow research entry is not eligible.';
}

function labelForCohort(cohort) {
  if (cohort === 'SHADOW_5_OF_5') return '5/5 shadow research';
  if (cohort === 'SHADOW_4_OF_5') return '4/5 shadow research';
  if (cohort === 'SHADOW_3_OF_5') return '3/5 shadow research';
  return 'Shadow research';
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
