import { useMemo, useState } from 'react';

const DIRECTIONAL_IDS = new Set(['trend', 'vwap', 'risk', 'liquidity', 'orb', 'close', 'retest', 'pd', 'htf']);

export default function ParameterGrid({ rows, directionReady = true }) {
  const defaultId = useMemo(() => {
    const failedMandatory = rows.find(row => row.mandatory && !row.gatePassed);
    const weakest = [...rows].sort((a, b) => a.value - b.value)[0];
    return failedMandatory?.id || weakest?.id || rows[0]?.id;
  }, [rows]);

  const [selectedId, setSelectedId] = useState(defaultId);
  const selected = rows.find(row => row.id === selectedId) || rows.find(row => row.id === defaultId) || rows[0];
  const isPending = row => !directionReady && DIRECTIONAL_IDS.has(row.id);

  return (
    <section className="panel evidence-matrix-panel">
      <div className="panel-heading compact">
        <div>
          <div className="eyebrow">ADVANCED VIEW</div>
          <h2>13-point evidence matrix</h2>
        </div>
        <span className="muted">Select a card for a simple explanation · M = mandatory</span>
      </div>

      <div className="evidence-matrix">
        {rows.map((row, index) => {
          const pending = isPending(row);
          const pct = Math.round(row.value * 100);
          return (
            <button
              type="button"
              className={`evidence-tile ${pending ? 'pending' : row.status} ${row.mandatory ? 'mandatory' : ''} ${selected?.id === row.id ? 'selected' : ''}`}
              key={row.id}
              onClick={() => setSelectedId(row.id)}
            >
              <div className="evidence-tile-top">
                <span className="evidence-number">{String(index + 1).padStart(2, '0')}</span>
                {row.mandatory && <span className="mandatory-badge">M</span>}
                {pending && <span className="tile-gate pending">WAIT</span>}
                {!pending && row.mandatory && <span className={`tile-gate ${row.gatePassed ? 'pass' : 'fail'}`}>{row.gatePassed ? 'PASS' : 'FAIL'}</span>}
                <span className={`evidence-dot ${pending ? 'pending' : row.status}`} />
              </div>
              <strong>{shortLabel(row.label)}</strong>
              <div className="evidence-score">{pending ? 'Pending' : `${pct}%`}</div>
              <div className="evidence-mini-bar">
                <span className={pending ? 'pending' : row.status} style={{ width: pending ? '32%' : `${pct}%` }} />
              </div>
            </button>
          );
        })}
      </div>

      {selected && (() => {
        const pending = isPending(selected);
        return (
          <div className={`evidence-detail ${pending ? 'pending' : selected.status}`}>
            <div className="evidence-detail-title">
              <span className={`status-pill ${pending ? 'pending' : selected.status}`}>{pending ? 'WAIT' : selected.status}</span>
              <strong>{selected.label}</strong>
              {selected.mandatory && <span className="mandatory-detail">Mandatory gate</span>}
              {pending && <span className="detail-gate pending">WAIT FOR BIAS</span>}
              {!pending && selected.mandatory && <span className={`detail-gate ${selected.gatePassed ? 'pass' : 'fail'}`}>{selected.gatePassed ? 'GATE PASSED' : 'GATE FAILED'}</span>}
            </div>
            <p>
              {pending
                ? 'I need a clear CE or PE direction before I can judge this directional check. The low placeholder value is not being treated as a real failure.'
                : simpleDetail(selected)}
            </p>
            <div className="evidence-detail-numbers">
              <span>Score <strong>{pending ? '—' : `${Math.round(selected.value * 100)}%`}</strong></span>
              <span>Weight <strong>{selected.weight}</strong></span>
              {selected.mandatory && <span>Gate <strong>{pending ? 'Pending' : selected.gatePassed ? 'Passed' : 'Failed'}</strong></span>}
            </div>
          </div>
        );
      })()}
    </section>
  );
}

function simpleDetail(row) {
  const pct = Math.round(row.value * 100);
  const map = {
    chop: pct >= 58 ? 'The market is moving cleanly enough for this mandatory check.' : 'The market is too choppy right now. I will not force a trade until price movement becomes cleaner.',
    trend: pct >= 60 ? 'The current directional structure is strong enough for this mandatory check.' : 'The trend is not strong enough yet. I need clearer higher highs/higher lows or lower highs/lower lows.',
    vwap: pct >= 65 ? 'Price is behaving consistently enough on the correct side of VWAP.' : 'Price is not holding clearly enough on the correct side of VWAP, so direction is not reliable yet.',
    risk: pct >= 60 ? 'There is enough structural room to define a stop and a sensible target.' : 'The stop and target do not have enough clean room, so the trade is not worth the risk.',
    liquidity: pct >= 60 ? 'The selected option has acceptable spread, volume and open interest.' : 'The selected option is not liquid enough for clean execution.',
    orb: 'This checks whether price has genuinely broken the opening range rather than just moving around inside it.',
    close: 'I want a completed 5-minute candle beyond the trigger. An intrabar spike is not enough.',
    retest: pct >= 75 ? 'Price returned to the breakout area and held it, which strengthens the setup.' : 'The breakout has not produced a strong retest yet. I will not chase the move.',
    pd: 'This checks whether the previous day high or low supports the current direction or creates a nearby barrier.',
    volume: 'This compares recent participation with normal session volume. Stronger participation gives the move more credibility.',
    momentum: 'This checks whether recent candles are actually moving with useful speed and body size, not just drifting.',
    htf: 'This checks whether the 15-minute structure agrees with the shorter 5-minute direction.',
    time: 'This scores the part of the trading day. Some windows are more reliable than quieter periods.'
  };
  return map[row.id] || row.detail;
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
