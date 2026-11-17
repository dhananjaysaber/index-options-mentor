import { useEffect, useMemo, useState } from 'react';
import StockPaperPosition from './StockPaperPosition.jsx';
import { rankStockCandidates } from '../engine/stockRanking.js';

const LOG_KEY = 'index-options-mentor-stock-signals-v1';
const money = value => Number.isFinite(Number(value)) && value != null
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(value) : '—';
const ist = value => value ? new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
}).format(new Date(value)) : '—';

function readLog() {
  try {
    const value = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export default function StockScanner({ active, settings, onCloseTrade }) {
  const [scan, setScan] = useState(null);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [log, setLog] = useState(readLog);
  const [storageError, setStorageError] = useState(false);
  const cards = useMemo(() => rankStockCandidates(scan?.candidates || [], settings, now), [scan, settings, now]);
  const watchlist = scan?.watchlist || [];

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;
    let controller = null;
    async function refresh() {
      let delay = 30000;
      if (document.visibilityState === 'hidden') {
        if (!stopped) timer = window.setTimeout(refresh, delay);
        return;
      }
      setLoading(true);
      controller = new AbortController();
      try {
        const response = await fetch('/api/fyers/stock-scanner', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(26000)])
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 429) delay = data.limitScope === 'daily' ? 60000 : 90000;
        if (!response.ok) throw new Error(response.status === 401 ? 'Reconnect FYERS to scan stock options.' : data.error || 'The stock option scanner is unavailable.');
        if (!stopped) {
          setScan(data);
          setError('');
          setNow(Date.now());
        }
      } catch (failure) {
        if (!stopped && failure.name !== 'AbortError') {
          setError(failure.message || 'Could not load fresh stock data.');
          // Keep the latest successful list visible, but do not allow stale
          // paper entries — ranked cards expire automatically.
        }
      } finally {
        if (!stopped) { setLoading(false); timer = window.setTimeout(refresh, delay); }
      }
    }
    void refresh();
    return () => {
      stopped = true;
      controller?.abort();
      window.clearTimeout(timer);
    };
  }, [active, reload]);

  useEffect(() => {
    if (!active) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(interval);
  }, [active]);

  const signalIds = cards.map(card => [card.stock, card.side, card.confirmedAt].join(':')).join('|');
  useEffect(() => {
    if (!active || !cards.length) return;
    const prior = readLog();
    const known = new Set(prior.map(row => row.id));
    const fresh = cards.map(card => ({
      ...card, id: [card.stock, card.side, card.confirmedAt].join(':'),
      recordedAt: Date.now(), entryMethod: 'AUTO', mode: 'PAPER_SIGNAL'
    })).filter(row => !known.has(row.id));
    if (!fresh.length) return;
    const next = [...fresh, ...prior].slice(0, 200);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(next));
      setLog(next);
      setStorageError(false);
    } catch { setStorageError(true); }
  // Each unique setup is written once; a 5-second clock tick does not duplicate it.
  }, [active, signalIds]);

  return (
    <div className="stock-scanner-page" aria-label="Stock Options Mentor">
      <section className="stock-scanner-hero">
        <div>
          <span className="stock-scanner-eyebrow">FYERS PRIME · NSE F&O · SEPARATE RESEARCH</span>
          <h1>Stock Options Mentor</h1>
          <p>Top 10 monitored equity F&O stocks, ranked by completed-candle momentum. Confirmed option setups appear separately for paper testing.</p>
        </div>
        <div className="stock-scanner-actions">
          <span className={error ? 'stock-status warn' : active && scan ? 'stock-status live' : 'stock-status'}>
            <i aria-hidden="true" /> {error ? 'Data warning' : active && scan ? 'Data received' : 'Waiting for FYERS'}
          </span>
          <button type="button" className="stock-refresh-button" onClick={() => setReload(value => value + 1)}
            disabled={!active || loading}>{loading ? 'Scanning…' : 'Scan now'}</button>
        </div>
      </section>

      {!active && <div className="stock-alert" role="status">Connect FYERS to start the Stock Options scanner. The Normal and Scalp modes remain available separately.</div>}
      {error && <div className="stock-alert" role="alert">{error}</div>}
      {storageError && <div className="stock-alert" role="alert">Your device could not save the Stock signal log.</div>}
      {scan?.failures?.length > 0 && <div className="stock-alert subtle">FYERS data could not be confirmed for: {scan.failures.join(', ')}. These stocks are not trade-ready.</div>}

      <div className="stock-scanner-stats">
        <div><span>Stocks assessed</span><strong>{watchlist.length}<small> / 10</small></strong></div>
        <div><span>Confirmed option setups</span><strong>{scan?.candidates?.length || 0}</strong></div>
        <div><span>Within paper risk budget</span><strong>{cards.length}</strong></div>
        <div><span>Last scan</span><strong className="stock-small-value">{ist(scan?.generatedAt)}</strong></div>
      </div>

      <section className="stock-watch-panel">
        <div className="stock-panel-heading">
          <div><span className="stock-scanner-eyebrow">RANKED MONITOR</span><h2>Top 10 Stock Options Watchlist</h2></div>
          <span className="stock-panel-meta">5m direction · 3m confirmation</span>
        </div>
        <p className="stock-explainer">A higher momentum score indicates closer alignment, <strong>not a probability of profit</strong>. WATCH means no qualified entry; CONFIRMED still requires a valid live option contract and risk check.</p>
        {loading && !scan && <div className="stock-scanner-loading" role="status">Checking FYERS prices, completed candles and option contracts…</div>}
        {!loading && scan?.status && !watchlist.length && <div className="stock-scanner-loading" role="status">{scan.status}</div>}
        {!watchlist.length && !loading && !scan && active && <div className="stock-scanner-loading">No stock scan returned yet. Select Scan now to retry.</div>}
        {!!watchlist.length && <div className="stock-watch-grid">
          {watchlist.map((row, i) => (
            <div className={`stock-watch-item ${row.status === 'CONFIRMED' ? 'confirmed' : ''}`} key={row.stock}>
              <div className="stock-watch-rank">{String(i + 1).padStart(2, '0')}</div>
              <div className="stock-watch-identity"><strong>{row.stock}</strong><small>{row.reason || 'Monitoring market'}</small></div>
              <div className="stock-watch-prices"><strong>{money(row.spot)}</strong><small>{Number.isFinite(row.changePct) ? `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(2)}%` : '—'}</small></div>
              <div className="stock-watch-signal">
                <span className={`stock-side ${row.side === 'CE' ? 'call' : row.side === 'PE' ? 'put' : ''}`}>{row.side || '—'}</span>
                <small>{row.status === 'CONFIRMED' ? 'CONFIRMED' : row.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'WATCH'}</small>
              </div>
            </div>
          ))}
        </div>}
      </section>

      <section className="stock-trade-panel">
        <div className="stock-panel-heading"><div><span className="stock-scanner-eyebrow">SEPARATE PAPER STRATEGY</span><h2>Confirmed stock option setups</h2></div><span className="stock-panel-meta">{cards.length} eligible</span></div>
        <p className="stock-explainer">Paper trades only. Validated FYERS expiry and lot size, current bid/ask depth and capital/risk limits are required. No live broker orders are placed here.</p>
        {active && scan && !cards.length && <p className="stock-scanner-empty">No stock option currently meets the completed-candle, liquidity and risk checks. The ranked watchlist remains visible above.</p>}
        <StockPaperPosition cards={cards} settings={settings} onCloseTrade={onCloseTrade} />
      </section>

      <details className="stock-signal-log">
        <summary>Recorded stock research signals ({log.length})</summary>
        <div>{log.slice(0, 30).map(row => <p key={row.id}><strong>{row.stock} {row.side}</strong> · {row.strike} · {row.setup} · {row.lots} lots · risk {money(row.risk)} · {ist(row.recordedAt)}</p>)}</div>
      </details>
      <p className="stock-scanner-disclaimer">Research and simulated positions only. Option prices, spreads and momentum can change before an order fills. NIFTY Normal and Scalp positions and journals are unaffected.</p>
    </div>
  );
}
