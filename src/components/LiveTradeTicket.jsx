function fmtNumber(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function LiveTradeTicket({ snapshot, settings, onTakeTrade, blocked }) {
  if (!snapshot) return null;
  const { decision, option, structure, market, parameters = [], setup = {} } = snapshot;

  const isLive = market.phase === 'LIVE';
  const approved = ['QUALIFIED', 'STRONG_SETUP'].includes(decision.state) && decision.canSuggestTrade;
  const failedMandatory = parameters.filter(row => row.mandatory && !row.gatePassed);
  const weakConfirmations = parameters
    .filter(row => !row.mandatory && row.status !== 'green')
    .sort((a, b) => a.value - b.value);

  const nextCheckpoint = checkpointForState({
    decision,
    setup,
    failedMandatory,
    weakConfirmations,
    structure
  });

  if (!option) {
    return (
      <aside className="trade-focus-card sticky-trade">
        <div className="trade-focus-head">
          <div>
            <div className="eyebrow">TRADE BOX</div>
            <h2>Waiting for candidate option</h2>
          </div>
          <span className="simulation-pill">SIMULATION</span>
        </div>
        <div className="candidate-label blocked">NO OPTION APPROVED</div>
        <div className="focus-action stop">
          <small>CURRENT ACTION</small>
          <strong>{market.phase === 'CLOSED' ? 'MARKET CLOSED' : actionTitleForState(decision.state)}</strong>
          <span>No option can be approved until direction and the mandatory gates qualify.</span>
        </div>
        <div className="next-checkpoint">
          <span>NEXT CHECKPOINT</span>
          <strong>{nextCheckpoint}</strong>
        </div>
      </aside>
    );
  }

  const optionRiskPerUnit = Math.max(0, option.ltp - option.estimatedPremiumStop);
  const riskBudget = settings.capital * (settings.riskPct / 100);
  const lotRisk = option.lotSize ? optionRiskPerUnit * option.lotSize : null;
  const riskLots = lotRisk && lotRisk > 0 ? Math.floor(riskBudget / lotRisk) : 0;
  const lots = option.lotSize ? Math.max(0, Math.min(settings.lotCap, riskLots)) : 0;
  const canTake = approved && !blocked && lots > 0 && isLive;

  let actionTitle = actionTitleForState(decision.state, option.optionType);
  let actionCopy = actionCopyForState(decision.state);
  let actionTone = actionToneForState(decision.state);

  if (!isLive) {
    actionTitle = 'MARKET CLOSED';
    actionCopy = decision.reviewHeadline
      ? `Review outcome: ${decision.reviewHeadline}.`
      : 'Review only. Trading button is locked.';
    actionTone = 'stop';
  } else if (blocked) {
    actionTitle = 'TRADE BLOCKED';
    actionCopy = 'A position is already open or the daily protection rule is active.';
    actionTone = 'stop';
  } else if (canTake) {
    actionTitle = `TAKE ${option.optionType}`;
    actionCopy = 'The live state machine and the current rule stack have approved this simulated entry.';
    actionTone = 'go';
  } else if (approved && lots === 0) {
    actionTitle = 'RISK BLOCKED';
    actionCopy = 'The current risk budget does not safely support one full lot.';
    actionTone = 'stop';
  }

  const tradeRows = [
    ['Option', `${option.strike} ${option.optionType}`],
    ['LTP', `₹${fmtNumber(option.ltp)}`],
    ['Lots', lots],
    ['Qty', option.lotSize ? lots * option.lotSize : '—'],
    ['NIFTY entry', fmtNumber(market.spot)],
    ['Invalidation', fmtNumber(structure.underlyingStop)],
    ['Target', fmtNumber(structure.underlyingTarget)],
    ['R:R', decision.rr >= 1 ? `1 : ${decision.rr.toFixed(1)}` : 'Not viable']
  ];

  return (
    <aside className="trade-focus-card sticky-trade">
      <div className="trade-focus-head">
        <div>
          <div className="eyebrow">TRADE BOX</div>
          <h2>{option.symbol}</h2>
        </div>
        <span className="simulation-pill">SIMULATION</span>
      </div>

      <div className={`candidate-label ${approved && isLive ? 'approved' : 'blocked'}`}>
        {approved && isLive ? 'APPROVED OPTION' : 'CANDIDATE OPTION — NOT APPROVED'}
      </div>

      <div className={`focus-action ${actionTone}`}>
        <small>CURRENT ACTION</small>
        <strong>{actionTitle}</strong>
        <span>{actionCopy}</span>
      </div>

      <div className="next-checkpoint">
        <span>NEXT CHECKPOINT</span>
        <strong>{nextCheckpoint}</strong>
      </div>

      <div className="trade-plan-grid">
        {tradeRows.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="option-health-row">
        <div><span>Delta</span><strong>{fmtNumber(option.delta)}</strong></div>
        <div><span>Spread</span><strong>{fmtNumber(option.spreadPct)}%</strong></div>
        <div><span>IV</span><strong>{fmtNumber(option.iv)}</strong></div>
        <div><span>Lot size</span><strong>{option.lotSize ?? '—'}</strong></div>
      </div>

      <div className="premium-guide">
        <span>Premium guide</span>
        <strong>Stop ~ ₹{fmtNumber(option.estimatedPremiumStop)}</strong>
        <strong>Target ~ ₹{fmtNumber(option.estimatedPremiumTarget)}</strong>
        <small>Underlying structure remains the actual invalidation reference.</small>
      </div>

      <button
        className={`mega-trade-button ${canTake ? 'go' : 'locked'}`}
        disabled={!canTake}
        onClick={() => onTakeTrade({
          id: crypto.randomUUID(),
          openedAt: new Date().toISOString(),
          approvalState: decision.state,
          score: decision.score,
          rr: decision.rr,
          side: option.optionType,
          symbol: option.symbol,
          strike: option.strike,
          expiry: option.expiry,
          lotSize: option.lotSize,
          lots,
          quantity: lots * option.lotSize,
          entry: option.ltp,
          currentPrice: option.ltp,
          underlyingEntry: market.spot,
          underlyingCurrent: market.spot,
          underlyingStop: structure.underlyingStop,
          underlyingTarget: structure.underlyingTarget,
          parameterSnapshot: snapshot.parameters,
          reasons: decision.reasons,
          entryMarket: {
            spot: market.spot,
            vwap: market.vwap,
            orh: market.orh,
            orl: market.orl,
            pdh: market.pdh,
            pdl: market.pdl,
            vix: market.vix,
            putCallOiRatio: market.putCallOiRatio,
            atr5: market.atr5,
            sessionDate: market.sessionDate,
            lastCandleTime: market.lastCandleTime
          },
          entryStructure: { ...structure },
          entryDecision: {
            state: decision.state,
            score: decision.score,
            rr: decision.rr,
            side: decision.side,
            availableRR: decision.availableRR
          },
          entryOption: {
            ltp: option.ltp,
            delta: option.delta,
            gamma: option.gamma,
            theta: option.theta,
            vega: option.vega,
            iv: option.iv,
            spreadPct: option.spreadPct,
            volume: option.volume,
            oi: option.oi
          }
        })}
      >
        {canTake ? `TAKE SIMULATED ${option.optionType} TRADE` : actionTitle}
      </button>
    </aside>
  );
}

function actionTitleForState(state, side = '') {
  const map = {
    PREMARKET: 'NO TRADE',
    OPENING_RANGE: 'WAIT — OPEN RANGE',
    NO_TRADE_DIRECTION: 'NO TRADE',
    NO_TRADE_MANDATORY: 'NO TRADE',
    BIAS_FORMING: 'WAIT — BIAS',
    BREAKOUT_DETECTED: 'WAIT — 5M CLOSE',
    RETESTING: 'WAIT — RETEST',
    RETEST_FAILED: 'NO TRADE — RESET',
    NO_TRADE_RR: 'NO TRADE — POOR R:R',
    RETEST_HELD_WAIT: 'WAIT',
    RETEST_HELD_WATCH: 'CAUTION',
    QUALIFIED: side ? `TAKE ${side}` : 'TRADE QUALIFIED',
    STRONG_SETUP: side ? `TAKE ${side}` : 'STRONG SETUP'
  };
  return map[state] || 'WAIT';
}

function actionCopyForState(state) {
  const map = {
    PREMARKET: 'Market has not opened. No trade can be taken.',
    OPENING_RANGE: 'Wait until the first three completed 5-minute candles define ORH and ORL.',
    NO_TRADE_DIRECTION: 'Directional evidence is not clear enough.',
    NO_TRADE_MANDATORY: 'At least one non-negotiable gate has failed.',
    BIAS_FORMING: 'The market is worth watching, but no breakout has been confirmed.',
    BREAKOUT_DETECTED: 'Price crossed the trigger. Do not chase it; wait for a completed 5-minute close.',
    RETESTING: 'The breakout close is confirmed. Wait for the retest to hold or fail.',
    RETEST_FAILED: 'The breakout thesis has failed. Wait for a fresh sequence.',
    NO_TRADE_RR: 'The setup may look good, but there is not enough structural reward room.',
    RETEST_HELD_WAIT: 'The retest held, but the confirmation stack is still too weak.',
    RETEST_HELD_WATCH: 'The retest held. Evidence is improving, but approval has not been earned.',
    QUALIFIED: 'The setup has qualified under the current rules.',
    STRONG_SETUP: 'High confluence setup with the current rule stack.'
  };
  return map[state] || 'The mentor is still waiting for confirmation.';
}

function actionToneForState(state) {
  if (['QUALIFIED', 'STRONG_SETUP'].includes(state)) return 'go';
  if (['BREAKOUT_DETECTED', 'BIAS_FORMING', 'RETESTING', 'RETEST_HELD_WAIT', 'RETEST_HELD_WATCH', 'OPENING_RANGE'].includes(state)) return 'wait';
  return 'stop';
}

function checkpointForState({ decision, setup, failedMandatory, weakConfirmations, structure }) {
  const state = decision.state === 'MARKET_CLOSED' ? decision.reviewState : decision.state;

  if (state === 'PREMARKET') return 'Wait for the regular market session to begin.';
  if (state === 'OPENING_RANGE') return 'Wait until 09:30 so ORH and ORL are built from three completed 5-minute candles.';
  if (state === 'NO_TRADE_DIRECTION') return 'Wait for trend and VWAP structure to establish a clear CE or PE bias.';
  if (state === 'NO_TRADE_MANDATORY') return failedMandatory[0]
    ? `${failedMandatory[0].label} must pass its mandatory threshold before any trade is allowed.`
    : 'A mandatory gate must improve before any trade is allowed.';
  if (state === 'BIAS_FORMING') return `Watch the ${decision.side === 'CE' ? 'ORH' : 'ORL'} trigger. Do not enter before a real breakout.`;
  if (state === 'BREAKOUT_DETECTED') return 'Wait for the current 5-minute candle to close beyond the trigger. An intrabar break is not enough.';
  if (state === 'RETESTING') return `Watch ${fmtNumber(structure.trigger)}. The level must hold/reject before entry is considered.`;
  if (state === 'RETEST_FAILED') return 'This setup is cancelled. Wait for a new breakout and a new retest cycle.';
  if (state === 'NO_TRADE_RR') return 'Wait for a better entry or more room to the next structural barrier.';
  if (state === 'RETEST_HELD_WAIT' || state === 'RETEST_HELD_WATCH') return weakConfirmations[0]
    ? `${weakConfirmations[0].label} is the weakest remaining confirmation.`
    : 'Wait for the confluence score to reach the approval band.';
  if (state === 'QUALIFIED' || state === 'STRONG_SETUP') return 'Verify strike, lots, invalidation and target; then mirror the broker trade in simulation.';
  return setup.approvalReady ? 'The setup is ready for review.' : 'Wait for the next confirmed stage.';
}
