import { useState } from 'react';
import TraderDecisionBanner from './TraderDecisionBanner.jsx';
import MentorWorkflow from './MentorWorkflow.jsx';
import QuickChecklist from './QuickChecklist.jsx';
import TraderMarketPanel from './TraderMarketPanel.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import ParameterGrid from './ParameterGrid.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';
import CoreResearchPanel from './CoreResearchPanel.jsx';
import SnapshotIssueBanner from './SnapshotIssueBanner.jsx';

/** Compact 13-Point mobile trading view. Existing trading callbacks unchanged. */
export default function MobileMentorDashboardV41({
  mode, snapshot, loading, liveError, authRequired = false, onRetry,
  position, positionMentor, alertsEnabled, history, settings, onReconnect, onExit
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const directionReady = Boolean(snapshot?.decision?.side);

  return (
    <div className={'mobile-mentor-flow mode-' + mode + ' premium-core-flow'}>
      {liveError && (
        <SnapshotIssueBanner
          message={liveError}
          authRequired={authRequired}
          onRetry={onRetry}
          onReconnect={onReconnect}
        />
      )}

      <div className="mobile-flow-block mobile-decision-block">
        <TraderDecisionBanner snapshot={snapshot} loading={loading} />
      </div>

      {/* Open positions and exit alerts stay above the chart for safety. */}
      {position && (
        <section id="mobile-position-section" className="mobile-flow-block mobile-trade-block" aria-label="Open 13-point position">
          <div className="position-lock-bar mobile-position-lock">
            13-POINT POSITION ACTIVE · {position.strategyTierLabel || position.strategyTier || 'RESEARCH'}
          </div>
          <PositionAlertBanner
            position={position}
            mentor={positionMentor}
            alertsEnabled={alertsEnabled}
            onExit={meta => onExit({ ...meta, closedBy: 'USER' })}
          />
          <LivePositionPanel
            position={position}
            onExit={onExit}
            history={history}
            snapshot={snapshot}
          />
        </section>
      )}

      {/* Hero chart first, followed by just one compact context strip. */}
      <section className="mobile-flow-block mobile-market-map-block" aria-label="NIFTY chart and market levels">
        <TraderMarketPanel snapshot={snapshot} />
      </section>

      {!position && (
        <section id="mobile-position-section" className="mobile-flow-block mobile-trade-block" aria-label="Compact trade plan">
          <CoreResearchPanel snapshot={snapshot} settings={settings} />
        </section>
      )}

      {/* Evidence remains available without taking up chart space. */}
      <details className="mobile-flow-block premium-core-details">
        <summary>13-Point qualification steps</summary>
        <div className="premium-core-details-body">
          <MentorWorkflow snapshot={snapshot} />
        </div>
      </details>

      {mode === 'advanced' && (
        <section
          className={'mobile-advanced-stack advanced-strategy-section ' + (advancedOpen ? 'expanded' : 'collapsed')}
          aria-label="Advanced mentor analysis"
        >
          <div className="mobile-advanced-heading advanced-strategy-heading">
            <span><small>ADVANCED VIEW</small><strong>13-point strategy detail</strong></span>
            <button
              type="button"
              className="advanced-strategy-toggle"
              onClick={() => setAdvancedOpen(value => !value)}
              aria-expanded={advancedOpen}
              aria-label={advancedOpen ? 'Hide advanced strategy detail' : 'Show advanced strategy detail'}
            >
              {advancedOpen ? '−' : '+'}
            </button>
          </div>
          {advancedOpen && (
            <div className="advanced-strategy-body">
              <QuickChecklist rows={snapshot?.parameters || []} directionReady={directionReady} />
              {snapshot && <ParameterGrid rows={snapshot.parameters || []} directionReady={directionReady} />}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
