import { useState } from 'react';
import TraderDecisionBanner from './TraderDecisionBanner.jsx';
import MentorWorkflow from './MentorWorkflow.jsx';
import QuickChecklist from './QuickChecklist.jsx';
import TraderMarketPanel from './TraderMarketPanel.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import ParameterGrid from './ParameterGrid.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';
import CoreResearchPanel from './CoreResearchPanel.jsx';

export default function MobileMentorDashboardV41({
  mode,
  snapshot,
  loading,
  liveError,
  position,
  positionMentor,
  alertsEnabled,
  history,
  settings,
  onReconnect,
  onExit
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const directionReady = Boolean(snapshot?.decision?.side);

  return (
    <div className={`mobile-mentor-flow mode-${mode}`}>
      {liveError && <div className="alert-bar mobile-flow-alert reconnect-alert"><span>{liveError} The saved FYERS session may have expired.</span><button type="button" onClick={onReconnect}>Reconnect FYERS</button></div>}

      <div className="mobile-flow-block mobile-decision-block">
        <TraderDecisionBanner snapshot={snapshot} loading={loading} />
      </div>

      <section id="mobile-position-section" className="mobile-flow-block mobile-trade-block" aria-label="Trade plan and position">
        {position && <div className="position-lock-bar mobile-position-lock">13-POINT POSITION ACTIVE · {position.strategyTierLabel || position.strategyTier || 'RESEARCH'}</div>}
        <PositionAlertBanner position={position} mentor={positionMentor} alertsEnabled={alertsEnabled} onExit={meta => onExit({ ...meta, closedBy: 'USER' })} />
        {position
          ? <LivePositionPanel position={position} onExit={onExit} history={history} snapshot={snapshot} />
          : <CoreResearchPanel snapshot={snapshot} settings={settings} />}
      </section>

      <section className="mobile-flow-block mobile-live-path-block" aria-label="Live path">
        <MentorWorkflow snapshot={snapshot} />
      </section>

      <section className="mobile-flow-block mobile-market-map-block" aria-label="Market map">
        <TraderMarketPanel snapshot={snapshot} />
      </section>

      {mode === 'advanced' && (
        <section className={`mobile-advanced-stack advanced-strategy-section ${advancedOpen ? 'expanded' : 'collapsed'}`} aria-label="Advanced mentor analysis">
          <div className="mobile-advanced-heading advanced-strategy-heading">
            <span><small>ADVANCED VIEW</small><strong>13-point strategy detail</strong></span>
            <button type="button" className="advanced-strategy-toggle" onClick={() => setAdvancedOpen(value => !value)} aria-expanded={advancedOpen}>{advancedOpen ? '−' : '+'}</button>
          </div>
          {advancedOpen && <div className="advanced-strategy-body"><QuickChecklist rows={snapshot?.parameters || []} directionReady={directionReady} />{snapshot && <ParameterGrid rows={snapshot.parameters || []} directionReady={directionReady} />}</div>}
        </section>
      )}
    </div>
  );
}
