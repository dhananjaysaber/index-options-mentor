import { useMemo, useState } from 'react';

export default function ParameterGrid({ rows }) {
  const defaultId = useMemo(() => {
    const failedMandatory = rows.find(row => row.mandatory && !row.gatePassed);
    const weakest = [...rows].sort((a, b) => a.value - b.value)[0];
    return failedMandatory?.id || weakest?.id || rows[0]?.id;
  }, [rows]);

  const [selectedId, setSelectedId] = useState(defaultId);
  const selected = rows.find(row => row.id === selectedId) || rows.find(row => row.id === defaultId) || rows[0];

  return (
    <section className="panel evidence-matrix-panel">
      <div className="panel-heading compact">
        <div>
          <div className="eyebrow">ADVANCED VIEW</div>
          <h2>13-point evidence matrix</h2>
        </div>
        <span className="muted">Click any parameter for detail · M = mandatory</span>
      </div>

      <div className="evidence-matrix">
        {rows.map((row, index) => (
          <button
            type="button"
            className={`evidence-tile ${row.status} ${row.mandatory ? 'mandatory' : ''} ${selected?.id === row.id ? 'selected' : ''}`}
            key={row.id}
            onClick={() => setSelectedId(row.id)}
          >
            <div className="evidence-tile-top">
              <span className="evidence-number">{String(index + 1).padStart(2, '0')}</span>
              {row.mandatory && <span className="mandatory-badge">M</span>}
              {row.mandatory && <span className={`tile-gate ${row.gatePassed ? 'pass' : 'fail'}`}>{row.gatePassed ? 'PASS' : 'FAIL'}</span>}
              <span className={`evidence-dot ${row.status}`} />
            </div>
            <strong>{shortLabel(row.label)}</strong>
            <div className="evidence-score">{Math.round(row.value * 100)}%</div>
            <div className="evidence-mini-bar"><span className={row.status} style={{ width: `${Math.round(row.value * 100)}%` }} /></div>
          </button>
        ))}
      </div>

      {selected && (
        <div className={`evidence-detail ${selected.status}`}>
          <div className="evidence-detail-title">
            <span className={`status-pill ${selected.status}`}>{selected.status}</span>
            <strong>{selected.label}</strong>
            {selected.mandatory && <span className="mandatory-detail">Mandatory gate</span>}
            {selected.mandatory && <span className={`detail-gate ${selected.gatePassed ? 'pass' : 'fail'}`}>{selected.gatePassed ? 'GATE PASSED' : 'GATE FAILED'}</span>}
          </div>
          <p>{selected.detail}</p>
          <div className="evidence-detail-numbers">
            <span>Score <strong>{Math.round(selected.value * 100)}%</strong></span>
            <span>Weight <strong>{selected.weight}</strong></span>
            {selected.mandatory && <span>Gate <strong>{selected.gatePassed ? 'Passed' : 'Failed'}</strong></span>}
          </div>
        </div>
      )}
    </section>
  );
}

function shortLabel(label) {
  const map = {
    'Market regime': 'Regime',
    'Trend structure': 'Trend',
    'VWAP alignment': 'VWAP',
    'Defined risk & room': 'Risk & room',
    'Option liquidity': 'Liquidity',
    'Opening-range break': 'ORB',
    '5-minute close confirmation': '5m close',
    'Retest quality': 'Retest',
    'PDH / PDL confluence': 'PDH / PDL',
    'Volume expansion': 'Volume',
    'Momentum quality': 'Momentum',
    'Higher-timeframe alignment': '15m align',
    'Time-of-day quality': 'Time'
  };
  return map[label] || label;
}
