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


export function deriveScalpPositionMentor(position, snapshot, currentUnderlying) {
  const entry = Number(position?.underlyingEntry);
  const stop = Number(position?.underlyingStop);
  const target = Number(position?.underlyingTarget);
  const current = Number(currentUnderlying);
  const riskPoints = Math.max(0.01, Math.abs(entry - stop));
  const movePoints = position?.side === 'CE' ? current - entry : entry - current;
  const rMultiple = movePoints / riskPoints;
  const bestR = Math.max(Number.isFinite(Number(position?.bestR)) ? Number(position.bestR) : rMultiple, rMultiple);
  const worstR = Math.min(Number.isFinite(Number(position?.worstR)) ? Number(position.worstR) : rMultiple, rMultiple);
  const givebackR = Math.max(0, bestR - rMultiple);
  const currentScore = Number(position?.scalpScoreAtEntry ?? position?.score ?? 0);

  const stopHit = position?.side === 'CE' ? current <= stop : current >= stop;
  const targetHit = Number.isFinite(target) && (position?.side === 'CE' ? current >= target : current <= target);
  const heldMinutes = Math.max(0, (Date.now() - new Date(position?.openedAt || 0).getTime()) / 60000);
  const maxHoldMinutes = Math.max(1, Number(position?.scalpMaxHoldMinutes) || 12);

  const currentBias = snapshot?.decision?.side || null;
  const oppositeBias = Boolean(currentBias && currentBias !== position?.side);
  const vwap = Number(snapshot?.market?.vwap);
  const vwapInvalid = Number.isFinite(vwap) && (
    position?.side === 'CE' ? current < vwap : current > vwap
  );

  if (stopHit) {
    return scalpState('SCALP EXIT', 'HARD EXIT', 'stop', 'exit', 'SCALP_STOP', `NIFTY reached the scalp invalidation at ${fmt(stop)}.`, 'The 3-minute scalp thesis is invalid. Close the simulated scalp; do not widen the stop.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if (targetHit || rMultiple >= 1) {
    return scalpState('SCALP TARGET HIT', 'TAKE PROFIT', 'go', 'exit', 'SCALP_TARGET', `The scalp reached the +1.00R objective near ${fmt(target)}.`, 'Scalp objective achieved. Close the simulated position rather than converting a quick trade into a longer hold.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if (heldMinutes >= maxHoldMinutes) {
    return scalpState('SCALP TIME EXIT', 'TIME EXIT', 'wait', 'exit', 'SCALP_TIME_EXIT', `The position has been open for ${Math.floor(heldMinutes)} minutes; the scalp time limit is ${maxHoldMinutes} minutes.`, 'The fast setup did not resolve quickly enough. Close the simulation and wait for a fresh scalp.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if ((oppositeBias && rMultiple <= 0) || (vwapInvalid && rMultiple <= -0.15)) {
    return scalpState('SCALP MOMENTUM LOST', 'EXIT EARLY', 'stop', 'exit', 'SCALP_CONTEXT_EXIT', oppositeBias ? `The 5-minute context has flipped to ${currentBias} while this scalp is not profitable.` : 'Price moved through VWAP against the scalp while the trade is losing.', 'For a scalp, failed context is an exit signal. Do not wait for a wider swing-trade recovery.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if (bestR >= 0.65 && rMultiple <= 0.20 && givebackR >= 0.45) {
    return scalpState('PROTECT SCALP', 'PROTECT', 'protect', 'exit', 'SCALP_PROFIT_PROTECT', `The scalp reached ${formatR(bestR)} and has given back ${givebackR.toFixed(2)}R.`, 'A quick winner has lost most of its edge. Bank the research result instead of allowing the scalp to round-trip.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if (rMultiple >= 0.60) {
    return scalpState('SCALP WORKING', 'HOLD TO 1R', 'go', 'none', 'SCALP_APPROACH_TARGET', `The scalp is ${formatR(rMultiple)} and approaching the +1R objective.`, 'Keep the original stop and target. This is a short-duration trade; do not add to it.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  if (rMultiple <= -0.40 || vwapInvalid || oppositeBias) {
    return scalpState('SCALP CAUTION', 'CAUTION', 'wait', 'caution', 'SCALP_WEAKENING', vwapInvalid ? 'Price is testing the wrong side of VWAP for the scalp.' : oppositeBias ? `The broader context currently points ${currentBias}.` : `The scalp is ${formatR(rMultiple)} against entry.`, 'Do not add. The scalp still has its hard stop, but the fast edge is weakening.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
  }

  return scalpState('SCALP ACTIVE', 'HOLD', 'hold', 'none', 'SCALP_HOLD', `The scalp remains inside its plan at ${formatR(rMultiple)}.`, 'Hold only while the tight 3-minute invalidation and short time window remain intact.', { rMultiple, bestR, worstR, givebackR, currentScore, oppositeBias });
}

function scalpState(title, shortTitle, tone, alertLevel, reasonCode, reason, copy, metrics) {
  return {
    title,
    shortTitle,
    tone,
    alertLevel,
    reasonCode,
    reason,
    copy,
    rMultiple: metrics.rMultiple,
    bestR: metrics.bestR,
    worstR: metrics.worstR,
    givebackR: metrics.givebackR,
    oneRReached: metrics.bestR >= 1,
    currentScore: metrics.currentScore,
    scoreDrop: 0,
    oppositeBias: metrics.oppositeBias,
    coreGateFails: 0
  };
}
