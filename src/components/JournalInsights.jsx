// Read-only summary of the trades currently shown in the journal.
import { buildCohortAnalysis } from '../services/researchAnalysis.js';
import { countedTrades } from '../engine/researchHours.js';

const rupees = value => `${value < 0 ? '−' : '+'}₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const known = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const show = (value, make = String) => (known(value) ? make(Number(value)) : '—');

export default function JournalInsights({ trades, onNavigate }) {
  const latest = countedTrades(trades).find(trade => trade.closedAt) || null;
  const groups = buildCohortAnalysis(trades).filter(group => group.stats.total);
  const largest = Math.max(1, ...groups.map(group => Math.abs(group.stats.pnl)));
  return <aside className="fyers-ref-journal-insights" aria-label="Journal insights">
    {latest && <section className="fyers-ref-card">
      <h3>Learning loop · latest shown trade</h3>
      <p className="fyers-ref-insight-name">{latest.side} · {latest.symbol}</p>
      <dl>
        <div><dt>Entry score</dt><dd>{show(latest.score)}</dd></div>
        <div><dt>Entry gates</dt><dd>{show(latest.entryMandatoryPassCount, n => `${n}/5`)}</dd></div>
        <div><dt>Confirms</dt><dd>{show(latest.entryConfirmationPassCount, n => `${n}/8`)}</dd></div>
        <div><dt>Peak profit</dt><dd>{show(latest.peakUnrealizedPnl, rupees)}</dd></div>
        <div><dt>Given back</dt><dd>{show(latest.maxProfitGivebackPnl, n => `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`)}</dd></div>
        <div><dt>Held</dt><dd>{show(latest.heldMinutes, n => `${Math.round(n)} min`)}</dd></div>
      </dl>
      {latest.mentorSuggestionAtExit && <p>Exit: {latest.mentorSuggestionAtExit}</p>}
    </section>}
    {groups.length > 0 && <section className="fyers-ref-card">
      <h3>Net P&amp;L by type · trades shown</h3>
      {groups.map(group => <div className="fyers-ref-type-row" key={group.id}>
        <span>{group.short}</span><small>{group.stats.total}</small>
        <i aria-hidden="true"><b className={group.stats.pnl < 0 ? 'down' : 'up'} style={{ width: `${Math.abs(group.stats.pnl) / largest * 100}%` }}/></i>
        <strong className={group.stats.pnl < 0 ? 'danger' : 'positive'}>{rupees(group.stats.pnl)}</strong>
      </div>)}
      <button type="button" onClick={() => onNavigate('analysis')}>Legacy vs current runner and more in Analysis ›</button>
    </section>}
  </aside>;
}
