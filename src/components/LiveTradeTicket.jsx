import { buildSimulatedTicket, calculateSimulationSizing, classifyResearchSetup, tierEnabled } from '../engine/researchStrategy.js';
import ManualResearchPanel from './ManualResearchPanel.jsx';
import useLiveQuote from '../hooks/useLiveQuote.js';

function fmtNumber(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function LiveTradeTicket({ snapshot, settings, onTakeTrade, blocked }) {
  const liveQuote = useLiveQuote();
  if (!snapshot) return null;
  const { decision, option, structure, market, parameters = [], setup = {} } = snapshot;
  const liveSpot = livePrice(liveQuote?.nifty) ?? livePrice(market?.spot);
  const liveOption = option && liveQuote?.optionSymbol === option.symbol
    ? livePrice(liveQuote?.optionPrice) ?? livePrice(option?.ltp)
    : livePrice(option?.ltp);
  const executionSnapshot = option ? {
    ...snapshot,
    market: { ...market, spot: liveSpot, liveUpdatedAt: liveQuote?.at || market?.liveUpdatedAt },
    option: { ...option, ltp: liveOption }
  } : snapshot;
  const classification = classifyResearchSetup(snapshot);
  const enabledTier = tierEnabled(classification, settings);
  const sizing = option ? calculateSimulationSizing(executionSnapshot, settings) : null;
  const isLive = market.phase === 'LIVE';
  const failedMandatory = parameters.filter(row => row.mandatory && !row.gatePassed);
  const weakConfirmations = parameters.filter(row => !row.mandatory && row.status !== 'green').sort((a, b) => a.value - b.value);
  const nextCheckpoint = checkpointForState({ decision, setup, failedMandatory, weakConfirmations, structure, classification });

  if (!option) {
    return (
      <aside className="trade-focus-card sticky-trade">
        <div className="trade-focus-head"><div><div className="eyebrow">TRADE BOX</div><h2>Waiting for candidate option</h2></div><span className="simulation-pill">SIMULATION</span></div>
        <div className="candidate-label blocked">NO OPTION READY</div>
        <div className="focus-action stop"><small>CURRENT ACTION</small><strong>{market.phase === 'CLOSED' ? 'MARKET CLOSED' : actionTitleForState(decision.state)}</strong><span>Direction, structure and the hard safety gates must exist before an automated research position can be opened.</span></div>
        <div className="next-checkpoint"><span>NEXT CHECKPOINT</span><strong>{nextCheckpoint}</strong></div>
      </aside>
    );
  }

  const rrViable = Number(decision.rr) >= 1;
  const canTake = !blocked && isLive && classification.eligible && enabledTier && sizing?.quantity > 0;
  const full = classification.tier === 'FULL';
  const controlled = classification.tier === 'CONTROLLED';
  const experimental = classification.tier === 'EXPERIMENTAL';

  let actionTitle = actionTitleForState(decision.state, option.optionType);
  let actionCopy = actionCopyForState(decision.state);
  let actionTone = actionToneForState(decision.state);

  if (!isLive) {
    actionTitle = 'MARKET CLOSED';
    actionCopy = decision.reviewHeadline ? `Review outcome: ${decision.reviewHeadline}.` : 'Review only. New positions are locked.';
    actionTone = 'stop';
  } else if (blocked) {
    actionTitle = 'POSITION ALREADY OPEN';
    actionCopy = 'The Mentor manages one simulated position at a time.';
    actionTone = 'stop';
  } else if (canTake) {
    actionTitle = full ? 'FULL APPROVAL' : controlled ? 'CONTROLLED RESEARCH' : 'EXPERIMENTAL RESEARCH';
    actionCopy = full
      ? 'All current strategy requirements have approved this setup.'
      : controlled
        ? '4/5 mandatory gates and at least 7/8 confirmations passed. Hard safety gates remain intact; this position is research-labelled.'
        : '3/5 mandatory gates and at least 6/8 confirmations passed. Hard safety gates remain intact; this is experimental research only.';
    actionTone = full ? 'go' : 'wait';
  }

  const tradeRows = [
    ['Option', `${option.strike} ${option.optionType}`],
    ['LTP', liveOption != null ? `₹${fmtNumber(liveOption)}` : '—'],
    ['Sim lots', sizing?.lots ?? '—'],
    ['Qty', sizing?.quantity || '—'],
    ['NIFTY entry', fmtNumber(liveSpot)],
    ['Invalidation', fmtNumber(structure.underlyingStop)],
    ['Target', fmtNumber(structure.underlyingTarget)],
    ['R:R', rrViable ? `1 : ${Number(decision.rr).toFixed(1)}` : 'Not viable']
  ];

  return (
    <aside className="trade-focus-card sticky-trade">
      <div className="trade-focus-head"><div><div className="eyebrow">TRADE BOX</div><h2>{option.symbol}</h2></div><span className="simulation-pill">SIMULATION</span></div>

      <div className={`candidate-label ${canTake ? 'approved' : 'blocked'}`}>
        {classification.eligible ? `${classification.label.toUpperCase()} · ${classification.mandatoryPassCount}/5 · ${classification.confirmationPassCount}/8` : 'CANDIDATE OPTION — NO AUTOMATED POSITION'}
      </div>

      <div className={`focus-action ${actionTone}`}><small>CURRENT ACTION</small><strong>{actionTitle}</strong><span>{actionCopy}</span></div>
      <div className="next-checkpoint"><span>NEXT CHECKPOINT</span><strong>{nextCheckpoint}</strong></div>

      <div className="trade-plan-grid">
        {tradeRows.map(([label, value]) => {
          const isRr = label === 'R:R';
          return <div key={label} className={isRr ? `rr-card ${rrViable ? 'viable' : 'not-viable'}` : ''}><span>{label}</span><strong>{value}</strong>{isRr && <small className="rr-card-note">{rrViable ? 'REWARD ROOM OK' : 'SKIP — REWARD TOO LOW'}</small>}</div>;
        })}
      </div>

      <div className="option-health-row">
        <div><span>Delta</span><strong>{fmtNumber(option.delta)}</strong></div>
        <div><span>Spread</span><strong>{fmtNumber(option.spreadPct)}%</strong></div>
        <div><span>IV</span><strong>{fmtNumber(option.iv)}</strong></div>
        <div><span>Contract lot</span><strong>{option.lotSize ?? '—'}</strong></div>
      </div>

      {sizing && (
        <div className={`research-risk-card ${sizing.riskBudgetEligible ? 'eligible' : 'outside-budget'}`}>
          <div><span>Configured risk budget</span><strong>₹{fmtNumber(sizing.riskBudget)}</strong></div>
          <div><span>{sizing.lots} sim lot{Number(sizing.lots) === 1 ? '' : 's'} estimated risk</span><strong>₹{fmtNumber(sizing.requiredRiskAmount)} · {fmtNumber(sizing.requiredRiskPct)}%</strong></div>
          <small>{sizing.riskBudgetEligible ? 'This simulated size also fits the configured capital-risk budget.' : 'Research simulation may still be opened, but this size is NOT live-risk eligible. A future real-order layer must remain blocked.'}</small>
        </div>
      )}

      <div className="premium-guide"><span>Premium guide</span><strong>Stop ~ ₹{fmtNumber(option.estimatedPremiumStop)}</strong><strong>Target ~ ₹{fmtNumber(option.estimatedPremiumTarget)}</strong><small>Underlying structure remains the actual invalidation reference.</small></div>

      <button className={`mega-trade-button ${canTake ? 'go' : 'locked'}`} disabled={!canTake} onClick={() => { const ticket = buildSimulatedTicket(executionSnapshot, settings, 'USER'); if (ticket) onTakeTrade(ticket); }}>
        {canTake ? `OPEN ${classification.label.toUpperCase()} SIMULATION` : actionTitle}
      </button>

      {!blocked && <ManualResearchPanel snapshot={executionSnapshot} settings={settings} onTakeTrade={onTakeTrade} />}
    </aside>
  );
}

function livePrice(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function actionTitleForState(state, side = '') {
  const map = { PREMARKET: 'NO TRADE', OPENING_RANGE: 'WAIT — OPEN RANGE', NO_TRADE_DIRECTION: 'NO TRADE', NO_TRADE_MANDATORY: 'NO TRADE', BIAS_FORMING: 'WAIT — BIAS', BREAKOUT_DETECTED: 'WAIT — 5M CLOSE', RETESTING: 'WAIT — RETEST', RETEST_FAILED: 'NO TRADE — RESET', NO_TRADE_RR: 'NO TRADE — POOR R:R', RETEST_HELD_WAIT: 'WAIT', RETEST_HELD_WATCH: 'RESEARCH WATCH', QUALIFIED: side ? `TAKE ${side}` : 'TRADE QUALIFIED', STRONG_SETUP: side ? `TAKE ${side}` : 'STRONG SETUP' };
  return map[state] || 'WAIT';
}

function actionCopyForState(state) {
  const map = { PREMARKET: 'Market has not opened. No position can be created.', OPENING_RANGE: 'Wait for the first three completed 5-minute candles.', NO_TRADE_DIRECTION: 'Directional evidence is not clear enough.', NO_TRADE_MANDATORY: 'The setup does not currently qualify for the full strategy.', BIAS_FORMING: 'Bias exists, but the structural sequence is incomplete.', BREAKOUT_DETECTED: 'Price crossed the trigger. Wait for a completed 5-minute close.', RETESTING: 'The breakout close is confirmed. Wait for the retest.', RETEST_FAILED: 'The setup has failed. Wait for a fresh sequence.', NO_TRADE_RR: 'There is not enough structural reward room.', RETEST_HELD_WAIT: 'The retest held, but the research cohort rules are not met.', RETEST_HELD_WATCH: 'The retest held. The Mentor is checking whether the controlled research cohort qualifies.', QUALIFIED: 'The setup has qualified under the current strategy.', STRONG_SETUP: 'High confluence setup under the current strategy.' };
  return map[state] || 'The Mentor is waiting for the next confirmed step.';
}

function actionToneForState(state) {
  if (['QUALIFIED', 'STRONG_SETUP'].includes(state)) return 'go';
  if (['BREAKOUT_DETECTED', 'BIAS_FORMING', 'RETESTING', 'RETEST_HELD_WAIT', 'RETEST_HELD_WATCH', 'OPENING_RANGE'].includes(state)) return 'wait';
  return 'stop';
}

function checkpointForState({ decision, setup, failedMandatory, weakConfirmations, structure, classification }) {
  if (classification?.eligible) return `${classification.label}: ${classification.mandatoryPassCount}/5 mandatory and ${classification.confirmationPassCount}/8 confirmations. ${classification.reason}`;
  const state = decision.state === 'MARKET_CLOSED' ? decision.reviewState : decision.state;
  if (state === 'PREMARKET') return 'Wait for the regular market session to begin.';
  if (state === 'OPENING_RANGE') return 'Wait until ORH and ORL are built from three completed 5-minute candles.';
  if (state === 'NO_TRADE_DIRECTION') return 'Wait for trend and VWAP structure to establish a clear CE or PE bias.';
  if (state === 'NO_TRADE_MANDATORY') return failedMandatory[0] ? `${failedMandatory[0].label} is the first failed mandatory gate. Research still requires the hard safety gates and cohort rules.` : 'A mandatory gate must improve.';
  if (state === 'BIAS_FORMING') return `Watch the ${decision.side === 'CE' ? 'ORH' : 'ORL'} trigger. Do not enter before a real breakout.`;
  if (state === 'BREAKOUT_DETECTED') return 'Wait for a completed 5-minute close. An intrabar break is not enough.';
  if (state === 'RETESTING') return `Watch ${fmtNumber(structure.trigger)}. The level must hold/reject before entry is considered.`;
  if (state === 'RETEST_FAILED') return 'This setup is cancelled. Wait for a new breakout and retest cycle.';
  if (state === 'NO_TRADE_RR') return 'Wait for a better entry or more room to the next structural barrier.';
  if (state === 'RETEST_HELD_WAIT' || state === 'RETEST_HELD_WATCH') return weakConfirmations[0] ? `${weakConfirmations[0].label} is the weakest remaining confirmation.` : classification?.reason || 'Wait for the cohort conditions to qualify.';
  if (state === 'QUALIFIED' || state === 'STRONG_SETUP') return 'The full strategy is ready for simulation.';
  return setup.approvalReady ? 'The setup is ready for review.' : classification?.reason || 'Wait for the next confirmed stage.';
}
