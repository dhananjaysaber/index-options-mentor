import useLiveQuote from '../hooks/useLiveQuote.js';
import { calculateSimulationSizing, classifyResearchSetup } from '../engine/researchStrategy.js';

export default function CoreResearchPanel({ snapshot, settings }) {
  const liveQuote = useLiveQuote();
  if (!snapshot) return null;

  const { decision = {}, option = null, structure = {}, market = {}, parameters = [], setup = {} } = snapshot;
  const classification = classifyResearchSetup(snapshot);
  const liveSpot = positive(liveQuote?.nifty) ?? positive(market?.spot);
  const liveOption = option && liveQuote?.optionSymbol === option.symbol
    ? positive(liveQuote?.optionPrice) ?? positive(option?.ltp)
    : positive(option?.ltp);
  const executionSnapshot = option ? {
    ...snapshot,
    market: { ...market, spot: liveSpot },
    option: { ...option, ltp: liveOption }
  } : snapshot;
  const sizing = option ? calculateSimulationSizing(executionSnapshot, settings) : null;
  const failedMandatory = parameters.filter(row => row.mandatory && !row.gatePassed);
  const weakConfirmations = parameters.filter(row => !row.mandatory && row.status !== 'green').sort((a, b) => Number(a.value) - Number(b.value));
  const checkpoint = checkpointForState({ decision, setup, failedMandatory, weakConfirmations, structure, classification });
  const action = actionForState(decision, market, classification);
  const rr = Number(decision?.rr);
  const blockers = coreBlockers({ decision, market, parameters, classification, option });

  const cards = [
    { label: 'Action', value: action, tone: classification.eligible ? 'positive' : '' },
    { label: 'Contract', value: option ? `${option.strike} ${option.optionType}` : 'Waiting' },
    { label: 'Lots / Qty', value: sizing ? `${sizing.lots} / ${sizing.quantity}` : '—' },
    { label: 'Buy option price', value: liveOption != null ? `₹${fmt(liveOption)}` : '—' },
    { label: 'Premium cost', value: sizing ? `₹${fmt(sizing.premiumCost)}` : '—' },
    { label: 'NIFTY', value: fmt(liveSpot) },
    { label: 'Invalidation', value: fmt(structure?.underlyingStop), tone: 'danger' },
    { label: 'Target', value: fmt(structure?.underlyingTarget), tone: 'positive' },
    { label: 'R:R', value: Number.isFinite(rr) ? `1 : ${rr.toFixed(1)}` : '—' }
  ];

  return (
    <section className="core-compact-plan" aria-label="13-point compact trade plan">
      <div className="core-compact-heading">
        <div><span>13-POINT TRADE PLAN</span><strong>{option?.symbol || 'Waiting for candidate option'}</strong></div>
        <em>SIMULATION</em>
      </div>

      <div className="core-checkpoint-card">
        <span>NEXT CHECKPOINT</span>
        <strong>{checkpoint}</strong>
      </div>
      <div className="core-checkpoint-card" aria-live="polite">
        <span>13-POINT GATE AUDIT · {market.phase === 'LIVE' ? 'LIVE' : 'LAST SNAPSHOT'}</span>
        <strong>{classification.eligible ? 'Research setup qualified.' : blockers.length ? blockers.slice(0, 3).join(' · ') : classification.reason}</strong>
        <small>Candidate monitoring is not a trade. The full Mentor, 4/5 controlled and 3/5 experimental tiers still require real option liquidity, an adequate structural stop and room, a confirmed 5m close and a held retest.</small>
      </div>

      <div className="core-compact-grid">
        {cards.map(card => <Metric key={card.label} {...card} />)}
      </div>

      <div className="core-evidence-strip" aria-label="Current qualification evidence">
        <Evidence label="Hard safety" pass={classification.hardSafetyPassed} />
        <Evidence label="5m close" pass={classification.closeConfirmed} />
        <Evidence label="Retest" pass={classification.retestHeld} />
        <Evidence label="Mandatory" value={`${classification.mandatoryPassCount}/5`} pass={classification.mandatoryPassCount >= 3} />
        <Evidence label="Confirmations" value={`${classification.confirmationPassCount}/8`} pass={classification.confirmationPassCount >= 6} />
      </div>
    </section>
  );
}

