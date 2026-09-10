const DIRECTIONAL_IDS = new Set(['trend', 'vwap', 'risk', 'liquidity', 'orb', 'close', 'retest', 'pd', 'htf']);

export default function QuickChecklist({ rows = [], directionReady = true }) {
  const mandatory = rows.filter(row => row.mandatory);
  const confirmations = rows.filter(row => !row.mandatory);
  const mandatoryPassed = mandatory.filter(row => row.gatePassed === true).length;
  const mandatoryFailed = mandatory.filter(row => row.gatePassed === false).length;
  const directionPending = !directionReady && rows.length > 0;

  return (
    <section className="quick-checklist" aria-label="13 point quick checklist">
      <div className={`quick-summary ${directionPending ? 'pending' : mandatory.length && mandatoryPassed === mandatory.length ? 'all-clear' : 'gate-fail'}`}>
        <span>MANDATORY</span>
        <strong>{directionPending ? 'WAIT' : `${mandatoryPassed}/${mandatory.length || 5}`}</strong>
        {directionPending && <small>BIAS FIRST</small>}
        {!directionPending && mandatoryFailed > 0 && <small>{mandatoryFailed} BLOCKED</small>}
      </div>

      <div className="quick-section mandatory-section">
        {mandatory.map((row, index) => (
          <QuickChip row={row} index={index + 1} key={row.id} pending={directionPending && DIRECTIONAL_IDS.has(row.id)} />
        ))}
      </div>

      <div className="quick-divider" />

      <div className="quick-section confirmation-section">
        {confirmations.map((row, index) => (
          <QuickChip
            row={row}
            index={index + mandatory.length + 1}
            key={row.id}
            compact
            pending={directionPending && DIRECTIONAL_IDS.has(row.id)}
          />
        ))}
      </div>
    </section>
  );
}

function QuickChip({ row, index, compact = false, pending = false }) {
  const value = pending ? '—' : Math.round(row.value * 100);
  const title = pending
    ? `${row.label}: waiting for a clear CE or PE bias before this directional check can be assessed.`
    : `${row.label}: ${Math.round(row.value * 100)}%${row.mandatory ? ` · Mandatory gate ${row.gatePassed ? 'PASSED' : 'FAILED'}` : ''}`;

  return (
    <div
      className={`quick-chip ${pending ? 'pending' : row.status} ${row.mandatory ? 'mandatory' : ''} ${compact ? 'compact' : ''}`}
      title={title}
    >
      <span className="quick-index">{index}</span>
      <span className="quick-name">{shortLabel(row.label)}</span>
      <span className="quick-value">{value}</span>
      {pending && <span className="quick-gate pending">WAIT</span>}
      {!pending && row.mandatory && <span className={`quick-gate ${row.gatePassed ? 'pass' : 'fail'}`}>{row.gatePassed ? 'PASS' : 'FAIL'}</span>}
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
