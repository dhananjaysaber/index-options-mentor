const DIRECTIONAL_IDS = new Set(['trend', 'vwap', 'risk', 'liquidity', 'orb', 'close', 'retest', 'pd', 'htf']);

const PENDING_ROWS = [
  { id: 'chop', label: 'Market regime', mandatory: true, value: 0, status: 'pending', gatePassed: null },
  { id: 'trend', label: 'Trend structure', mandatory: true, value: 0, status: 'pending', gatePassed: null },
  { id: 'vwap', label: 'VWAP alignment', mandatory: true, value: 0, status: 'pending', gatePassed: null },
  { id: 'risk', label: 'Defined risk & room', mandatory: true, value: 0, status: 'pending', gatePassed: null },
  { id: 'liquidity', label: 'Option liquidity', mandatory: true, value: 0, status: 'pending', gatePassed: null },
  { id: 'orb', label: 'Opening-range break', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'close', label: '5-minute close confirmation', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'retest', label: 'Retest quality', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'pd', label: 'PDH / PDL confluence', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'volume', label: 'Volume expansion', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'momentum', label: 'Momentum quality', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'htf', label: 'Higher-timeframe alignment', mandatory: false, value: 0, status: 'pending', gatePassed: null },
  { id: 'time', label: 'Time-of-day quality', mandatory: false, value: 0, status: 'pending', gatePassed: null }
];

export default function QuickChecklist({ rows = [], directionReady = true }) {
  const dataReady = rows.length > 0;
  const displayRows = dataReady ? rows : PENDING_ROWS;
  const mandatory = displayRows.filter(row => row.mandatory);
  const confirmations = displayRows.filter(row => !row.mandatory);
  const mandatoryPassed = dataReady ? mandatory.filter(row => row.gatePassed === true).length : 0;
  const mandatoryFailed = dataReady ? mandatory.filter(row => row.gatePassed === false).length : 0;
  const directionPending = !directionReady && dataReady;
  const allPending = !dataReady;

  return (
    <section className="quick-checklist" aria-label="13 point quick checklist">
      <div className={`quick-summary ${allPending || directionPending ? 'pending' : mandatory.length && mandatoryPassed === mandatory.length ? 'all-clear' : 'gate-fail'}`}>
        <span>MANDATORY</span>
        <strong>{allPending || directionPending ? 'WAIT' : `${mandatoryPassed}/${mandatory.length || 5}`}</strong>
        {allPending && <small>OPEN RANGE</small>}
        {!allPending && directionPending && <small>BIAS FIRST</small>}
        {!allPending && !directionPending && mandatoryFailed > 0 && <small>{mandatoryFailed} BLOCKED</small>}
      </div>

      <div className="quick-section mandatory-section">
        {mandatory.map((row, index) => (
          <QuickChip row={row} index={index + 1} key={row.id} pending={allPending || (directionPending && DIRECTIONAL_IDS.has(row.id))} />
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
            pending={allPending || (directionPending && DIRECTIONAL_IDS.has(row.id))}
          />
        ))}
      </div>
    </section>
  );
}

function QuickChip({ row, index, compact = false, pending = false }) {
  const value = pending ? '—' : Math.round(row.value * 100);
  const title = pending
    ? `${row.label}: waiting for enough live market structure before this check can be assessed.`
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
