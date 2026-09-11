const HARD_GATE_IDS = new Set(['risk', 'liquidity']);
const QUALITY_GATE_IDS = new Set(['chop', 'trend', 'vwap']);

export function classifyResearchSetup(snapshot) {
  const parameters = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const mandatory = parameters.filter(row => row.mandatory);
  const confirmations = parameters.filter(row => !row.mandatory);
  const failedMandatory = mandatory.filter(row => row.gatePassed === false);
  const mandatoryPassCount = mandatory.length - failedMandatory.length;
  const confirmationPassCount = confirmations.filter(row => row.status === 'green').length;
  const hardSafetyPassed = [...HARD_GATE_IDS].every(id => parameters.find(row => row.id === id)?.gatePassed === true);
  const onlyQualityFailures = failedMandatory.every(row => QUALITY_GATE_IDS.has(row.id));
  const score = Number(snapshot?.decision?.score);
  const rr = Number(snapshot?.decision?.rr);
  const retestHeld = snapshot?.setup?.retestStatus === 'HELD' && snapshot?.structure?.retestFailed !== true;
  const closeConfirmed = snapshot?.structure?.closeConfirmed === true;
  const live = snapshot?.live === true && snapshot?.market?.phase === 'LIVE';
  const hasOption = Boolean(snapshot?.option?.symbol && Number(snapshot?.option?.lotSize) > 0);
  const hasStructure = Number.isFinite(Number(snapshot?.structure?.underlyingStop)) && Number.isFinite(Number(snapshot?.structure?.riskPoints)) && Number(snapshot?.structure?.riskPoints) > 0;
  const baseSafety = live && hasOption && hasStructure && closeConfirmed && retestHeld && hardSafetyPassed && Number.isFinite(score) && score >= 80 && Number.isFinite(rr) && rr >= 1;

  let tier = null;
  if (baseSafety && mandatoryPassCount === 5 && snapshot?.decision?.canSuggestTrade === true) {
    tier = 'FULL';
  } else if (baseSafety && mandatoryPassCount === 4 && confirmationPassCount >= 7 && onlyQualityFailures) {
    tier = 'CONTROLLED';
  } else if (baseSafety && mandatoryPassCount === 3 && confirmationPassCount >= 6 && onlyQualityFailures) {
    tier = 'EXPERIMENTAL';
  }

  const setupId = snapshot?.setup?.setupId || [
    snapshot?.market?.sessionDate || 'session',
    snapshot?.decision?.side || 'none',
    snapshot?.setup?.breakoutTime || 'breakout',
    snapshot?.setup?.retestTime || 'retest'
  ].join(':');

  return {
    eligible: Boolean(tier),
    tier,
    setupId,
    score,
    rr,
    mandatoryPassCount,
    confirmationPassCount,
    failedMandatoryIds: failedMandatory.map(row => row.id),
    hardSafetyPassed,
    onlyQualityFailures,
    retestHeld,
    closeConfirmed,
    live,
    label: tier === 'FULL'
      ? 'Full approval'
      : tier === 'CONTROLLED'
        ? 'Controlled research'
        : tier === 'EXPERIMENTAL'
          ? 'Experimental research'
          : 'No research position',
    reason: buildReason({ tier, mandatoryPassCount, confirmationPassCount, failedMandatory, hardSafetyPassed, retestHeld, closeConfirmed, score, rr })
  };
}

export function calculateSimulationSizing(snapshot, settings) {
  const option = snapshot?.option || {};
  const lots = clampInt(settings?.defaultLots, 1, Math.max(1, Number(settings?.lotCap) || 20));
  const contractLotSize = Number(option.lotSize) || 0;
  const optionEntry = Number(option.ltp) || 0;
  const optionStop = Number(option.estimatedPremiumStop) || optionEntry;
  const optionRiskPerUnit = Math.max(0, optionEntry - optionStop);
  const riskPerLot = optionRiskPerUnit * contractLotSize;
  const requiredRiskAmount = riskPerLot * lots;
  const capital = Math.max(0, Number(settings?.capital) || 0);
  const riskPct = Math.max(0, Number(settings?.riskPct) || 0);
  const riskBudget = capital * (riskPct / 100);
  const requiredRiskPct = capital > 0 ? (requiredRiskAmount / capital) * 100 : 0;

  return {
    lots,
    contractLotSize,
    quantity: lots * contractLotSize,
    optionRiskPerUnit,
    riskPerLot,
    requiredRiskAmount,
    requiredRiskPct,
    riskBudget,
    riskBudgetEligible: riskBudget > 0 && requiredRiskAmount <= riskBudget
  };
}

