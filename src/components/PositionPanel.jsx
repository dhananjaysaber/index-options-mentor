export default function PositionPanel({ position, onExit }) {
  if (!position) {
    return (
      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">POSITION</div>
            <h2>No simulated position</h2>
          </div>
        </div>
        <div className="empty-state">
          <p>When you press Take simulated trade, the dashboard mirrors the trade here while the real broker remains separate.</p>
        </div>
      </section>
    );
  }

  const pnl = (position.currentPrice - position.entry) * position.quantity;

  return (
    <section className="panel position-panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">POSITION</div>
          <h2>{position.symbol}</h2>
        </div>
        <span className="active-pill">OPEN</span>
      </div>

      <div className="ticket-grid">
        <div><span>Entry</span><strong>₹{position.entry.toFixed(2)}</strong></div>
        <div><span>Current</span><strong>₹{position.currentPrice.toFixed(2)}</strong></div>
        <div><span>Stop</span><strong>₹{position.stop.toFixed(2)}</strong></div>
        <div><span>Target</span><strong>₹{position.target.toFixed(2)}</strong></div>
        <div><span>Quantity</span><strong>{position.quantity}</strong></div>
        <div><span>Sim P&L</span><strong className={pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>₹{pnl.toFixed(0)}</strong></div>
      </div>

      <div className="mentor-note">
        <strong>Mentor status</strong>
        <p>
          {position.currentPrice <= position.stop
            ? 'Exit condition met: premium stop has been reached.'
            : position.currentPrice >= position.target
              ? 'Target condition reached. Review whether to exit or trail based on the underlying structure.'
              : 'Position remains inside the planned risk envelope. Do not react to every candle.'}
        </p>
      </div>

      <button className="danger-btn" onClick={onExit}>Exit simulated trade</button>
    </section>
  );
}
