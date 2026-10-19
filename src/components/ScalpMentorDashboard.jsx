import { useEffect, useMemo, useState } from 'react';
import useLiveQuote from '../hooks/useLiveQuote.js';
import NiftyStrategyChart from './NiftyStrategyChart.jsx';
import LivePositionPanel from './LivePositionPanel.jsx';
import PositionAlertBanner from './PositionAlertBanner.jsx';
import FyersLiveHandoff from './FyersLiveHandoff.jsx';
import { buildScalpTicket, evaluateScalpSetup } from '../engine/scalpStrategy.js';

const LEDGER_KEY = 'index-options-mentor-scalp-ledger-v1';

export default function ScalpMentorDashboard({
  snapshot,
  loading,
  liveError,
  position,
  positionMentor,
  alertsEnabled,
  history,
  settings,
  onReconnect,
  needsReconnect = false,
  onRetry,
  onTakeTrade,
  onExit,
  onStatusChange
}) {
  const liveQuote = useLiveQuote();
  const [candles, setCandles] = useState([]);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError] = useState('');
  const [manualLots, setManualLots] = useState(() => clampLots(settings?.defaultLots, settings?.lotCap));
  const sessionDate = snapshot?.market?.sessionDate || '';

  useEffect(() => {
    if (!position) setManualLots(current => clampLots(current || settings?.defaultLots, settings?.lotCap));
  }, [settings?.defaultLots, settings?.lotCap, position?.id]);

  useEffect(() => {
    if (!sessionDate) {
      setCandles([]);
      return undefined;
    }

    let cancelled = false;
    const load = async () => {
      setCandleLoading(current => current || candles.length === 0);
      try {
        const params = new URLSearchParams({
          symbol: 'NSE:NIFTY50-INDEX',
          resolution: '3',
          from: sessionDate,
          to: sessionDate
        });
        const response = await fetch(`/api/fyers/history?${params.toString()}`, { cache: 'no-store' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data?.s === 'error' || data?.error) {
          throw new Error(data?.message || data?.error || 'FYERS could not provide verified 3-minute candles.');
        }
        const rows = Array.isArray(data?.candles) ? data.candles : [];
        if (!cancelled) {
          if (rows.length) setCandles(rows);
          setCandleError(rows.length ? '' : 'No verified 3-minute candles returned; simulated entry is paused.');
        }
      } catch (error) {
        if (!cancelled) setCandleError(error?.message || '3-minute scalp candles are unavailable.');
      } finally {
        if (!cancelled) setCandleLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(load, 45000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionDate]);

  const quoteAt = Date.parse(liveQuote?.at || '');
  const isFreshQuote = Number.isFinite(quoteAt) && Date.now() - quoteAt < 12000 && Date.now() >= quoteAt - 2000;
  const liveSpot = isFreshQuote && Number(liveQuote?.nifty) > 0 ? Number(liveQuote.nifty) : Number(snapshot?.market?.spot);
  // A failed FYERS history request or snapshot must never enable a new scalp trade.
  const verifiedForEntry = !liveError && !candleError;
  const evaluation = useMemo(
    () => evaluateScalpSetup(verifiedForEntry ? snapshot : null, verifiedForEntry ? candles : [], liveSpot),
    [snapshot, candles, liveSpot, verifiedForEntry]
  );

  useEffect(() => {
    onStatusChange?.(evaluation);
  }, [evaluation?.eligible, evaluation?.score, evaluation?.side, evaluation?.reason, evaluation?.setupId]);

  useEffect(() => {
    if (settings?.scalpAutoOpen === false || position || !evaluation?.eligible || !evaluation?.setupId) return;
    const ledger = readJson(LEDGER_KEY, {});
    if (ledger[evaluation.setupId]) return;
    const ticket = buildScalpTicket(snapshot, evaluation, settings, 'MENTOR');
    if (!ticket) return;
    ledger[evaluation.setupId] = { openedAt: ticket.openedAt, side: ticket.side, score: ticket.score };
    pruneLedger(ledger);
    writeJson(LEDGER_KEY, ledger);
    onTakeTrade(ticket);
  }, [evaluation?.setupId, evaluation?.eligible, position?.id, settings?.scalpAutoOpen, settings?.defaultLots, settings?.lotCap]);

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
        <div className="alert-bar reconnect-alert scalp-reconnect">
          <span>{liveError} {needsReconnect ? 'FYERS login has expired.' : 'Market data is temporarily unavailable; entries are paused.'}</span>
          <button type="button" onClick={needsReconnect ? onReconnect : onRetry}>{needsReconnect ? 'Reconnect FYERS' : 'Retry market data'}</button>
        </div>
      )}

      <section className={`scalp-decision-card ${evaluation.eligible ? 'ready' : 'waiting'}`}>
        <div className="scalp-decision-top">
          <div>
            <div className="eyebrow">SCALP MENTOR · RESEARCH ONLY</div>
            <h1>{loading ? 'Reading scalp conditions…' : evaluation.eligible ? `${evaluation.side} scalp ready` : evaluation.manualEligible ? 'Manual scalp research available' : evaluation.blockers?.length ? 'Scalp entry blocked' : 'Wait for scalp trigger'}</h1>
            <p>{evaluation.reason}</p>
          </div>
          <div className={`scalp-score ${evaluation.eligible ? 'ready' : ''}`}>
            <span>SIGNAL SCORE</span>
            <strong>{Number.isFinite(evaluation.score) ? evaluation.score : '—'}</strong>
            <small>/100 · not entry approval</small>
          </div>
        </div>
        <div className={`scalp-entry-eligibility ${evaluation.eligible ? 'qualified' : 'blocked'}`} role="status" aria-live="polite">
          <div className="scalp-eligibility-head">
            <strong>{evaluation.eligible ? '✓ AUTOMATIC SCALP QUALIFIED' : evaluation.manualEligible ? 'AUTO ENTRY NOT QUALIFIED' : '⛔ ENTRY NOT QUALIFIED'}</strong>
            <span>{evaluation.eligible ? 'Signal + mandatory checks passed' : `${evaluation.blockers?.length || 0} unmet automatic ${evaluation.blockers?.length === 1 ? 'check' : 'checks'}`}</span>
          </div>
          {!evaluation.eligible && Array.isArray(evaluation.blockers) && evaluation.blockers.length > 0 && (
            <div className="scalp-eligibility-reasons">
              {evaluation.blockers.map(blocker => (
                <div className="scalp-eligibility-reason" key={blocker.id}>
                  <strong>{blocker.title}</strong>
                  <span>{blocker.detail}</span>
                </div>
              ))}
            </div>
          )}
          {!evaluation.eligible && <small>A high score alone never activates automatic BUY. Manual research has separate eligibility checks; assess the risk before any manual entry.</small>}
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

function readJson(key, fallback) {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
function clampLots(value, cap) {
  const max = Math.max(1, Number(cap) || 5);
  const parsed = Math.round(Number(value) || 1);
  return Math.max(1, Math.min(max, parsed));
}

function pruneLedger(ledger) {
  const keys = Object.keys(ledger);
  if (keys.length <= 160) return;
  keys.sort((a, b) => String(ledger[a]?.openedAt || '').localeCompare(String(ledger[b]?.openedAt || '')))
    .slice(0, keys.length - 160)
    .forEach(key => delete ledger[key]);
}
