import { useState } from 'react';
import { explainTrade } from '../services/researchAnalysis.js';
import { tradeSource } from '../services/journalFilters.js';
import { countedTrades, resultExclusion } from '../engine/researchHours.js';

export default function History({ history }) {
  const [filter, setFilter] = useState('all');
  const allHistory = dedupeHistory(history);
  const displayHistory = allHistory.filter(trade => filter === 'all' ? true : filter === 'scalp' ? isScalpTrade(trade) : !isScalpTrade(trade));
  const summary = summariseHistory(displayHistory);

  return (
    <section className="panel history-panel history-panel-v2">
      <div className="panel-heading compact">
        <div><div className="eyebrow">LEARNING LOOP</div><h2>Trade history</h2></div>
        <span className="muted">{displayHistory.length} trades</span>
      </div>

      <div className="history-filter-tabs" role="group" aria-label="Trade journal strategy filter">
        <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
        <button type="button" className={filter === 'core' ? 'active' : ''} onClick={() => setFilter('core')}>13-point</button>
        <button type="button" className={filter === 'scalp' ? 'active' : ''} onClick={() => setFilter('scalp')}>Scalp</button>
      </div>

      <div className="history-summary-grid" aria-label="Trade journal summary">
        <SummaryMetric label="Total trades" value={summary.total} />
        <SummaryMetric label="Net P&L" value={`₹${formatMoney(summary.pnl)}`} tone={summary.pnl >= 0 ? 'positive' : 'negative'} />
        <SummaryMetric label="Wins" value={summary.wins} tone="positive" />
        <SummaryMetric label="Losses" value={summary.losses} tone="negative" />
        <SummaryMetric label="Win rate" value={`${summary.winRate.toFixed(0)}%`} />
        <SummaryMetric label="Avg R" value={formatR(summary.avgR)} tone={summary.avgR >= 0 ? 'positive' : 'negative'} />
      </div>

      {displayHistory.length > summary.total && <p className="history-excluded-note" role="note">{displayHistory.length - summary.total} research {displayHistory.length - summary.total === 1 ? 'trade is' : 'trades are'} not counted in these totals (carried overnight or missed close). Saved records are not changed.</p>}

      <div className="premium-history-columns" aria-hidden="true"><span>Strategy / contract</span><span>Entry / exit</span><span>Quantity / source</span><span>Profit / loss</span><span>Details</span></div>
      {displayHistory.length === 0 ? (
        <div className="empty-state"><p>No completed trades are available yet. Saved journal history will appear here after it syncs.</p></div>
      ) : (
        <>
          <div className="history-list history-list-v2">
            {displayHistory.map(trade => (
              <details className="history-card-v2 history-card-expandable" key={trade.id || stableHistoryKey(trade)}>
                <summary className="history-card-summary">
                  <div className="history-card-head">
                    <div><span className={`history-tier tier-${String(trade.strategyTier || 'legacy').toLowerCase()}`}>{trade.strategyTierLabel || trade.strategyTier || 'Legacy trade'}</span><strong>{trade.side} · {trade.symbol}</strong><small>{trade.initiatedBy ? `Opened by ${trade.initiatedBy}` : 'Earlier simulation'} · {formatDateTime(trade.openedAt)}</small></div>
                    {resultExclusion(trade)
                      ? <div className="history-pnl excluded"><span>{resultExclusion(trade)}</span><strong>Not counted</strong>{Number.isFinite(trade.pnl) && <small>Saved ₹{formatMoney(trade.pnl)} · {formatR(trade.rAchieved)}</small>}</div>
                      : <div className={`history-pnl ${Number(trade.pnl) >= 0 ? 'positive' : 'negative'}`}><span>P&amp;L</span><strong>₹{formatMoney(trade.pnl)}</strong><small>{formatR(trade.rAchieved)}</small></div>}
                  </div>
                  <div className="premium-history-prices"><span>₹{formatMoney(trade.entry)}</span><small>→ {resultExclusion(trade) === 'Missed close' ? 'no exit result' : `₹${formatMoney(trade.exit)}`}</small></div>
                  <div className="premium-history-quantity"><span>{trade.quantity ?? '—'} qty</span><small>{tradeSource(trade).toUpperCase()} · {trade.executionMode === 'LIVE' || trade.mode === 'LIVE' ? 'REAL' : 'PAPER'}</small></div>
                  <div className="history-card-open-hint"><span>View position details</span><i aria-hidden="true" /></div>
                </summary>

                <div className="history-card-details">
                  <div className="history-metrics-v2">
                    {isScalpTrade(trade) ? (
                      <>
                        <Metric label="Entry method" value={trade.entryMethod || (trade.initiatedBy === 'MENTOR' ? 'AUTO' : 'MANUAL')} />
                        <Metric label="Scalp score" value={trade.scalpScoreAtEntry ?? trade.score ?? '—'} />
                        <Metric label="Checks" value={trade.scalpChecksPassCount != null ? `${trade.scalpChecksPassCount}/${trade.scalpChecksTotal || 7}` : '—'} />
                        <Metric label="Auto-qualified" value={trade.scalpAutoEligibleAtEntry === true ? 'YES' : trade.scalpAutoEligibleAtEntry === false ? 'NO' : '—'} />
                        <Metric label="3m trigger" value={formatNumber(trade.scalpTrigger)} />
                        <Metric label="NIFTY stop" value={formatNumber(trade.underlyingStop)} />
                        <Metric label="NIFTY target" value={formatNumber(trade.underlyingTarget)} />
                        <Metric label="3m body" value={formatPercent01(trade.scalpBodyRatioAtEntry)} />
                        <Metric label="Extension" value={formatNumber(trade.scalpExtensionAtEntry)} />
                        <Metric label="Entry" value={`₹${formatMoney(trade.entry)}`} />
                        <Metric label={resultExclusion(trade) === 'Missed close' ? 'Last price seen · not an exit' : 'Exit'} value={`₹${formatMoney(trade.exit)}`} />
                        <Metric label="Held" value={trade.heldMinutes != null ? `${trade.heldMinutes} min` : '—'} />
                      </>
                    ) : (
                      <>
                        <Metric label="Entry score" value={trade.score ?? '—'} />
                        <Metric label="Entry gates" value={trade.entryMandatoryPassCount != null ? `${trade.entryMandatoryPassCount}/5` : '—'} />
                        <Metric label="Entry confirms" value={trade.entryConfirmationPassCount != null ? `${trade.entryConfirmationPassCount}/8` : '—'} />
                        <Metric label="Entry" value={`₹${formatMoney(trade.entry)}`} />
                        <Metric label={resultExclusion(trade) === 'Missed close' ? 'Last price seen · not an exit' : 'Exit'} value={`₹${formatMoney(trade.exit)}`} />
                        <Metric label="Held" value={trade.heldMinutes != null ? `${trade.heldMinutes} min` : '—'} />
                      </>
                    )}
                    {trade.peakUnrealizedPnl != null && <Metric label="Peak observed profit" value={`₹${formatMoney(trade.peakUnrealizedPnl)}`} tone="positive" />}
                    {trade.maxProfitGivebackPnl != null && <Metric label="Profit given back" value={`₹${formatMoney(trade.maxProfitGivebackPnl)}`} />}
                    {(trade.coreOptionTrailFloorPnlAtExit != null || trade.scalpOptionTrailFloorPnlAtExit != null) &&
                      <Metric label="Runner / profit floor at exit" value={`₹${formatMoney(trade.coreOptionTrailFloorPnlAtExit ?? trade.scalpOptionTrailFloorPnlAtExit)}`} />}
                    {trade.coreTargetIndexTrailStopAtExit != null &&
                      <Metric label="Protected NIFTY stop at exit" value={formatNumber(trade.coreTargetIndexTrailStopAtExit)} />}
                    {trade.lastUnderlyingQuoteAtExit &&
                      <Metric label="NIFTY quote at exit" value={formatDateTime(trade.lastUnderlyingQuoteAtExit)} />}
                    {trade.lastOptionQuoteAtExit && <Metric label="Option quote at exit" value={formatDateTime(trade.lastOptionQuoteAtExit)} />}
                    {trade.optionExitQuoteAgeMs != null &&
                      <Metric label="Quote age at exit" value={`${Math.max(0, Math.round(Number(trade.optionExitQuoteAgeMs) / 1000))} sec`} />}
                    <Metric label="Best R" value={formatR(trade.bestR)} tone={Number(trade.bestR) > 0 ? 'positive' : ''} />
                    <Metric label="Worst R" value={formatR(trade.worstR)} tone={Number(trade.worstR) < 0 ? 'negative' : ''} />
                  </div>

                  <div className="history-lifecycle-v2">
                    <div><span>Opened</span><strong>{formatDateTime(trade.openedAt)}</strong></div>
                    <div><span>Closed</span><strong>{formatDateTime(trade.closedAt)}</strong></div>
                    <div><span>Closed by</span><strong>{trade.closedBy || 'USER / LEGACY'}{trade.exitMethod ? ` · ${trade.exitMethod}` : ''}</strong></div>
                    <div><span>Exit reason</span><strong>{humanReason(trade.exitReasonCode)}</strong></div>
                    {isScalpTrade(trade) && <div><span>Exit scalp score</span><strong>{trade.scalpScoreAtExit ?? '—'}</strong></div>}
                    {isScalpTrade(trade) && <div><span>Exit checks</span><strong>{trade.scalpChecksPassAtExit != null ? `${trade.scalpChecksPassAtExit}/7` : '—'}</strong></div>}
                  </div>

                  {(trade.mentorSuggestionAtEntry || trade.mentorSuggestionAtExit) && (
                    <div className="history-mentor-notes">
                      {trade.mentorSuggestionAtEntry && <p><span>Mentor at entry</span>{trade.mentorSuggestionAtEntry}</p>}
                      {trade.mentorSuggestionAtExit && <p><span>Mentor at exit</span>{trade.mentorSuggestionAtExit}</p>}
                    </div>
                  )}
                  <TradeAnalysisPanel trade={trade} />
                </div>
              </details>
            ))}
          </div>
          <p className="history-storage-note">Saved journal · completed trades and their detailed entry/exit context are kept for later analysis.</p>
        </>
      )}
    </section>
  );
}

