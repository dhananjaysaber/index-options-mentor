export default function History({ history }) {
  const displayHistory = dedupeHistory(history);

  return (
    <section className="panel history-panel history-panel-v2">
      <div className="panel-heading compact">
        <div><div className="eyebrow">LEARNING LOOP</div><h2>Trade history</h2></div>
        <span className="muted">{displayHistory.length} trades</span>
      </div>

      {displayHistory.length === 0 ? (
        <div className="empty-state"><p>No completed trades are available yet. Permanent Google Sheets history will appear here after it syncs.</p></div>
      ) : (
        <>
          <div className="history-list history-list-v2">
            {displayHistory.map(trade => (
              <article className="history-card-v2" key={trade.id || stableHistoryKey(trade)}>
                <div className="history-card-head">
                  <div><span className={`history-tier tier-${String(trade.strategyTier || 'legacy').toLowerCase()}`}>{trade.strategyTierLabel || trade.strategyTier || 'Legacy trade'}</span><strong>{trade.side} · {trade.symbol}</strong><small>{trade.initiatedBy ? `Opened by ${trade.initiatedBy}` : 'Earlier simulation'} · {formatDateTime(trade.openedAt)}</small></div>
                  <div className={`history-pnl ${Number(trade.pnl) >= 0 ? 'positive' : 'negative'}`}><span>P&amp;L</span><strong>₹{formatMoney(trade.pnl)}</strong><small>{formatR(trade.rAchieved)}</small></div>
                </div>

                <div className="history-metrics-v2">
                  <Metric label="Entry score" value={trade.score ?? '—'} />
                  <Metric label="Entry gates" value={trade.entryMandatoryPassCount != null ? `${trade.entryMandatoryPassCount}/5` : '—'} />
                  <Metric label="Entry confirms" value={trade.entryConfirmationPassCount != null ? `${trade.entryConfirmationPassCount}/8` : '—'} />
                  <Metric label="Entry" value={`₹${formatMoney(trade.entry)}`} />
                  <Metric label="Exit" value={`₹${formatMoney(trade.exit)}`} />
                  <Metric label="Best R" value={formatR(trade.bestR)} tone={Number(trade.bestR) > 0 ? 'positive' : ''} />
                  <Metric label="Worst R" value={formatR(trade.worstR)} tone={Number(trade.worstR) < 0 ? 'negative' : ''} />
                  <Metric label="Held" value={trade.heldMinutes != null ? `${trade.heldMinutes} min` : '—'} />
                </div>

                <div className="history-lifecycle-v2">
                  <div><span>Opened</span><strong>{formatDateTime(trade.openedAt)}</strong></div>
                  <div><span>Closed</span><strong>{formatDateTime(trade.closedAt)}</strong></div>
                  <div><span>Closed by</span><strong>{trade.closedBy || 'USER / LEGACY'}</strong></div>
                  <div><span>Exit reason</span><strong>{humanReason(trade.exitReasonCode)}</strong></div>
                </div>

                {(trade.mentorSuggestionAtEntry || trade.mentorSuggestionAtExit) && (
                  <div className="history-mentor-notes">
                    {trade.mentorSuggestionAtEntry && <p><span>Mentor at entry</span>{trade.mentorSuggestionAtEntry}</p>}
                    {trade.mentorSuggestionAtExit && <p><span>Mentor at exit</span>{trade.mentorSuggestionAtExit}</p>}
                  </div>
                )}
              </article>
            ))}
          </div>
          <p className="history-storage-note">Permanent journal: completed trades are restored from Google Sheets; browser storage remains the fast local cache. Full trade JSON and journey checkpoints preserve the detailed Mentor context for later analysis.</p>
        </>
      )}
    </section>
  );
}

function dedupeHistory(history) {
  const rows = Array.isArray(history) ? history : [];
  const map = new Map();

  for (const trade of rows) {
    if (!trade) continue;
    const key = stableHistoryKey(trade);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, trade);
      continue;
    }
    map.set(key, richerTrade(existing, trade));
  }

  return [...map.values()].sort((a, b) => {
    const aTime = new Date(a.closedAt || a.openedAt || 0).getTime();
    const bTime = new Date(b.closedAt || b.openedAt || 0).getTime();
    return bTime - aTime;
  });
}

function stableHistoryKey(trade) {
  if (trade?.id) {
    const signature = historySignature(trade);
    return signature ? `sig:${signature}` : `id:${trade.id}`;
  }
  return `sig:${historySignature(trade) || Math.random()}`;
}

function historySignature(trade) {
  const symbol = String(trade?.symbol || '').trim();
  const opened = normaliseTime(trade?.openedAt);
  const closed = normaliseTime(trade?.closedAt);
  if (!symbol || !opened || !closed) return '';
  return [
    symbol,
    opened,
    closed,
    numberKey(trade?.entry),
    numberKey(trade?.exit),
    String(trade?.side || '')
  ].join('|');
}

function normaliseTime(value) {
  if (!value) return '';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? String(time) : String(value);
}

function numberKey(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(4) : '';
}

function richerTrade(a, b) {
  const score = row => Object.values(row || {}).filter(value => value !== null && value !== undefined && value !== '').length;
  const richer = score(b) >= score(a) ? b : a;
  const other = richer === b ? a : b;
  return { ...other, ...richer };
}

function Metric({ label, value, tone = '' }) { return <div><span>{label}</span><strong className={tone}>{value}</strong></div>; }
function formatMoney(value) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'; }
function formatR(value) { const n = Number(value); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '—'; }
function formatDateTime(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function humanReason(code) {
  const map = {
    STRUCTURE_INVALIDATED: 'Hard stop / structure invalidated',
    STRATEGY_DETERIORATION: 'Strategy deterioration',
    PROFIT_PROTECTION_EXIT: 'Runner profit protection',
    TARGET_REACHED: 'Legacy target exit',
    TARGET_APPROACHING: 'Legacy target zone exit',
    MANUAL_EXIT: 'Manual exit',
    ONE_R_REACHED: 'Legacy 1R protection',
    RUNNER_HOLD: 'Manual exit while runner intact',
    RUNNER_PULLBACK: 'Manual exit during runner pullback',
    APPROACHING_ONE_R: 'Manual exit approaching 1R',
    STRUCTURE_WEAKENING: 'Structure weakening',
    STRUCTURE_INTACT: 'Manual exit while intact'
  };
  return map[code] || code || 'Manual exit';
}
