// Presentation only: this component never fetches, trades or persists data.
export default function PremiumMarketTicker({ snapshot, liveQuote, marketDataReady = true }) {
  const market = snapshot?.market || {};
  const quote = Number(liveQuote?.nifty);
  const spot = quote > 0 ? quote : Number(market.spot);
  const change = market.changePct == null ? null : Number(market.changePct);
  return <div className="premium-market-ticker" aria-label="Current NIFTY market">
    <div className="premium-market-symbol"><strong>NIFTY 50</strong><span>NSE · {marketDataReady ? market.phase?.replaceAll('_', ' ') || 'Waiting for data' : 'UPDATING'}</span></div>
    <div className="premium-market-price"><strong>{spot > 0 ? number(spot) : '—'}</strong>{Number.isFinite(change) && <span className={change >= 0 ? 'positive' : 'negative'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</span>}</div>
    <div className="premium-market-context"><span>VIX <b>{number(market.vix)}</b></span><span>PCR <b>{number(market.putCallOiRatio)}</b></span><span>ATR <b>{number(market.atr5)}</b></span></div>
  </div>;
}

function number(value) { return value != null && Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'; }

export function UiIcon({ name }) {
  const paths = {
    trade: 'M3 17l5-6 4 3 8-9',
    scalp: 'M13 2L4 14h7l-1 8 9-12h-7z',
    positions: 'M4 8h16v11H4zM9 8V5h6v3',
    journal: 'M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM8 4v16',
    analysis: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M6 15v4'
  };
  return <svg className="premium-ui-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.trade} /></svg>;
}
