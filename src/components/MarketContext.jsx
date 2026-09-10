function fmt(value) {
  return value == null ? '—' : Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export default function MarketContext({ snapshot }) {
  if (!snapshot) return null;
  const { market, structure, option, diagnostics } = snapshot;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <div className="eyebrow">LIVE MARKET CONTEXT</div>
          <h2>What the mentor is reading</h2>
        </div>
        <span className={`market-phase ${market.phase === 'LIVE' ? 'live' : ''}`}>{market.phase.replaceAll('_', ' ')}</span>
      </div>

      <div className="context-grid">
        <div><span>VWAP</span><strong>{fmt(market.vwap)}</strong></div>
        <div><span>ORH</span><strong>{fmt(market.orh)}</strong></div>
        <div><span>ORL</span><strong>{fmt(market.orl)}</strong></div>
        <div><span>PDH</span><strong>{fmt(market.pdh)}</strong></div>
        <div><span>PDL</span><strong>{fmt(market.pdl)}</strong></div>
        <div><span>5m ATR</span><strong>{fmt(market.atr5)}</strong></div>
        <div><span>India VIX</span><strong>{fmt(market.vix)}</strong></div>
        <div><span>OI PCR</span><strong>{fmt(market.putCallOiRatio)}</strong></div>
      </div>

      <div className="context-notes">
        <span>Session {market.sessionDate}</span>
        <span>Last complete candle {market.lastCandleTime}</span>
        <span>{diagnostics.duplicateOrPreopenRowsRemoved} duplicate/pre-open rows ignored</span>
        {structure.retestFound && <span>Retest detected</span>}
        {option?.expiry && <span>Option expiry {option.expiry}</span>}
      </div>
    </section>
  );
}
