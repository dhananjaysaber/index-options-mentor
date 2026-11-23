import { calculateSimulationSizing, buildManualResearchTicket, classifyManualResearchSetup, classifyResearchSetup } from '../engine/researchStrategy.js';

export default function CoreQuickActions({ snapshot, liveQuote, marketDataReady = true, settings, position, onTakeTrade, onExit }) {
  const automatic = classifyResearchSetup(snapshot);
  const manual = classifyManualResearchSetup(snapshot);
  const sizing = calculateSimulationSizing(snapshot, settings, liveQuote);
  const manualReady = Boolean(sizing.lots > 0 && marketDataReady && !position && manual?.eligible && automatic?.hardSafetyPassed);
  const qualification = !marketDataReady && !position ? 'Waiting for fresh Mentor data' : position
    ? position.researchQualificationLabel || position.strategyTierLabel || position.strategyTier || 'POSITION OPEN'
    : automatic?.eligible
      ? automatic.label
      : manualReady
        ? 'Manual research ready'
        : sizing.lots < 1 ? 'Amount cannot cover one lot' : 'Waiting for safe setup';

  function openManual() {
    if (!manualReady) return;
    const ticket = buildManualResearchTicket(snapshot, settings);
    if (!ticket) return;
    onTakeTrade?.({
      ...ticket,
      researchQualificationTier: automatic?.tier || 'MANUAL',
      researchQualificationLabel: automatic?.eligible ? automatic.label : 'Manual research',
      researchTagAtEntry: automatic?.eligible ? `${automatic.label} · manual entry` : 'Manual research · safety gates passed'
    });
  }

  function sell() {
    if (!position) return;
    onExit?.({
      closedBy: 'USER',
      reasonCode: 'MANUAL_EXIT',
      reason: 'Manual 13-point exit from the fixed quick-action bar.',
      mentorState: '13-POINT MANUAL EXIT'
    });
  }

  return (
    <div className="strategy-quick-actions core-quick-actions" role="group" aria-label="Fixed 13-point buy and sell research controls">
      <div className="strategy-quick-status">
        <span>13-POINT</span>
        <strong>{qualification}</strong>
        <small>{position ? `${position.side || ''} ${position.strike || ''} · open` : Number.isFinite(Number(automatic?.score)) ? `Score ${automatic.score}/100` : 'Research only'}</small>
      </div>
      <button type="button" className="strategy-quick-buy" disabled={Boolean(position) || !manualReady} onClick={openManual}>
        <span>BUY</span>
        <small>{position ? 'Position open' : manualReady ? 'Open manual research' : 'Waiting'}</small>
      </button>
      <button type="button" className="strategy-quick-sell" disabled={!position} onClick={sell}>
        <span>SELL</span>
        <small>{position ? 'Exit 13-point' : 'No 13-point open'}</small>
      </button>
    </div>
  );
}
