import { derivePositionMentor, fmt, formatR } from '../engine/positionMentor.js';

export default function LivePositionPanel({ position, onExit, history = [], snapshot = null, sticky = false }) {
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

  const currentUnderlying = numberOrNull(position.underlyingCurrent ?? snapshot?.market?.spot);
  const currentOption = numberOrNull(position.currentPrice);
  const entryOption = numberOrNull(position.entry);
  const quantity = Number(position.quantity) || 0;
  const livePnl = currentOption != null && entryOption != null ? (currentOption - entryOption) * quantity : null;
  const pnlPct = livePnl != null && entryOption > 0 && quantity > 0 ? (livePnl / (entryOption * quantity)) * 100 : null;
  const mentor = derivePositionMentor(position, snapshot, currentUnderlying ?? Number(position.underlyingEntry));
  const pnlTone = livePnl == null ? '' : livePnl >= 0 ? 'pnl-pos' : 'pnl-neg';

  return (
    <aside className={`trade-focus-card position-mentor-card position-essential-card ${sticky ? 'sticky-trade' : ''} ${mentor.tone}`}>
      <div className="trade-focus-head position-essential-head">
        <div>
          <div className="eyebrow">OPEN POSITION</div>
          <h2>{position.symbol}</h2>
          <small>{position.side} · {position.lots} lot{Number(position.lots) === 1 ? '' : 's'} · {position.quantity} qty · opened {formatOpened(position.openedAt)}</small>
        </div>
        <span className="simulation-pill open">OPEN</span>
      </div>

      <div className="position-live-hero">
        <div className={`position-pnl-hero ${livePnl == null ? '' : livePnl >= 0 ? 'positive' : 'negative'}`}>
          <span>LIVE SIM P&amp;L</span>
          <strong className={pnlTone}>{livePnl == null ? '—' : `${livePnl >= 0 ? '+' : '-'}₹${Math.abs(livePnl).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}</strong>
          <small>{pnlPct == null ? 'Waiting for live option quote' : `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% on option premium`}</small>
        </div>
        <div className="position-r-hero">
          <span>R NOW</span>
          <strong className={mentor.rMultiple >= 0 ? 'pnl-pos' : 'pnl-neg'}>{formatR(mentor.rMultiple)}</strong>
          <small>Best {formatR(mentor.bestR)}</small>
        </div>
        <div className={`position-action-hero ${mentor.tone}`}>
          <span>MENTOR ACTION</span>
          <strong>{mentor.shortTitle || mentor.title}</strong>
          <small>{mentor.reason}</small>
        </div>
      </div>

      <div className="position-essential-grid">
        <Essential label="Option live" value={currentOption == null ? '—' : `₹${fmt(currentOption)}`} emphasis />
        <Essential label="Option entry" value={entryOption == null ? '—' : `₹${fmt(entryOption)}`} />
        <Essential label="NIFTY now" value={currentUnderlying == null ? '—' : fmt(currentUnderlying)} emphasis />
        <Essential label="NIFTY entry" value={fmt(position.underlyingEntry)} />
        <Essential label="Hard stop" value={fmt(position.underlyingStop)} tone="danger" />
        <Essential label="Target / milestone" value={fmt(position.underlyingTarget)} tone="positive" />
        <Essential label="Entry → current score" value={`${position.score ?? '—'} → ${mentor.currentScore ?? '—'}`} />
        <Essential label="Live gates" value={`${position.currentMandatoryPassCount ?? '—'}/5 · ${position.currentConfirmationPassCount ?? '—'}/8`} />
      </div>

      <div className={`position-guidance position-guidance-compact ${mentor.tone}`}>
        <span>WHAT MATTERS NOW</span>
        <strong>{mentor.copy}</strong>
        <small>Hard structural invalidation: {fmt(position.underlyingStop)} · Planned R:R 1:{Number(position.rr || 0).toFixed(1)} · {position.initiatedBy === 'MENTOR' ? 'Mentor opened' : 'User opened'}</small>
      </div>

      <button className={`position-exit-button ${mentor.alertLevel === 'exit' ? 'urgent' : ''}`} onClick={() => onExit({ mentorState: mentor.title, reasonCode: mentor.reasonCode, reason: mentor.reason, rMultiple: mentor.rMultiple, closedBy: 'USER' })}>{mentor.alertLevel === 'exit' ? 'EXIT SIMULATED POSITION NOW' : 'EXIT SIMULATED TRADE'}</button>
    </aside>
  );
}

function Essential({ label, value, tone = '', emphasis = false }) {
  return <div className={`${emphasis ? 'emphasis' : ''} ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatOpened(value) {
  if (!value) return 'time unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'time unavailable' : date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