function Metric({ label, value, tone = '' }) {
  return <div className={`core-compact-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Evidence({ label, pass, value }) {
  return <div className={pass ? 'pass' : 'wait'}><span>{label}</span><strong>{value || (pass ? 'PASS' : 'WAIT')}</strong></div>;
}

function actionForState(decision, market, classification) {
  if (market?.phase !== 'LIVE') return 'REVIEW ONLY';
  if (classification?.tier === 'FULL') return decision?.side ? `TAKE ${decision.side}` : 'MENTOR APPROVED';
  if (classification?.tier === 'CONTROLLED') return 'CONTROLLED RESEARCH';
  if (classification?.tier === 'EXPERIMENTAL') return 'EXPERIMENTAL RESEARCH';
  const map = {
    PREMARKET: 'NO TRADE',
    OPENING_RANGE: 'WAIT — OPEN RANGE',
    NO_TRADE_DIRECTION: 'WAIT — DIRECTION',
    NO_TRADE_MANDATORY: 'WAIT — GATES',
    BIAS_FORMING: 'WAIT — BIAS',
    BREAKOUT_DETECTED: 'WAIT — 5M CLOSE',
    RETESTING: 'WAIT — RETEST',
    RETEST_FAILED: 'RESET',
    NO_TRADE_RR: 'WAIT — R:R',
    RETEST_HELD_WAIT: 'RESEARCH WATCH',
    RETEST_HELD_WATCH: 'RESEARCH WATCH',
    QUALIFIED: decision?.side ? `TAKE ${decision.side}` : 'QUALIFIED',
    STRONG_SETUP: decision?.side ? `TAKE ${decision.side}` : 'STRONG SETUP'
  };
  return map[decision?.state] || 'WAIT';
}

function checkpointForState({ decision, setup, failedMandatory, weakConfirmations, structure, classification }) {
  if (classification?.eligible) {
    return `${classification.label} · ${classification.mandatoryPassCount}/5 mandatory · ${classification.confirmationPassCount}/8 confirmations.`;
  }
  const state = decision?.state === 'MARKET_CLOSED' ? decision?.reviewState : decision?.state;
  if (state === 'PREMARKET') return 'Wait for the regular market session.';
  if (state === 'OPENING_RANGE') return 'Build ORH/ORL from three completed 5-minute candles.';
  if (state === 'NO_TRADE_DIRECTION') return 'Wait for trend + VWAP to establish a CE or PE bias.';
  if (state === 'NO_TRADE_MANDATORY') return failedMandatory[0] ? `${failedMandatory[0].label} is the first failed mandatory gate.` : 'A mandatory gate must improve.';
  if (state === 'BIAS_FORMING') return `Watch the ${decision?.side === 'CE' ? 'ORH' : 'ORL'} trigger.`;
  if (state === 'BREAKOUT_DETECTED') return 'Wait for a completed 5-minute close.';
  if (state === 'RETESTING') return `Watch ${fmt(structure?.trigger)}; the level must hold/reject.`;
  if (state === 'RETEST_FAILED') return 'Setup cancelled. Wait for a new breakout/retest cycle.';
  if (state === 'NO_TRADE_RR') return 'Wait for better reward room or a better entry.';
  if (state === 'RETEST_HELD_WAIT' || state === 'RETEST_HELD_WATCH') return weakConfirmations[0] ? `${weakConfirmations[0].label} is the weakest remaining confirmation.` : classification?.reason || 'Wait for cohort conditions.';
  if (state === 'QUALIFIED' || state === 'STRONG_SETUP') return 'The 13-point setup is ready for simulation.';
  return setup?.approvalReady ? 'Setup ready for review.' : classification?.reason || 'Wait for the next confirmed stage.';
}

function coreBlockers({ decision, market, parameters, classification, option }) {
  const blockers = [];
  if (market?.phase !== 'LIVE') return ['Market is not in an active live session.'];
  if (!['CE', 'PE'].includes(decision?.side)) blockers.push('No confirmed CE/PE bias');
  if (!option?.symbol || !(Number(option?.lotSize) > 0)) blockers.push('No tradable option selected');
  for (const row of parameters.filter(item => item.mandatory && item.gatePassed === false)) {
    blockers.push(`${row.label}: gate failed (${Math.round(Number(row.value || 0) * 100)}%)`);
  }
  if (!classification.closeConfirmed) blockers.push('5-minute breakout close missing');
  if (!classification.retestHeld) blockers.push('Held retest not confirmed');
  if (Number(decision?.score) < 80) blockers.push(`Score ${Math.round(Number(decision?.score) || 0)} below 80`);
  if (!(Number(decision?.rr) >= 1)) blockers.push('Available R:R below 1:1');
  return blockers;
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function fmt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—';
}
