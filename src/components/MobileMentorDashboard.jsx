import TraderDecisionBanner from './TraderDecisionBanner.jsx';
import MentorWorkflow from './MentorWorkflow.jsx';
import QuickChecklist from './QuickChecklist.jsx';
import TraderMarketPanel from './TraderMarketPanel.jsx';
import LiveTradeTicket from './LiveTradeTicket.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import ParameterGrid from './ParameterGrid.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';

export default function MobileMentorDashboard({
  mode,
  snapshot,
  loading,
  liveError,
  position,
  positionMentor,
  alertsEnabled,
  history,
  settings,
  onTakeTrade,
  onExit
}) {
  const directionReady = Boolean(snapshot?.decision?.side);
  const positionCard = position
    ? <LivePositionPanel position={position} onExit={onExit} history={history} snapshot={snapshot} />
    : <LiveTradeTicket snapshot={snapshot} settings={settings} onTakeTrade={onTakeTrade} blocked={false} />;

  return (
    <div className={`mobile-mentor-flow mode-${mode}`}>
      {liveError && <div className="alert-bar mobile-flow-alert">{liveError} Reconnect FYERS if the daily session has expired.</div>}

      <div className="mobile-flow-block mobile-decision-block">
        <TraderDecisionBanner snapshot={snapshot} loading={loading} />
      </div>

      <section id="mobile-position-section" className="mobile-flow-block mobile-trade-block" aria-label="Trade box and position">
        {position && (
          <div className="position-lock-bar mobile-position-lock">
            SIMULATED POSITION ACTIVE · OPENED BY {position.initiatedBy || 'USER'} · {position.strategyTierLabel || position.strategyTier || 'RESEARCH'}
          </div>
        )}
        <PositionAlertBanner
          position={position}
          mentor={positionMentor}
          alertsEnabled={alertsEnabled}
          onExit={meta => onExit({ ...meta, closedBy: 'USER' })}
        />
        {positionCard}
      </section>

      <section className="mobile-flow-block mobile-live-path-block" aria-label="Live path">
        <MentorWorkflow snapshot={snapshot} />
      </section>

      <section className="mobile-flow-block mobile-market-map-block" aria-label="Market map">
        <TraderMarketPanel snapshot={snapshot} />
      </section>

      {mode === 'advanced' && (
        <section className="mobile-advanced-stack" aria-label="Advanced mentor analysis">
          <div className="mobile-advanced-heading">
            <span>ADVANCED VIEW</span>
            <strong>13-point strategy detail</strong>
          </div>
          <QuickChecklist rows={snapshot?.parameters || []} directionReady={directionReady} />
          {snapshot && <ParameterGrid rows={snapshot.parameters || []} directionReady={directionReady} />}
        </section>
      )}
    </div>
  );
}