function TradeAnalysisPanel({ trade }) {
  const [open, setOpen] = useState(false);
  const analysis = explainTrade(trade);

  return (
    <div className="history-trade-analysis">
      <button type="button" onClick={() => setOpen(value => !value)}>
        {open ? 'Hide analysis' : 'Analyse trade'}
      </button>
      {open && (
        <div className="history-analysis-copy">
          <strong>{analysis.cohortLabel}</strong>
          <ul>
            {analysis.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function isScalpTrade(trade) {
  return trade?.strategyFamily === 'SCALP' || trade?.strategyTier === 'SCALP' || /scalp/i.test(String(trade?.strategyTierLabel || ''));
}

function summariseHistory(allRows) {
  const rows = countedTrades(allRows);
  const total = rows.length;
  const pnl = rows.reduce((sum, trade) => sum + (Number(trade?.pnl) || 0), 0);
  const wins = rows.filter(trade => Number(trade?.pnl) > 0).length;
  const losses = rows.filter(trade => Number(trade?.pnl) < 0).length;
  const rValues = rows.map(trade => Number(trade?.rAchieved)).filter(Number.isFinite);
  const avgR = rValues.length ? rValues.reduce((sum, value) => sum + value, 0) / rValues.length : 0;
  return { total, pnl, wins, losses, winRate: total ? (wins / total) * 100 : 0, avgR };
}

function SummaryMetric({ label, value, tone = '' }) {
  return <div className={`history-summary-card ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

export function dedupeHistory(history) {
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
function formatNumber(value) { const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'; }
function formatPercent01(value) { const n = Number(value); return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'; }
function formatR(value) { const n = Number(value); return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}R` : '—'; }
function formatDateTime(value) { if (!value) return '—'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }

function humanReason(code) {
  const map = {
    STRUCTURE_INVALIDATED: 'Hard stop / structure invalidated',
    MISSED_CLOSE: 'Missed close · no result counted',
    STRATEGY_DETERIORATION: 'Strategy deterioration',
    PROFIT_PROTECTION_EXIT: 'Runner profit protection',
    CORE_OPTION_PROFIT_TRAIL: '13-Point runner option-profit trailing exit',
    CORE_TARGET_INDEX_TRAIL: '13-Point target-based NIFTY trailing stop',
    SCALP_OPTION_PROFIT_TRAIL: 'Scalp option-profit trailing exit',
    SCALP_TRAILING_STOP: 'Scalp index-R trailing exit',
    TARGET_REACHED: 'Legacy target exit',
    TARGET_APPROACHING: 'Legacy target zone exit',
    MANUAL_EXIT: 'Manual exit',
    ONE_R_REACHED: 'Legacy 1R protection',
    RUNNER_HOLD: 'Manual exit while runner intact',
    RUNNER_PULLBACK: 'Manual exit during runner pullback',
    APPROACHING_ONE_R: 'Manual exit approaching 1R',
    STRUCTURE_WEAKENING: 'Structure weakening',
    STRUCTURE_INTACT: 'Manual exit while intact',
    STRUCTURAL_TARGET_REACHED: 'Structural target reached',
    RESEARCH_1_5R_EXIT: 'Research +1.5R exit',
    RESEARCH_TIME_EXIT: 'Research time exit',
    SESSION_EXIT: 'Session close exit',
    SCALP_STOP: 'Scalp hard stop',
    SCALP_TARGET: 'Scalp +1R target',
    SCALP_TIME_EXIT: 'Scalp time exit',
    SCALP_CONTEXT_EXIT: 'Scalp context exit',
    SCALP_PROFIT_PROTECT: 'Scalp profit protection',
    SCALP_WEAKENING: 'Scalp weakening',
    SCALP_HOLD: 'Scalp hold'
  };
  return map[code] || code || 'Manual exit';
}
