import { derivePositionMentor, deriveScalpPositionMentor, fmt, formatR } from '../engine/positionMentor.js';
import useLiveQuote from '../hooks/useLiveQuote.js';

export default function LivePositionPanel({ position, onExit, history = [], snapshot = null, sticky = false }) {
  const liveQuote = useLiveQuote();
  if (!position) {
    const today = new Date().toDateString();
    const todayTrades = history.filter(t => new Date(t.closedAt).toDateString() === today);
    const pnl = todayTrades.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
    const wins = todayTrades.filter(t => Number(t.pnl) > 0).length;
    const losses = todayTrades.filter(t => Number(t.pnl) < 0).length;
    return (
      <section className="panel compact-position-card">
        <div className="position-empty-left"><div className="eyebrow">POSITION</div><h2>No simulated position</h2><p>The Mentor can open eligible research positions automatically, or you can open one manually from the trade box.</p></div>
        <div className="session-stat-row"><div><span>Trades today</span><strong>{todayTrades.length}</strong></div><div><span>Wins</span><strong>{wins}</strong></div><div><span>Losses</span><strong>{losses}</strong></div><div><span>Realised sim P&amp;L</span><strong className={pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>₹{pnl.toFixed(0)}</strong></div></div>
      </section>
    );
  }

  const liveUnderlying = numberOrNull(liveQuote?.nifty);
  const liveOption = liveQuote?.optionSymbol === position.symbol ? numberOrNull(liveQuote?.optionPrice) : null;
  const currentUnderlying = liveUnderlying ?? numberOrNull(position.underlyingCurrent ?? snapshot?.market?.spot);
  const currentOption = liveOption ?? numberOrNull(position.currentPrice);
  const entryOption = numberOrNull(position.entry);
  const quantity = Number(position.quantity) || 0;
  const livePnl = currentOption != null && entryOption != null ? (currentOption - entryOption) * quantity : null;
  const pnlPct = livePnl != null && entryOption > 0 && quantity > 0 ? (livePnl / (entryOption * quantity)) * 100 : null;
  const isScalp = position?.strategyFamily === 'SCALP';
  const mentor = isScalp
    ? deriveScalpPositionMentor(position, snapshot, currentUnderlying ?? Number(position.underlyingEntry))
    : derivePositionMentor(position, snapshot, currentUnderlying ?? Number(position.underlyingEntry));
  const pnlTone = livePnl == null ? '' : livePnl >= 0 ? 'pnl-pos' : 'pnl-neg';
  const positionLabel = isScalp ? 'SCALP RESEARCH' : position.manualResearch ? 'MANUAL RESEARCH' : (position.strategyTierLabel || position.strategyTier || 'SIMULATION');

  return (
    <aside className={`trade-focus-card position-mentor-card position-essential-card ${sticky ? 'sticky-trade' : ''} ${mentor.tone}`}>
      <div className="trade-focus-head position-essential-head">
        <div>
          <div className="eyebrow">OPEN POSITION · {positionLabel}</div>
          <h2>{position.symbol}</h2>
          <small>{position.side} · {position.lots} lot{Number(position.lots) === 1 ? '' : 's'} · {position.quantity} qty · opened {formatOpened(position.openedAt)} · {formatDuration(position.openedAt)}</small>
        </div>
        <span className="simulation-pill open">LIVE</span>
      </div>

      <div className="position-live-hero">
        <div className={`position-pnl-hero ${livePnl == null ? '' : livePnl >= 0 ? 'positive' : 'negative'}`}>
          <span>LIVE SIM P&amp;L</span>
          <strong className={pnlTone}>{livePnl == null ? '—' : `${livePnl >= 0 ? '+' : '-'}₹${Math.abs(livePnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}</strong>
          <small>{pnlPct == null ? 'Waiting for live option quote' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% · Entry ₹${fmt(entryOption)} → Live ₹${fmt(currentOption)}`}</small>
        </div>

        <div className="position-r-hero">
          <span>R NOW</span>
          <strong className={mentor.rMultiple >= 0 ? 'pnl-pos' : 'pnl-neg'}>{formatR(mentor.rMultiple)}</strong>
          <small>Best {formatR(Math.max(Number(position.bestR) || 0, mentor.rMultiple))} · Worst {formatR(Math.min(Number(position.worstR) || 0, mentor.rMultiple))}</small>
        </div>

        <div className={`position-action-hero ${mentor.tone}`}>
          <span>MENTOR ACTION</span>
          <strong>{mentor.shortTitle || mentor.title}</strong>
          <small>{mentor.reason}</small>
        </div>
      </div>

      {!isScalp && (
        <div className={`scalp-option-trail-indicator ${position.coreOptionTrailingActive ? 'armed' : 'pending'}`}
             role="status" aria-label="13-Point runner simulated option profit trailing protection">
          <div className="scalp-option-trail-heading">
            <span>13-POINT RUNNER TRAIL · PAPER</span>
            <strong>{position.coreOptionTrailingActive
              ? `ARMED · floor +₹${fmt(position.coreOptionTrailingFloorPnl)}`
              : 'WAITING · activates after +5% option premium'}</strong>
          </div>
          <small>{position.coreOptionTrailingActive
            ? `Peak observed gross profit +₹${fmt(Math.max(0, Number(position.peakUnrealizedPnl) || 0))} · Retains ${Math.round(100 * Number(position.coreOptionTrailKeepRatio || .35))}% of peak as the move extends · No broker stop order`
            : 'Original NIFTY structural stop still applies · Runner profit trail has not armed yet'}</small>
          <div className={`runner-index-trail-status ${position.coreTargetIndexTrailActive ? 'armed' : 'waiting'}`} role="status">
            <span>TARGET-BASED NIFTY TRAIL</span>
            <strong>{position.coreTargetIndexTrailActive
              ? `ARMED · NIFTY stop ${fmt(position.coreTargetIndexTrailStop)}`
              : `WAITING · arms beyond ${fmt(position.coreTargetIndexTrailArmAtNifty)}`}</strong>
            <small>{position.coreTargetIndexTrailActive
              ? 'Original target is now protected; stop climbs 0.50R behind the best NIFTY move · Paper only'
              : 'Target is a milestone, not an automatic exit. Allows another 0.25R beyond target before raising the stop'}</small>
          </div>
        </div>
      )}

      {isScalp && (
        <div className={`scalp-option-trail-indicator ${position.optionTrailingActive ? 'armed' : 'pending'}`}
             role="status" aria-label="Simulated Scalp option profit trailing protection">
          <div className="scalp-option-trail-heading">
            <span>OPTION PROFIT TRAIL · PAPER</span>
            <strong>{position.optionTrailingActive
              ? `ARMED · floor +₹${fmt(position.optionTrailingFloorPnl)}`
              : 'WAITING · activates after +3% option premium'}</strong>
          </div>
          <small>{position.optionTrailingActive
            ? `Peak observed gross profit +₹${fmt(Math.max(0, Number(position.peakUnrealizedPnl) || 0))} · Retains at least 50% of peak · No broker stop order`
            : 'NIFTY structural stop remains active · Option-premium trail has not armed yet'}</small>
        </div>
      )}

      <div className={`position-guidance position-guidance-compact ${mentor.tone}`}>
        <span>WHAT MATTERS NOW</span>
        <strong>{mentor.copy}</strong>
        <small>Hard stop {fmt(position.underlyingStop)} · Planned R:R 1:{Number(position.rr || 0).toFixed(1)} · {isScalp ? 'Scalp research' : position.initiatedBy === 'MENTOR' ? 'Mentor opened' : 'User opened'}</small>
      </div>

      <div className="position-essential-grid">
        <Essential label="Option live" value={currentOption == null ? '—' : `₹${fmt(currentOption)}`} emphasis />
        <Essential label="Option entry" value={entryOption == null ? '—' : `₹${fmt(entryOption)}`} />
        <Essential label="NIFTY now" value={currentUnderlying == null ? '—' : fmt(currentUnderlying)} emphasis />
        <Essential label="NIFTY entry" value={fmt(position.underlyingEntry)} />
        <Essential label="Hard stop" value={fmt(position.underlyingStop)} tone="danger" />
        <Essential label="Target / milestone" value={fmt(position.underlyingTarget)} tone="positive" />
        <Essential label={isScalp ? 'Scalp score' : 'Score'} value={isScalp ? `${position.score ?? '—'}/100` : `${position.score ?? '—'} → ${mentor.currentScore ?? '—'}`} />
        <Essential label={isScalp ? 'Scalp plan' : 'Live gates'} value={isScalp ? `3m · ${position.scalpMaxHoldMinutes || 12}m max` : `${position.currentMandatoryPassCount ?? '—'}/5 · ${position.currentConfirmationPassCount ?? '—'}/8`} />
      </div>

      <button className={`position-exit-button ${mentor.alertLevel === 'exit' ? 'urgent' : ''}`} onClick={() => onExit({ mentorState: mentor.title, reasonCode: mentor.reasonCode, reason: mentor.reason, rMultiple: mentor.rMultiple, closedBy: 'USER' })}>{mentor.alertLevel === 'exit' ? 'EXIT SIMULATED POSITION NOW' : 'EXIT SIMULATED TRADE'}</button>
    </aside>
  );
}

function Essential({ label, value, tone = '', emphasis = false }) {
  return <div className={`${emphasis ? 'emphasis' : ''} ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatOpened(value) {
  if (!value) return 'time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'time unavailable' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(value) {
  if (!value) return 'duration unavailable';
  const opened = new Date(value).getTime();
  if (!Number.isFinite(opened)) return 'duration unavailable';
  const totalMinutes = Math.max(0, Math.floor((Date.now() - opened) / 60000));
  if (totalMinutes < 60) return `${totalMinutes} min open`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m open`;
}