export function buildSimulatedTicket(snapshot, settings, initiatedBy = 'USER') {
  const classification = classifyResearchSetup(snapshot);
  if (!classification.eligible) return null;
  const sizing = calculateSimulationSizing(snapshot, settings);
  const { market, option, structure, decision } = snapshot;
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    mode: 'SIMULATION',
    setupId: classification.setupId,
    openedAt: now,
    initiatedBy,
    strategyTier: classification.tier,
    strategyTierLabel: classification.label,
    autoManaged: true,
    approvalState: decision.state,
    mentorDecisionAtEntry: decision.state,
    mentorSuggestionAtEntry: `${decision.headline || classification.label}${Array.isArray(decision.reasons) && decision.reasons.length ? ` — ${decision.reasons.join(' | ')}` : ''}`,
    score: decision.score,
    rr: decision.rr,
    side: option.optionType,
    symbol: option.symbol,
    strike: option.strike,
    expiry: option.expiry,
    lotSize: option.lotSize,
    lots: sizing.lots,
    quantity: sizing.quantity,
    entry: option.ltp,
    currentPrice: option.ltp,
    underlyingEntry: market.spot,
    underlyingCurrent: market.spot,
    underlyingStop: structure.underlyingStop,
    underlyingTarget: structure.underlyingTarget,
    currentR: 0,
    bestR: 0,
    worstR: 0,
    bestOptionPrice: option.ltp,
    worstOptionPrice: option.ltp,
    oneRReached: false,
    entryMandatoryPassCount: classification.mandatoryPassCount,
    entryConfirmationPassCount: classification.confirmationPassCount,
    failedMandatoryIds: classification.failedMandatoryIds,
    riskBudgetEligible: sizing.riskBudgetEligible,
    requiredRiskAmount: sizing.requiredRiskAmount,
    requiredRiskPct: sizing.requiredRiskPct,
    riskBudget: sizing.riskBudget,
    settingsSnapshot: {
      capital: Number(settings?.capital) || 0,
      riskPct: Number(settings?.riskPct) || 0,
      defaultLots: sizing.lots,
      lotCap: Number(settings?.lotCap) || sizing.lots,
      mentorAutoOpen: Boolean(settings?.mentorAutoOpen),
      mentorAutoClose: Boolean(settings?.mentorAutoClose),
      controlledResearch: Boolean(settings?.controlledResearch),
      experimentalResearch: Boolean(settings?.experimentalResearch)
    },
    parameterSnapshot: snapshot.parameters,
    reasons: decision.reasons,
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
    openedByMentor: initiatedBy === 'MENTOR'
  };
}

export function tierEnabled(classification, settings) {
  if (!classification?.eligible) return false;
  if (classification.tier === 'FULL') return true;
  if (classification.tier === 'CONTROLLED') return settings?.controlledResearch !== false;
  if (classification.tier === 'EXPERIMENTAL') return settings?.experimentalResearch === true;
  return false;
}

function buildReason({ tier, mandatoryPassCount, confirmationPassCount, failedMandatory, hardSafetyPassed, retestHeld, closeConfirmed, score, rr }) {
  if (tier === 'FULL') return `5/5 mandatory gates passed with score ${Math.round(score)} and the full strategy approved the setup.`;
  if (tier === 'CONTROLLED') return `4/5 mandatory gates and ${confirmationPassCount}/8 confirmations passed; only a quality gate is missing, so this is tracked as controlled research.`;
  if (tier === 'EXPERIMENTAL') return `3/5 mandatory gates and ${confirmationPassCount}/8 confirmations passed while hard safety gates remain intact; this is research only.`;
  if (!hardSafetyPassed) return 'A non-negotiable safety gate failed. No automated research position is allowed.';
  if (!closeConfirmed) return 'The completed 5-minute close is not confirmed.';
  if (!retestHeld) return 'The retest has not held.';
  if (!Number.isFinite(score) || score < 80) return 'Confluence is below 80.';
  if (!Number.isFinite(rr) || rr < 1) return 'Reward-to-risk is below 1:1.';
  if (mandatoryPassCount < 3) return 'Fewer than three mandatory gates passed.';
  if (failedMandatory.some(row => HARD_GATE_IDS.has(row.id))) return 'A hard safety gate failed.';
  return 'The setup does not meet the current automated research cohort rules.';
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value) || min);
  return Math.max(min, Math.min(max, n));
}
