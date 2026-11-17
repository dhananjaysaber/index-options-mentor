import { useEffect, useState } from 'react';
import StockPaperPosition from './StockPaperPosition.jsx';
import { rankStockCandidates } from '../engine/stockRanking.js';

const cooldownKey = 'index-options-mentor-stock-cooldown-v1';
let cooldown = { until: 0, delay: 0 };

function readCooldown() {
  try {
    const saved = JSON.parse(localStorage.getItem(cooldownKey));
    if (saved?.until > cooldown.until) cooldown = saved;
  } catch {
    // Keep the in-memory cooldown if storage is unavailable.
  }
  return cooldown;
}

function saveCooldown(value) {
  cooldown = value;
  try {
    localStorage.setItem(cooldownKey, JSON.stringify(value));
  } catch {
    // The scanner can still back off within this tab.
  }
}

const logKey = 'index-options-mentor-stock-signals-v1';
const money = value => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value);
const ist = value => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'medium' }).format(value);

function readLog() {
  try {
    const rows = JSON.parse(localStorage.getItem(logKey));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export default function StockScanner({ active, settings, onCloseTrade }) {
  const [scan, setScan] = useState(null);
  const [now, setNow] = useState(Date.now);
  const [error, setError] = useState('');
  const [log, setLog] = useState(readLog);
  const [storageError, setStorageError] = useState(false);
  const cards = rankStockCandidates(scan?.candidates ?? [], settings, now);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer;
    let controller;
    async function refresh() {
      let delay = 30000;
      try {
        if (document.visibilityState !== 'visible') return;
        const previous = readCooldown();
        const wait = previous.until - Date.now();
        if (wait > 0) {
          delay = wait;
          setError(`FYERS limited stock data. Scanner paused until ${ist(previous.until)}.`);
          return;
        }
        controller = new AbortController();
        const response = await fetch('/api/fyers/stock-scanner', {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
        });
        const data = await response.json();
        if (response.status === 429) {
          const consecutive = Date.now() - previous.until < 60000;
          delay = consecutive ? Math.min(600000, previous.delay * 2) : 120000;
          const until = Date.now() + delay;
          saveCooldown({ until, delay });
          throw new Error(`FYERS limited stock data. Scanner paused until ${ist(until)}.`);
        }
        if (!response.ok) throw new Error(response.status === 401 ? 'Connect FYERS to start scanning.' : data.error || 'Stock Scanner unavailable.');
        if (!stopped) {
          saveCooldown({ until: 0, delay: 0 });
          setScan(data);
          setError('');
          setNow(Date.now());
        }
      } catch (failure) {
        if (!stopped) {
          setScan(null);
          setError(failure.message);
        }
      } finally {
        if (!stopped) timer = setTimeout(refresh, delay);
      }
    }
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [active]);

  const validCards = JSON.stringify(cards);
  useEffect(() => {
    const current = JSON.parse(validCards);
    if (!active || !current.length) return;
    const stored = readLog();
    const known = new Set(stored.map(row => row.id));
    const fresh = current.map(row => ({
      ...row, id: [row.stock, row.side, row.confirmedAt].join(':'),
      recordedAt: Date.now(), entryMethod: 'AUTO', mode: 'PAPER_SIGNAL'
    })).filter(row => !known.has(row.id));
    if (!fresh.length) return;
    const next = [...fresh, ...stored].slice(0, 200);
    setLog(next);
    try {
      localStorage.setItem(logKey, JSON.stringify(next));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [active, validCards]);

  if (!active) return null;
  return (
    <div className="mentor-page">
      <div className="mentor-page-head">
        <div><h1>Stock Scanner</h1><p>Paper signals for RELIANCE, SBIN and ICICIBANK.</p></div>
      </div>
      {error && <p role="alert">{error}</p>}
      {scan?.failures?.length > 0 && <p>Data unavailable for {scan.failures.join(', ')}.</p>}
      {storageError && <p role="alert">This browser could not save the signal log.</p>}
      {!error && !cards.length && <p role="status">{scan ? scan.status || 'No confirmed setup for the selected size and risk budget.' : 'Checking stock setups…'}</p>}
      {cards.length > 0 && <p>Ranked by estimated reward to risk. Estimates use delta, the displayed spread and a flat ₹100 allowance for charges.</p>}
      <StockPaperPosition cards={cards} onCloseTrade={onCloseTrade} />
      <details className="panel">
        <summary>Paper signal log ({log.length})</summary>
        {log.map(row => <p key={row.id}>{ist(row.recordedAt)} · {row.stock} {row.side} · {row.strike} · {row.setup} · {row.lots} lots · risk {money(row.risk)}</p>)}
      </details>
    </div>
  );
}
