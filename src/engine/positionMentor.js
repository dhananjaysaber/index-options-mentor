export function derivePositionMentor(position, snapshot, currentUnderlying) {
  const riskPoints = Math.max(0.01, Math.abs(position.underlyingEntry - position.underlyingStop));
  const movePoints = position.side === 'CE'
    ? currentUnderlying - position.underlyingEntry
    : position.underlyingEntry - currentUnderlying;
  const rMultiple = movePoints / riskPoints;

  const plannedRR = Math.max(1, Number(position.rr || 1));
  const entryScore = Number(position.score ?? 0);
  const directionalSnapshotReady = Boolean(snapshot?.decision?.side);
  // When the live engine has no CE/PE bias, several directional checks are not
  // assessable. Do not treat their placeholder values as a real confluence crash.
  const currentScore = directionalSnapshotReady
    ? Number(snapshot?.decision?.score ?? entryScore)
    : entryScore;
  const scoreDrop = directionalSnapshotReady ? Math.max(0, entryScore - currentScore) : 0;

  const bestR = Math.max(Number.isFinite(Number(position.bestR)) ? Number(position.bestR) : rMultiple, rMultiple);
  const worstR = Math.min(Number.isFinite(Number(position.worstR)) ? Number(position.worstR) : rMultiple, rMultiple);
  const oneRReached = bestR >= 1;
  const givebackR = Math.max(0, bestR - rMultiple);

  const stopHit = position.side === 'CE'
    ? currentUnderlying <= position.underlyingStop
    : currentUnderlying >= position.underlyingStop;

  const currentBias = snapshot?.decision?.side || null;
  const oppositeBias = Boolean(currentBias && currentBias !== position.side);

  const params = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const regime = params.find(row => row.id === 'chop');
  const trend = directionalSnapshotReady ? params.find(row => row.id === 'trend') : null;
  const vwap = directionalSnapshotReady ? params.find(row => row.id === 'vwap') : null;
  const coreRows = [regime, trend, vwap].filter(Boolean);
  const coreGateFails = coreRows.filter(row => row.mandatory && !row.gatePassed).length;
  const coreRed = coreRows.filter(row => row.status === 'red').length;
  const trendVwapStrongOpposite = oppositeBias && trend?.gatePassed && vwap?.gatePassed;
  const runnerWeakening = oppositeBias || coreGateFails >= 1 || coreRed >= 1;

  if (stopHit) {
    return {
      title: 'EXIT TRADE',
      shortTitle: 'HARD EXIT',
      tone: 'stop',
      alertLevel: 'exit',
      reasonCode: 'STRUCTURE_INVALIDATED',
      reason: `NIFTY has reached the original structural invalidation at ${fmt(position.underlyingStop)}.`,
      copy: 'The original thesis is invalid. Exit the broker position and mirror the exit here. Do not widen the stop or average the losing option.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  // Strategy deterioration remains stricter than a simple score fall. Entry-only
  // checks such as ORB/retest can naturally weaken after entry, so an early exit
  // still needs fresh directional evidence.
  const strongDeterioration =
    (trendVwapStrongOpposite && rMultiple <= -0.15) ||
    (oppositeBias && scoreDrop >= 20 && rMultiple <= 0) ||
    (coreGateFails >= 2 && coreRed >= 2 && rMultiple <= -0.5);

  if (strongDeterioration) {
    return {
      title: 'EXIT RECOMMENDED',
      shortTitle: 'STRATEGY EXIT',
      tone: 'stop',
      alertLevel: 'exit',
      reasonCode: 'STRATEGY_DETERIORATION',
      reason: deteriorationReason({ oppositeBias, currentBias, coreGateFails, coreRed, scoreDrop, rMultiple }),
      copy: 'The hard stop has not necessarily been touched, but the live directional evidence has deteriorated enough to recommend an early exit.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  // Once +1R has been genuinely achieved it becomes a milestone, not an automatic
  // exit. Protect the runner only after a meaningful give-back AND weakening live
  // evidence, so a normal +1.08R -> +0.98R fluctuation does not force an exit.
  const profitProtectionExit =
    oneRReached &&
    bestR >= 1.1 &&
    rMultiple <= 0.8 &&
    givebackR >= 0.3 &&
    runnerWeakening;

  if (profitProtectionExit) {
    return {
      title: 'EXIT — PROTECT PROFIT',
      shortTitle: 'PROFIT EXIT',
      tone: 'stop',
      alertLevel: 'exit',
      reasonCode: 'PROFIT_PROTECTION_EXIT',
      reason: `The runner reached ${formatR(bestR)}, has given back ${givebackR.toFixed(2)}R, and live structure is weakening.`,
      copy: 'The 1R milestone was achieved, but enough of the move has now been surrendered alongside weakening evidence. Protect the winner rather than allowing it to turn into a failed trade.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  if (oneRReached) {
    if (rMultiple < 1) {
      return {
        title: '1R ACHIEVED — PROTECT WINNER',
        shortTitle: 'PROTECT',
        tone: 'protect',
        alertLevel: 'caution',
        reasonCode: 'RUNNER_PULLBACK',
        reason: `The trade previously reached ${formatR(bestR)} and is now ${formatR(rMultiple)}. The original hard structure is still intact.`,
        copy: 'Do not exit only because price slipped back below 1R. Hold while structure remains valid, but treat this as a profit-protection warning and do not add to the position.',
        rMultiple,
        bestR,
        worstR,
        givebackR,
        oneRReached,
        currentScore,
        scoreDrop,
        oppositeBias,
        coreGateFails
      };
    }

    return {
      title: '1R+ ACHIEVED — HOLD RUNNER',
      shortTitle: 'HOLD RUNNER',
      tone: 'go',
      alertLevel: 'none',
      reasonCode: 'RUNNER_HOLD',
      reason: `The trade is ${formatR(rMultiple)} with a best move of ${formatR(bestR)} and the original structure remains intact.`,
      copy: 'The planned 1:1 reward is now a milestone, not an automatic exit. Continue to hold the runner while structure and directional evidence remain healthy.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  const approachingOneR = rMultiple >= 0.8;
  if (approachingOneR) {
    return {
      title: 'APPROACHING 1R — HOLD',
      shortTitle: 'HOLD',
      tone: 'go',
      alertLevel: 'none',
      reasonCode: 'APPROACHING_ONE_R',
      reason: `The trade is ${formatR(rMultiple)} and is approaching the first +1R milestone.`,
      copy: 'Stay with the original structure. Do not front-run the milestone just because the option premium fluctuates.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  const caution =
    rMultiple <= -0.5 ||
    oppositeBias ||
    coreGateFails >= 1 ||
    coreRed >= 1;

  if (caution) {
    return {
      title: 'CAUTION',
      shortTitle: 'CAUTION',
      tone: 'wait',
      alertLevel: 'caution',
      reasonCode: 'STRUCTURE_WEAKENING',
      reason: cautionReason({ oppositeBias, currentBias, coreGateFails, coreRed, scoreDrop, rMultiple }),
      copy: 'Do not add to the position. Keep the original stop fixed and watch whether the evidence recovers or deteriorates into an exit condition.',
      rMultiple,
      bestR,
      worstR,
      givebackR,
      oneRReached,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  return {
    title: 'HOLD — STRUCTURE INTACT',
    shortTitle: 'HOLD',
    tone: 'hold',
    alertLevel: 'none',
    reasonCode: 'STRUCTURE_INTACT',
    reason: `NIFTY remains above the original risk thesis with no strong opposite-direction deterioration. Current move: ${formatR(rMultiple)}.`,
    copy: 'Normal pullbacks are allowed inside the plan. Do not exit simply because one candle or the option premium fluctuates.',
    rMultiple,
    bestR,
    worstR,
    givebackR,
    oneRReached,
    currentScore,
    scoreDrop,
    oppositeBias,
    coreGateFails
  };
}

function deteriorationReason({ oppositeBias, currentBias, coreGateFails, coreRed, scoreDrop, rMultiple }) {
  const parts = [];
  if (oppositeBias) parts.push(`Live bias has flipped to ${currentBias}`);
  if (coreGateFails >= 2) parts.push(`${coreGateFails} core directional gates are now failing`);
  if (coreRed >= 2) parts.push(`${coreRed} core directional readings are red`);
  if (scoreDrop >= 15) parts.push(`confluence has fallen ${Math.round(scoreDrop)} points from entry`);
  if (rMultiple <= 0) parts.push(`the trade is ${formatR(rMultiple)}`);
  return `${parts.join('; ')}.`;
}

function cautionReason({ oppositeBias, currentBias, coreGateFails, coreRed, scoreDrop, rMultiple }) {
  if (oppositeBias) return `Live bias has shifted to ${currentBias}, opposite to the open position, but the early-exit evidence is not yet strong enough for EXIT RECOMMENDED.`;
  if (coreGateFails >= 1) return `${coreGateFails} core directional gate${coreGateFails > 1 ? 's are' : ' is'} currently failing while the hard structural stop remains intact.`;
  if (coreRed >= 1) return 'A core directional reading is red while the original hard stop remains intact.';
  if (rMultiple <= -0.5) return `The position is around ${formatR(rMultiple)} against the entry, but the original structural stop has not yet been invalidated.`;
  if (scoreDrop >= 15) return `Confluence is down ${Math.round(scoreDrop)} points from entry; this is a warning only because score deterioration alone is not an exit trigger.`;
  return 'The position is weakening, but the original thesis has not yet been invalidated.';
}

export function formatR(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}R`;
}

export function fmt(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
