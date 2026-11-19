import NiftyStrategyChart from './NiftyStrategyChart.jsx';

function formatLevel(value) {
  const number = Number(value);
  return value == null || !Number.isFinite(number) || number <= 0
    ? '—'
    : number.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/**
 * A single market-level summary. NiftyStrategyChart still draws real-time
 * VWAP, trigger, stop and target overlays; it no longer duplicates this
 * numerical grid inside the chart on the 13-Point screen.
 */
export default function TraderMarketPanel({ snapshot }) {
  if (!snapshot) return null;

  const market = snapshot.market || {};
  const metrics = [
    ['VWAP', market.vwap],
    ['ORH', market.orh],
    ['ORL', market.orl],
    ['PDH', market.pdh],
    ['PDL', market.pdl],
    ['5m ATR', market.atr5]
  ];

  return (
    <section className="panel trader-market-panel premium-market-panel" aria-label="NIFTY chart and context">
      <div className="panel-heading compact premium-market-heading">
        <div>
          <div className="eyebrow">EXECUTION CHART</div>
          <h2>NIFTY 50 · Price action</h2>
        </div>
        <span className={'phase-pill ' + (market.phase === 'LIVE' ? 'live' : '')}>
          {String(market.phase || 'WAITING').replaceAll('_', ' ')}
        </span>
      </div>

      <NiftyStrategyChart
        snapshot={snapshot}
        compact
        showLevelSummary={false}
        showRuleNote={false}
      />

      <div className="premium-context-header">
        <strong>Key market levels</strong>
        <small>Single live context view</small>
      </div>
      <div className="market-metric-grid premium-context-grid" aria-label="VWAP, opening range and prior day levels">
        {metrics.map(([label, value]) => (
          <div className="market-metric" key={label}>
            <span>{label}</span>
            <strong>{formatLevel(value)}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}
