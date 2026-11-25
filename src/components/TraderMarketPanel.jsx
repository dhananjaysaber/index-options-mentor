import NiftyStrategyChart from './NiftyStrategyChart.jsx';

function fmt(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function TraderMarketPanel({ snapshot, lineMode = false }) {
  if (!snapshot) return <section className="panel trader-market-panel premium-market-empty" aria-label="Market connection needed">
    <div className="eyebrow">MARKET VIEW</div><h2>Waiting for your live connection</h2>
    <p>Connect FYERS above or from the menu to load the chart, current prices and Mentor's trade plan.</p>
    <div className="premium-empty-chart" aria-hidden="true"><span>Live chart appears here</span></div>
    <small>No prices or trade suggestions are shown until market data is available.</small>
  </section>;
  const { market, decision, parameters = [] } = snapshot;

  const metrics = [
    ['VWAP', market.vwap],
    ['ORH', market.orh],
    ['ORL', market.orl],
    ['PDH', market.pdh],
    ['PDL', market.pdl],
    ['5m ATR', market.atr5],
    ['India VIX', market.vix],
    ['OI PCR', market.putCallOiRatio]
  ];

  const reasons = simpleReasons({ market, decision, parameters });

  return (
    <section className="panel trader-market-panel">
      <div className="panel-heading compact">
        <div>
          <div className="eyebrow">MARKET MAP</div>
          <h2>Levels & context</h2>
        </div>
        <span className={`phase-pill ${market.phase === 'LIVE' ? 'live' : ''}`}>{market.phase.replaceAll('_', ' ')}</span>
      </div>

      <NiftyStrategyChart snapshot={snapshot} compact lineMode={lineMode} />

      <div className="market-metric-grid">
        {metrics.map(([label, value]) => (
          <div className="market-metric" key={label}>
            <span>{label}</span>
            <strong>{fmt(value)}</strong>
          </div>
        ))}
      </div>

      <div className="mentor-reasoning">
        <div className="mentor-reasoning-title">Mentor view</div>
        <div className="mentor-reasoning-list">
          {reasons.slice(0, 3).map((reason, index) => (
            <span key={index}>{reason}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function simpleReasons({ market, decision, parameters }) {
  if (market.phase === 'LIVE' && !decision.side) {
    const regime = parameters.find(row => row.id === 'chop');
    const notes = ['I do not have a clear CE or PE direction yet.'];
    if (regime && Number(regime.value) < 0.58) notes.push('Price action is choppy, so I am protecting capital instead of forcing a trade.');
    notes.push('I am waiting for trend and VWAP to agree before I choose an option.');
    return notes;
  }

  if (decision.state === 'RETEST_FAILED') {
    return ['The latest breakout failed its retest.', 'That setup is cancelled.', 'I am waiting for a completely fresh breakout and retest sequence.'];
  }

  return decision.reasons || [];
}
