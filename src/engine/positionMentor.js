export function derivePositionMentor(position, snapshot, currentUnderlying) {
  const riskPoints = Math.max(0.01, Math.abs(position.underlyingEntry - position.underlyingStop));
  const movePoints = position.side === 'CE'
    ? currentUnderlying - position.underlyingEntry
    : position.underlyingEntry - currentUnderlying;
  const rMultiple = movePoints / riskPoints;

  const plannedRR = Math.max(1, Number(position.rr || 1));
  const currentScore = Number(snapshot?.decision?.score ?? position.score ?? 0);
  const entryScore = Number(position.score ?? currentScore);
  const scoreDrop = Math.max(0, entryScore - currentScore);

  const stopHit = position.side === 'CE'
    ? currentUnderlying <= position.underlyingStop
    : currentUnderlying >= position.underlyingStop;
  const targetHit = position.side === 'CE'
    ? currentUnderlying >= position.underlyingTarget
    : currentUnderlying <= position.underlyingTarget;

  const targetZone = !targetHit && rMultiple >= Math.max(0.8, plannedRR - 0.2);

  const currentBias = snapshot?.decision?.side || null;
  const oppositeBias = Boolean(currentBias && currentBias !== position.side);

  const params = Array.isArray(snapshot?.parameters) ? snapshot.parameters : [];
  const regime = params.find(row => row.id === 'chop');
  const trend = params.find(row => row.id === 'trend');
  const vwap = params.find(row => row.id === 'vwap');
  const coreRows = [regime, trend, vwap].filter(Boolean);
  const coreGateFails = coreRows.filter(row => row.mandatory && !row.gatePassed).length;
  const coreRed = coreRows.filter(row => row.status === 'red').length;
  const trendVwapStrongOpposite = oppositeBias && trend?.gatePassed && vwap?.gatePassed;

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
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  // Strategy deterioration is intentionally stricter than a simple fall in the
  // 13-point score. Entry-only items such as ORB/retest can naturally weaken
  // after entry, so an early exit needs fresh directional evidence as well.
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
      copy: 'The trade has not necessarily touched the hard stop, but the live directional evidence has deteriorated enough to recommend an early exit.',
      rMultiple,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  if (targetHit) {
    return {
      title: 'TARGET REACHED',
      shortTitle: 'TARGET',
      tone: 'go',
      alertLevel: 'none',
      reasonCode: 'TARGET_REACHED',
      reason: `NIFTY has reached the planned target area around ${fmt(position.underlyingTarget)}.`,
      copy: 'The planned move has been delivered. Review the broker exit or a disciplined trail rather than giving the move back.',
      rMultiple,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  if (targetZone) {
    return {
      title: 'TARGET ZONE',
      shortTitle: 'TARGET ZONE',
      tone: 'go',
      alertLevel: 'none',
      reasonCode: 'TARGET_APPROACHING',
      reason: `The trade is ${formatR(rMultiple)} and is approaching the planned ${plannedRR.toFixed(1)}R target zone.`,
      copy: 'Prepare the exit plan. Avoid turning a strong winner into a small win by giving back the final part of the move.',
      rMultiple,
      currentScore,
      scoreDrop,
      oppositeBias,
      coreGateFails
    };
  }

  if (rMultiple >= 1) {
    return {
      title: 'PROTECT PROFIT',
      shortTitle: 'PROTECT',
      tone: 'protect',
      alertLevel: 'none',
      reasonCode: 'ONE_R_REACHED',
      reason: `The trade is approximately ${formatR(rMultiple)} in favour while the original structure remains intact.`,
      copy: 'Capital protection now matters more. Do not widen risk; continue to respect the original plan while watching the target.',
      rMultiple,
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
    reason: `NIFTY remains between the original stop ${fmt(position.underlyingStop)} and target ${fmt(position.underlyingTarget)} with no strong opposite-direction deterioration.`,
    copy: 'Normal pullbacks are allowed inside the plan. Do not exit simply because one candle or the option premium fluctuates.',
    rMultiple,
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
  if (coreRed >= 1) return `A core directional reading is red while the original hard stop remains intact.`;
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
