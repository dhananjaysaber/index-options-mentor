export default function QuickChecklist({ rows = [] }) {
  const mandatory = rows.filter(row => row.mandatory);
  const confirmations = rows.filter(row => !row.mandatory);
  const mandatoryPassed = mandatory.filter(row => row.gatePassed).length;

  return (
    <section className="quick-checklist" aria-label="13 point quick checklist">
      <div className={`quick-summary ${mandatory.length && mandatoryPassed === mandatory.length ? 'all-clear' : 'gate-fail'}`}>
        <span>MANDATORY</span>
        <strong>{mandatoryPassed}/{mandatory.length || 5}</strong>
      </div>

      <div className="quick-section mandatory-section">
        {mandatory.map((row, index) => <QuickChip row={row} index={index + 1} key={row.id} />)}
      </div>

      <div className="quick-divider" />

      <div className="quick-section confirmation-section">
        {confirmations.map((row, index) => <QuickChip row={row} index={index + mandatory.length + 1} key={row.id} compact />)}
      </div>
    </section>
  );
}

function QuickChip({ row, index, compact = false }) {
  return (
    <div
      className={`quick-chip ${row.status} ${row.mandatory ? 'mandatory' : ''} ${compact ? 'compact' : ''}`}
      title={`${row.label}: ${Math.round(row.value * 100)}%${row.mandatory ? ` · Mandatory gate ${row.gatePassed ? 'PASSED' : 'FAILED'}` : ''}`}
    >
      <span className="quick-index">{index}</span>
      <span className="quick-name">{shortLabel(row.label)}</span>
      <span className="quick-value">{Math.round(row.value * 100)}</span>
      {row.mandatory && <span className={`quick-gate ${row.gatePassed ? 'pass' : 'fail'}`}>{row.gatePassed ? 'PASS' : 'FAIL'}</span>}
    </div>
  );
}

function shortLabel(label) {
  const map = {
    'Market regime': 'Regime',
    'Trend structure': 'Trend',
    'VWAP alignment': 'VWAP',
    'Defined risk & room': 'Risk',
    'Option liquidity': 'Liquid',
    'Opening-range break': 'ORB',
    '5-minute close confirmation': 'Close',
    'Retest quality': 'Retest',
    'PDH / PDL confluence': 'PDH/L',
    'Volume expansion': 'Vol',
    'Momentum quality': 'Mom',
    'Higher-timeframe alignment': '15m',
    'Time-of-day quality': 'Time'
  };
  return map[label] || label;
}
