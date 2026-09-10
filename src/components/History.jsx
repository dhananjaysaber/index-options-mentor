export default function History({ history }) {
  return (
    <section className="panel history-panel">
      <div className="panel-heading compact">
        <div>
          <div className="eyebrow">LEARNING LOOP</div>
          <h2>Trade history</h2>
        </div>
        <span className="muted">{history.length} trades</span>
      </div>

      {history.length === 0 ? (
        <div className="empty-state">
          <p>No simulated trades yet. Completed trades are stored in this browser for review.</p>
        </div>
      ) : (
        <div className="history-list">
          {history.map(trade => (
            <div className="history-row history-row-v06" key={trade.id}>
              <div className="history-main">
                <strong>{trade.side} · {trade.symbol}</strong>
                <span>{new Date(trade.closedAt).toLocaleString('en-IN')}</span>
              </div>
              <div><span>Score</span><strong>{trade.score ?? '—'}</strong></div>
              <div><span>Entry</span><strong>₹{Number(trade.entry).toFixed(2)}</strong></div>
              <div><span>Exit</span><strong>₹{Number(trade.exit).toFixed(2)}</strong></div>
              <div><span>R</span><strong className={Number(trade.rAchieved) >= 0 ? 'pnl-pos' : 'pnl-neg'}>{formatR(trade.rAchieved)}</strong></div>
              <div><span>P&amp;L</span><strong className={trade.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}>₹{Number(trade.pnl).toFixed(0)}</strong></div>
              <div className="history-reason"><span>Exit reason</span><strong>{humanReason(trade.exitReasonCode)}</strong></div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function formatR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function humanReason(code) {
  const map = {
    STRUCTURE_INVALIDATED: 'Hard stop / structure invalidated',
    STRATEGY_DETERIORATION: 'Strategy deterioration',
    TARGET_REACHED: 'Target reached',
    TARGET_APPROACHING: 'Target zone exit',
    MANUAL_EXIT: 'Manual exit',
    ONE_R_REACHED: 'Profit protected',
    STRUCTURE_WEAKENING: 'Structure weakening',
    STRUCTURE_INTACT: 'Manual exit while intact'
  };
  return map[code] || code || 'Manual exit';
}
