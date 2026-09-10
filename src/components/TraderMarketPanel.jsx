function fmt(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function TraderMarketPanel({ snapshot }) {
  if (!snapshot) return null;
  const { market, decision } = snapshot;

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

  return (
    <section className="panel trader-market-panel">
      <div className="panel-heading compact">
        <div>
          <div className="eyebrow">MARKET MAP</div>
          <h2>Levels & context</h2>
        </div>
        <span className={`phase-pill ${market.phase === 'LIVE' ? 'live' : ''}`}>{market.phase.replaceAll('_', ' ')}</span>
      </div>

      <div className="market-metric-grid">
        {metrics.map(([label, value]) => (
          <div className="market-metric" key={label}>
            <span>{label}</span>
            <strong>{fmt(value)}</strong>
          </div>
        ))}
      </div>

      <div className="mentor-reasoning">
        <div className="mentor-reasoning-title">Why now</div>
        <div className="mentor-reasoning-list">
          {(decision.reasons || []).slice(0, 3).map((reason, index) => (
            <span key={index}>{reason}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
