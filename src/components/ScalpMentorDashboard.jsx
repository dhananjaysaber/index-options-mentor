import { useEffect, useState } from 'react';
import useLiveQuote from '../hooks/useLiveQuote.js';
import NiftyStrategyChart from './NiftyStrategyChart.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';
import SnapshotIssueBanner from './SnapshotIssueBanner.jsx';
import FyersLiveHandoff from './FyersLiveHandoff.jsx';
import { buildScalpTicket } from '../engine/scalpStrategy.js';

export default function ScalpMentorDashboard({
  snapshot,
  loading,
  liveError,
  authRequired = false,
  onRetry,
  marketDataReady = true,
  position,
  positionMentor,
  alertsEnabled,
  history,
  settings,
  onReconnect,
  onTakeTrade,
  onExit,
  candles = [],
  candleLoading = false,
  candleError = '',
  evaluation
}) {
  const liveQuote = useLiveQuote();
  const liveSpot = Number(liveQuote?.nifty) > 0 ? Number(liveQuote.nifty) : Number(snapshot?.market?.spot);
  const [manualLots, setManualLots] = useState(() => clampLots(settings?.defaultLots, settings?.lotCap));
  useEffect(() => {
    if (!position) setManualLots(current => clampLots(current || settings?.defaultLots, settings?.lotCap));
  }, [settings?.defaultLots, settings?.lotCap, position?.id]);

  function openManualScalp() {
    if (position || !evaluation?.manualEligible) return;
    const ticket = buildScalpTicket(snapshot, evaluation, settings, 'USER', { lots: manualLots });
    if (ticket) onTakeTrade(ticket);
  }

  function quickSellScalp() {
    if (!position || position.strategyFamily !== 'SCALP') return;
    onExit({
      closedBy: 'USER',
      reasonCode: 'MANUAL_EXIT',
      reason: 'Manual scalp exit from the fixed quick-action bar.',
      mentorState: 'SCALP MANUAL EXIT'
    });
  }

  return (
    <div className="scalp-dashboard">
      {liveError && (
        <SnapshotIssueBanner
          message={liveError}
          authRequired={authRequired}
          onReconnect={onReconnect}
          onRetry={onRetry}
        />
      )}

      <section className={`scalp-decision-card ${evaluation.eligible ? 'ready' : 'waiting'}`}>
        <div className="scalp-decision-top">
          <div>
            <div className="eyebrow">SCALP MENTOR · RESEARCH ONLY</div>
            <h1>{loading ? 'Reading scalp conditions…' : evaluation.eligible ? `${evaluation.side} scalp ready` : 'Wait for scalp trigger'}</h1>
            <p>{evaluation.reason}</p>
          </div>
          <div className={`scalp-score ${evaluation.eligible ? 'ready' : ''}`}>
            <span>SCORE</span>
            <strong>{Number.isFinite(evaluation.score) ? evaluation.score : '—'}</strong>
            <small>/100</small>
          </div>
        </div>
        <div className="scalp-decision-strip">
          <Metric label="Direction" value={evaluation.side || '—'} />
          <Metric label="3m trigger" value={fmt(evaluation.trigger)} />
          <Metric label="Stop" value={fmt(evaluation.stop)} tone="danger" />
          <Metric label="Target" value={fmt(evaluation.target)} tone="positive" />
          <Metric label="Plan" value="1:1 · 12 min max" />
        </div>
        <div className="scalp-automation-strip" aria-label="Scalp automation status">
          <div><span>AUTO ENTRY</span><strong className={settings?.scalpAutoOpen === false ? 'off' : 'on'}>{settings?.scalpAutoOpen === false ? 'OFF' : 'ON'}</strong><small>Strict scalp rules only</small></div>
          <div><span>AUTO CLOSE</span><strong className={settings?.scalpAutoClose === false ? 'off' : 'on'}>{settings?.scalpAutoClose === false ? 'OFF' : 'ON'}</strong><small>Target, stop, time & context</small></div>
          <div><span>MANUAL ENTRY</span><strong className={evaluation.manualEligible ? 'on' : 'off'}>{evaluation.manualEligible ? 'READY' : 'WAIT'}</strong><small>Research override with hard safety intact</small></div>
        </div>
      </section>

      {position && position.strategyFamily !== 'SCALP' && (
        <section className="scalp-existing-position">
          <strong>13-point position still active</strong>
          <span>Scalp research is paused until the existing simulated position is closed.</span>
          <LivePositionPanel position={position} onExit={onExit} history={history} snapshot={snapshot} />
        </section>
      )}

      {position?.strategyFamily === 'SCALP' && (
        <>
          <PositionAlertBanner
            position={position}
            mentor={positionMentor}
            alertsEnabled={alertsEnabled}
            onExit={meta => onExit({ ...meta, closedBy: 'USER' })}
          />
          <LivePositionPanel position={position} onExit={onExit} history={history} snapshot={snapshot} />
        </>
      )}

      <section className="scalp-chart-panel">
        <div className="scalp-section-heading">
          <div><span>EXECUTION CHART</span><strong>3-minute scalp structure</strong></div>
          <em>5m context · 3m execution</em>
        </div>
        <NiftyStrategyChart
          snapshot={snapshot}
          position={position?.strategyFamily === 'SCALP' ? position : null}
          defaultTimeframe="3"
          strategyNote="Scalp mode uses 5-minute directional context and 3-minute execution. The 5-minute tab is available for context."
        />
      </section>

      <section className="scalp-evidence-panel">
        <div className="scalp-section-heading">
          <div><span>SCALP EVIDENCE</span><strong>Fast-entry checklist</strong></div>
          <em>{evaluation.checks.filter(item => item.pass).length}/{evaluation.checks.length} passing</em>
        </div>
        <div className="scalp-check-grid">
          {evaluation.checks.map(item => (
            <div className={`scalp-check ${item.pass ? 'pass' : 'wait'}`} key={item.id}>
              <span>{item.label}</span>
              <strong>{item.pass ? 'PASS' : 'WAIT'}</strong>
              <small>{item.detail}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="scalp-quick-actions" role="group" aria-label="Fixed scalp buy and sell controls">
        <button
          type="button"
          className="scalp-quick-buy"
          disabled={Boolean(position) || !evaluation.manualEligible}
          onClick={openManualScalp}
        >
          <span>BUY</span>
          <small>{position ? 'Position open' : evaluation.manualEligible ? `${manualLots} ${manualLots === 1 ? 'lot' : 'lots'} · Open ${evaluation.side || 'scalp'}` : 'Waiting'}</small>
        </button>
        <button
          type="button"
          className="scalp-quick-sell"
          disabled={!position || position.strategyFamily !== 'SCALP'}
          onClick={quickSellScalp}
        >
          <span>SELL</span>
          <small>{position?.strategyFamily === 'SCALP' ? 'Exit scalp' : 'No scalp open'}</small>
        </button>
      </div>

      <section className="scalp-plan-panel">
        <div className="scalp-section-heading">
          <div><span>SCALP TRADE PLAN</span><strong>Tight risk · quick exit</strong></div>
          <em>SIMULATION</em>
        </div>
        <div className="scalp-plan-grid">
          <Metric label="NIFTY live" value={fmt(evaluation.spot)} />
          <Metric label="VWAP" value={fmt(evaluation.vwap)} />
          <Metric label="Risk points" value={fmt(evaluation.riskPoints)} />
          <Metric label="Max hold" value="12 min" />
          <Metric label="Profit target" value="+1.00R" tone="positive" />
          <Metric label="Auto entry" value={settings?.scalpAutoOpen === false ? 'OFF' : 'ON'} />
          <Metric label="Auto close" value={settings?.scalpAutoClose === false ? 'OFF' : 'ON'} />
        </div>
        {!position && (
          <div className="scalp-lot-editor">
            <div className="scalp-lot-copy">
              <span>MANUAL POSITION SIZE</span>
              <strong>{manualLots} {manualLots === 1 ? 'lot' : 'lots'} · {Number(snapshot?.option?.lotSize || 0) * manualLots || '—'} qty</strong>
              <small>Manual scalp only · maximum {Math.max(1, Number(settings?.lotCap) || 5)} lots</small>
            </div>
            <div className="scalp-lot-stepper" role="group" aria-label="Manual scalp lots">
              <button type="button" onClick={() => setManualLots(value => clampLots(Number(value) - 1, settings?.lotCap))} disabled={manualLots <= 1}>−</button>
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max={Math.max(1, Number(settings?.lotCap) || 5)}
                value={manualLots}
                onChange={event => setManualLots(clampLots(event.target.value, settings?.lotCap))}
                aria-label="Manual scalp lots"
              />
              <button type="button" onClick={() => setManualLots(value => clampLots(Number(value) + 1, settings?.lotCap))} disabled={manualLots >= Math.max(1, Number(settings?.lotCap) || 5)}>+</button>
            </div>
          </div>
        )}
        {!position && (
          <FyersLiveHandoff
            enabled={settings?.liveHandoffEnabled !== false}
            strategyLabel="Scalp Mentor"
            ready={Boolean(evaluation.eligible)}
            riskStatus="review"
            reason={evaluation.eligible
              ? 'Strict scalp rules qualify, but live capital risk still needs your review inside FYERS before any order is placed.'
              : evaluation.manualEligible
                ? 'Manual scalp research is available, but the strict automatic scalp rules do not qualify this as a live handoff.'
                : evaluation.reason}
            plan={{
              side: evaluation.side,
              symbol: snapshot?.option?.symbol,
              strike: snapshot?.option?.strike,
              lots: manualLots,
              quantity: Number(snapshot?.option?.lotSize || 0) * manualLots || null,
              optionPrice: liveQuote?.optionSymbol === snapshot?.option?.symbol ? liveQuote?.optionPrice : snapshot?.option?.ltp,
              niftyEntry: liveSpot,
              stop: evaluation.stop,
              target: evaluation.target,
              rr: evaluation.rr,
              mentorState: evaluation.eligible ? 'STRICT SCALP READY' : 'SCALP REVIEW'
            }}
          />
        )}

        {candleLoading && <div className="scalp-data-note">Refreshing 3-minute structure…</div>}
        {candleError && <div className="scalp-data-note warning">{candleError}</div>}
        {!position && (
          <>
            <div className={`scalp-manual-note ${evaluation.manualEligible ? 'ready' : ''}`}>
              <strong>{evaluation.manualEligible ? 'Manual research available' : 'Manual research waiting'}</strong>
              <span>{evaluation.manualReason}</span>
            </div>
            <button type="button" className="scalp-open-button" disabled={!evaluation.manualEligible} onClick={openManualScalp}>
              {evaluation.manualEligible
                ? evaluation.eligible
                  ? 'OPEN SCALP MANUALLY'
                  : 'OPEN MANUAL SCALP RESEARCH'
                : 'WAITING FOR SAFE MANUAL ENTRY'}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, tone = '' }) {
  return <div className={`scalp-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function fmt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

function clampLots(value, cap) {
  const max = Math.max(1, Number(cap) || 5);
  const parsed = Math.round(Number(value) || 1);
  return Math.max(1, Math.min(max, parsed));
}
