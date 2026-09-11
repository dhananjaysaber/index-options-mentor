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
        <div className="position-empty-left">
          <div className="eyebrow">POSITION</div>
          <h2>No simulated position</h2>
          <p>When you mirror a broker trade here, live P&amp;L and structural exit guidance stay visible.</p>
        </div>
        <div className="session-stat-row">
          <div><span>Trades today</span><strong>{todayTrades.length}</strong></div>
          <div><span>Wins</span><strong>{wins}</strong></div>
          <div><span>Losses</span><strong>{losses}</strong></div>
          <div><span>Realised sim P&amp;L</span><strong className={pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>₹{pnl.toFixed(0)}</strong></div>
        </div>
      </section>
    );
  }

  const currentUnderlying = Number(position.underlyingCurrent ?? snapshot?.market?.spot);
  const currentOption = Number(position.currentPrice);
  const pnl = (currentOption - position.entry) * position.quantity;
  const mentor = derivePositionMentor(position, snapshot, currentUnderlying);

  return (
    <aside className={`trade-focus-card position-mentor-card ${sticky ? 'sticky-trade' : ''} ${mentor.tone}`}>
      <div className="trade-focus-head">
        <div>
          <div className="eyebrow">POSITION MENTOR</div>
          <h2>{position.symbol}</h2>
        </div>
        <span className="simulation-pill open">OPEN</span>
      </div>

      <div className={`focus-action ${mentor.tone}`}>
        <small>CURRENT ACTION</small>
        <strong>{mentor.title}</strong>
        <span>{mentor.copy}</span>
      </div>

      <div className="position-r-strip runner-r-strip">
        <div><span>R now</span><strong className={mentor.rMultiple >= 0 ? 'pnl-pos' : 'pnl-neg'}>{formatR(mentor.rMultiple)}</strong></div>
        <div><span>Best R</span><strong className="pnl-pos">{formatR(mentor.bestR)}</strong></div>
        <div><span>Worst R</span><strong className={mentor.worstR < 0 ? 'pnl-neg' : ''}>{formatR(mentor.worstR)}</strong></div>
        <div><span>Sim P&amp;L</span><strong className={pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>₹{pnl.toFixed(0)}</strong></div>
        <div><span>NIFTY now</span><strong>{fmt(currentUnderlying)}</strong></div>
        <div><span>Option live</span><strong>₹{fmt(currentOption)}</strong></div>
      </div>

      <div className="trade-plan-grid position-plan-grid">
        <div><span>NIFTY entry</span><strong>{fmt(position.underlyingEntry)}</strong></div>
        <div><span>Structural stop</span><strong>{fmt(position.underlyingStop)}</strong></div>
        <div><span>Original target</span><strong>{fmt(position.underlyingTarget)}</strong><small className="runner-note">Milestone, not auto-exit</small></div>
        <div><span>Entry score</span><strong>{position.score}/100</strong></div>
        <div><span>Current score</span><strong>{mentor.currentScore}/100</strong></div>
        <div><span>Score change</span><strong className={mentor.scoreDrop >= 15 ? 'pnl-neg' : ''}>{mentor.scoreDrop > 0 ? `-${Math.round(mentor.scoreDrop)}` : '0'}</strong></div>
        <div><span>Option entry</span><strong>₹{fmt(position.entry)}</strong></div>
        <div><span>Lots</span><strong>{position.lots}</strong></div>
        <div><span>Qty</span><strong>{position.quantity}</strong></div>
        <div><span>Planned R:R</span><strong>1 : {Number(position.rr).toFixed(1)}</strong></div>
      </div>

      <div className={`position-guidance ${mentor.tone}`}>
        <span>MENTOR REASONING</span>
        <strong>{mentor.reason}</strong>
        <small>The original structural stop remains the hard invalidation. Once +1R is reached, the Mentor manages the trade as a runner rather than forcing an automatic target exit.</small>
      </div>

      <button
        className={`position-exit-button ${mentor.alertLevel === 'exit' ? 'urgent' : ''}`}
        onClick={() => onExit({
          mentorState: mentor.title,
          reasonCode: mentor.reasonCode,
          reason: mentor.reason,
          rMultiple: mentor.rMultiple
        })}
      >
        {mentor.alertLevel === 'exit' ? 'EXIT SIMULATED POSITION NOW' : 'EXIT SIMULATED TRADE'}
      </button>
    </aside>
  );
}
