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
  const [stage, setStage] = useState('');
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [log, setLog] = useState(readLog);
  const [storageError, setStorageError] = useState(false);
  const cards = useMemo(() => rankStockCandidates((scan?.candidates || []).filter(item =>
    (scan?.contextWatchlist || []).some(watch => watch.stock === item.stock && watch.side === item.side)
  ), settings, now), [scan, settings, now]);
  const watchlist = scan?.watchlist || [];

  // Progressive Stock-only scan: never block the watchlist while waiting for
  // completed 5m/3m candles, option chain or market depth.
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer = null;
    let controller = null;
    async function request(phase, args = '') {
      controller = new AbortController();
      const url = '/api/fyers/stock-scanner?phase=' + phase + args;
      const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(phase === 'universe' ? 10000 : 14500)])
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401
        ? 'Reconnect FYERS to start Stock research.'
        : data.error || ('FYERS ' + phase + ' scan returned HTTP ' + response.status));
      return data;
    }
    async function refresh() {
      let delay = 60000;
      if (document.visibilityState === 'hidden') {
        if (!stopped) timer = window.setTimeout(refresh, delay);
        return;
      }
      setLoading(true);
      setError('');
      try {
        setStage('Scanning active NSE F&O stocks');
        const universe = await request('universe');
        if (stopped) return;
        setNow(Date.now());
        setScan(current => ({ ...current, ...universe, candidates: [],
          contextWatchlist: [], watchlist: universe.prescreen || [], detailedChecked: 0 }));
        const shortlist = (universe.prescreen || []).slice(0, 12);
        if (!shortlist.length) { setStage(''); return; }

        setStage('Checking weekly and daily trends in small batches');
        // Three bounded requests mean a slow stock cannot hide every result.
        // Context is shown after each successful batch, before paper-entry checks.
        const watchByStock = new Map();
        let assessed = 0;
        const batchErrors = [];
        for (let offset = 0; offset < shortlist.length; offset += 4) {
          if (stopped) return;
          const group = shortlist.slice(offset, offset + 4);
          try {
            const context = await request('context',
              '&symbols=' + encodeURIComponent(group.map(item => item.symbol).join(',')));
            if (stopped) return;
            assessed += Number(context.contextChecked) || 0;
            for (const row of context.watchlist || []) watchByStock.set(row.stock, row);
            const combined = [...watchByStock.values()]
              .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
            setScan(current => ({
              ...current, universeCount: universe.universeCount,
              quotesChecked: universe.quotesChecked, prescreen: universe.prescreen,
              contextChecked: assessed,
              contextWatchlist: combined,
              watchlist: combined.length ? combined : universe.prescreen,
              status: combined.length ? null : 'No verified weekly/daily alignment yet. Preliminary movers remain under screening.'
            }));
            setNow(Date.now());
          } catch (reason) {
            if (reason?.name === 'AbortError' && stopped) return;
            batchErrors.push(reason?.message || 'History checks unavailable');
          }
        }
        const qualified = [...watchByStock.values()]
          .sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
        if (batchErrors.length && !stopped) {
          setError('Some weekly/daily chart checks could not be completed. ' +
            'The preliminary watchlist is preserved; only verified setups may proceed.');
        }
        if (!qualified.length) { setStage(''); return; }
        setStage('Checking 5-minute/3-minute entry triggers');
        const symbols = qualified.map(row => row.symbol).join(',');
        const bias = qualified.map(row => row.stock + ':' + row.side).join(',');
        const entries = await request('entry',
          '&symbols=' + encodeURIComponent(symbols) + '&bias=' + encodeURIComponent(bias));
        if (stopped) return;
        setScan(current => ({
          ...current, candidates: entries.candidates || [],
          detailedChecked: entries.detailedChecked || 0,
          entryStatus: entries.status, entryFailures: entries.failures || []
        }));
        setStage('');
        setNow(Date.now());
      } catch (failure) {
        if (!stopped && failure?.name !== 'AbortError') {
          setError(failure?.name === 'TimeoutError'
            ? 'A Stock data stage timed out. The last watchlist is kept; try Scan now.'
            : failure.message || 'Stock data temporarily unavailable.');
          delay = 90000;
        }
      } finally {
        if (!stopped) {
          setLoading(false);
          setStage('');
          timer = window.setTimeout(refresh, delay);
        }
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
          <p>First identify bullish and bearish weekly/daily setups across NSE F&amp;O. Then look for completed 5-minute and 3-minute entry triggers. The watchlist stays visible while entries are checked.</p>
        </div>
        <div className="stock-scanner-actions">
          <span className={error ? 'stock-status warn' : active && scan ? 'stock-status live' : 'stock-status'}>
            <i aria-hidden="true" /> {error ? 'Stock data warning' : stage ? 'Scanning FYERS' : active && scan ? 'Watchlist updated' : active ? 'Checking FYERS' : 'Reconnect FYERS'}
          </span>
          <button type="button" className="stock-refresh-button" onClick={() => setReload(value => value + 1)}
            disabled={!active || loading}>{loading ? 'Scanning…' : 'Scan now'}</button>
        </div>
      </section>

      {!active && <div className="stock-alert" role="status">Connect FYERS to start the Stock Options scanner. The Normal and Scalp modes remain available separately.</div>}
      {error && <div className="stock-alert" role="alert">{error}</div>}
      {storageError && <div className="stock-alert" role="alert">Your device could not save the Stock signal log.</div>}
      {scan?.quoteBatchErrors > 0 && <div className="stock-alert subtle">{scan.quoteBatchErrors} quote batch(es) failed; available stocks are still shown below.</div>}
      {scan?.failures?.length > 0 && <div className="stock-alert subtle">FYERS data could not be confirmed for: {scan.failures.join(', ')}. These stocks are not trade-ready.</div>}

      <div className="stock-scanner-stats">
        <div><span>F&amp;O screening pool</span><strong>{scan?.universeCount ?? '—'}</strong></div>
        <div><span>FYERS quotes verified</span><strong>{scan?.quotesChecked ?? '—'}</strong></div>
        <div><span>Weekly/daily assessed</span><strong>{scan?.contextChecked ?? '—'}</strong></div>
        <div><span>Watch candidates</span><strong>{scan?.contextWatchlist?.length ?? '—'}<small> / 10 max</small></strong></div>
      </div>

      <section className="stock-watch-panel">
        <div className="stock-panel-heading">
          <div><span className="stock-scanner-eyebrow">WEEKLY + DAILY CONTEXT</span><h2>Bullish and bearish Stock watchlist</h2></div>
          <span className="stock-panel-meta">Weekly / Daily → 5m / 3m</span>
        </div>
        <p className="stock-explainer">Market movers are pre-screened from the NSE F&amp;O universe. A <strong>WATCH</strong> requires aligned completed weekly and daily bullish/bearish structure; the 5-minute/3-minute trigger is checked separately. A <strong>SCREENING</strong> row has not passed the weekly/daily checks yet. Scores reflect rule-based context, not win probability. Last response: {ist(scan?.generatedAt)}.</p>
        {loading && <div className="stock-scanner-loading" role="status">{stage || 'Checking FYERS market data…'}{scan?.watchlist?.length ? ' · Watchlist remains visible below' : ''}</div>}
        {!loading && scan?.status && <div className="stock-scanner-loading" role="status">{scan.status}</div>}
        {!watchlist.length && !loading && !scan && active && <div className="stock-scanner-loading">No stock scan returned yet. Select Scan now to retry.</div>}
        {!!watchlist.length && <div className="stock-watch-grid">
          {watchlist.map((row, i) => (
            <div className={`stock-watch-item ${row.status === 'WATCH' ? 'confirmed' : ''}`} key={row.stock}>
              <div className="stock-watch-rank">{String(i + 1).padStart(2, '0')}</div>
              <div className="stock-watch-identity"><strong>{row.stock}</strong><small>{row.reason || 'Monitoring market'}</small>{row.weekBias && <small>Week: {row.weekBias} · Day: {row.dayBias}</small>}</div>
              <div className="stock-watch-prices"><strong>{money(row.spot)}</strong><small>{Number.isFinite(row.changePct) ? `${row.changePct >= 0 ? '+' : ''}${row.changePct.toFixed(2)}%` : '—'}</small></div>
              <div className="stock-watch-signal">
                <span className={`stock-side ${row.side === 'CE' ? 'call' : row.side === 'PE' ? 'put' : ''}`}>{row.side || '—'}</span>
                <small>{row.status === 'WATCH' ? `WATCH ${row.score}/100` : row.status === 'SCREENING' ? 'SCREENING' : 'NO DATA'}</small>
              </div>
            </div>
          ))}
        </div>}
      </section>

      <section className="stock-trade-panel">
        <div className="stock-panel-heading"><div><span className="stock-scanner-eyebrow">SEPARATE PAPER STRATEGY</span><h2>Confirmed stock option setups</h2></div><span className="stock-panel-meta">{cards.length} eligible</span></div>
        <p className="stock-explainer">Paper trades only. Validated FYERS expiry and lot size, current bid/ask depth and capital/risk limits are required. No live broker orders are placed here.</p>
        {active && scan && !cards.length && <p className="stock-scanner-empty">{scan.entryStatus || 'No paper-ready 5-minute/3-minute option entry yet. Weekly/daily watch candidates remain visible above.'}</p>}
        <StockPaperPosition cards={cards} settings={settings} onCloseTrade={onCloseTrade} />
      </section>

      <details className="stock-signal-log">
        <summary>Recorded stock research signals ({log.length})</summary>
        <div>{log.slice(0, 30).map(row => <p key={row.id}><strong>{row.stock} {row.side}</strong> · {row.strike} · {row.setup} · {row.lots} lots · risk {money(row.risk)} · {ist(row.recordedAt)}</p>)}</div>
      </details>
      <p className="stock-scanner-disclaimer">Research and paper trades only. Weekly/daily context is based on completed historical candles; current quote movement is screened separately. The live Stock option trade stage checks at most five watch candidates per scan. This is not an exhaustive scan of all F&amp;O charts and does not recreate FYERS' proprietary OI Watch rankings. Normal and Scalp remain unchanged.</p>
    </div>
  );
}
