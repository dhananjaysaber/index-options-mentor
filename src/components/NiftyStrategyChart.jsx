import { useEffect, useMemo, useRef, useState } from 'react';
import CandleCanvas from './CandleCanvas.jsx';
import useLiveQuote from '../hooks/useLiveQuote.js';
import { FYERS_REFRESH, isNseMarketHours } from '../services/fyersRefreshPolicy.js';
import { assessMarketFreshness } from '../services/marketFreshness.js';

// Display only. visibleCandles is the starting zoom; the user can zoom and scroll from there.
const TIMEFRAMES = {
  '1': { label: '1m', shortLabel: '1m', seconds: 60, maxCandles: 1900, visibleCandles: 60 },
  '3': { label: '3m', shortLabel: '3m', seconds: 180, maxCandles: 700, visibleCandles: 56 },
  '5': { label: '5m', shortLabel: '5m', seconds: 300, maxCandles: 420, visibleCandles: 48 },
  '15': { label: '15m', shortLabel: '15m', seconds: 900, maxCandles: 160, visibleCandles: 40 }
};
// Calendar days of earlier candles to load, so there is something to scroll back to over a weekend.
const LOOKBACK_DAYS = 5;
const NO_CANDLES = [];

export default function NiftyStrategyChart({ snapshot, position = null, compact = false, defaultTimeframe = '5', strategyNote = '', availableTimeframes = ['1', '3', '5'] }) {
  const liveQuote = useLiveQuote();
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[defaultTimeframe] ? defaultTimeframe : '5');
  const [loaded, setLoaded] = useState({ key: '', rows: [] });
  const [hovered, setHovered] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const sessionDate = snapshot?.market?.sessionDate || '';
  const timeframeConfig = TIMEFRAMES[timeframe] || TIMEFRAMES['5'];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const viewKey = `${sessionDate}:${timeframe}`;
  // Never draw one timeframe's candles under another timeframe's button.
  const candles = loaded.key === viewKey ? loaded.rows : NO_CANDLES;

  useEffect(() => {
    if (!sessionDate) {
      setLoaded({ key: '', rows: [] });
      setError('');
      return undefined;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          symbol: 'NSE:NIFTY50-INDEX',
          resolution: timeframe,
          from: daysBefore(sessionDate, LOOKBACK_DAYS),
          to: sessionDate
        });
        const response = await fetch(`/api/fyers/history?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Live chart data is unavailable.');
        const data = await response.json();
        const rows = Array.isArray(data?.candles) ? data.candles : [];
        const parsed = rows
          .map(row => normaliseCandle(row))
          .filter(Boolean)
          .slice(-timeframeConfig.maxCandles);
        if (!cancelled) {
          setLoaded({ key: viewKey, rows: parsed });
          setError(parsed.length ? '' : `No ${timeframeConfig.label} candles are available yet.`);
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Live chart data is unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && isNseMarketHours()) void load();
    }, FYERS_REFRESH.chartMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionDate, timeframe, timeframeConfig.label, timeframeConfig.maxCandles]);

  const liveSpot = priceOrNull(liveQuote?.nifty)
    ?? priceOrNull(position?.underlyingCurrent)
    ?? priceOrNull(snapshot?.market?.spot);
  const liveTimestamp = liveQuote?.at ? new Date(liveQuote.at).getTime() : now;
  const marketOpen = isNseMarketHours();
  // Outside market hours the last price must not be drawn as a new candle.
  const displayCandles = useMemo(
    () => (candles.length && marketOpen
      ? mergeLiveCandle(candles, liveSpot, liveTimestamp, timeframeConfig.seconds, timeframeConfig.maxCandles)
      : candles),
    [candles, marketOpen, liveSpot, liveTimestamp, timeframeConfig.seconds, timeframeConfig.maxCandles]
  );
  const levels = strategyLevels(snapshot, position);
  const side = position?.side || snapshot?.decision?.side || '';
  const retest = snapshot?.setup?.retestStatus || 'NOT_STARTED';
  const latest = displayCandles.at(-1) || null;
  const shown = hovered || latest;
  const countdown = formatCountdown(secondsToBoundary(now, timeframeConfig.seconds));
  const change = latest ? latest.close - latest.open : null;
  const changePct = latest && latest.open ? (change / latest.open) * 100 : null;
  const chartLive = Boolean(snapshot?.live && assessMarketFreshness({
    snapshot, quote: liveQuote, authenticated: true, now
  }).ready);

  return (
    <section className={`nifty-strategy-chart live-trading-chart ${compact ? 'compact' : ''}`} aria-label={`Live NIFTY ${timeframeConfig.label} strategy chart`}>
      <div className="nifty-live-toolbar">
        <div className="nifty-live-title">
          <div className="nifty-live-symbol-row">
            <strong>NIFTY 50 · {timeframeConfig.shortLabel}</strong>
            <span className={`nifty-live-status ${chartLive ? 'online' : ''}`}><i />{chartLive ? 'LIVE' : snapshot?.live ? 'UPDATING' : 'SESSION'}</span>
          </div>
          <div className="nifty-live-quote-row">
            <span className="nifty-live-price">{liveSpot != null ? formatPrice(liveSpot) : '—'}</span>
            {change != null && <span className={change >= 0 ? 'nifty-live-change up' : 'nifty-live-change down'}>{signed(change)} {changePct != null ? `(${signed(changePct)}%)` : ''}</span>}
          </div>
        </div>

        <div className="nifty-chart-timeframe-tabs" role="group" aria-label="Chart timeframe">
          {Object.entries(TIMEFRAMES).filter(([value]) => availableTimeframes.includes(value)).map(([value, config]) => (
            <button key={value} type="button" className={timeframe === value ? 'active' : ''} onClick={() => setTimeframe(value)} aria-pressed={timeframe === value}>
              {config.label}
            </button>
          ))}
        </div>
      </div>

      <div className="nifty-live-context-row">
        <div className="nifty-chart-badges">
          <span className={`nifty-chart-bias ${side ? `side-${side.toLowerCase()}` : ''}`}>{side ? `${side} BIAS` : 'NO BIAS'}</span>
          <span className={`nifty-chart-retest retest-${String(retest).toLowerCase()}`}>RETEST {retest}</span>
        </div>
        <span className="nifty-live-countdown">CANDLE {countdown}</span>
      </div>

      {shown && (
        <div className="nifty-ohlc-strip">
          <span>O <strong>{formatPrice(shown.open)}</strong></span>
          <span>H <strong>{formatPrice(shown.high)}</strong></span>
          <span>L <strong>{formatPrice(shown.low)}</strong></span>
          <span>C <strong>{formatPrice(shown.close)}</strong></span>
        </div>
      )}

      {loading && !displayCandles.length ? (
        <div className="nifty-chart-empty">Loading {timeframeConfig.label} candles…</div>
      ) : error && !displayCandles.length ? (
        <div className="nifty-chart-empty">{error}</div>
      ) : displayCandles.length ? (
        <>
          <CandleCanvas candles={displayCandles} levels={levels} viewKey={viewKey} visibleCandles={timeframeConfig.visibleCandles}
            onHover={setHovered} label={`NIFTY ${timeframeConfig.label} candlestick chart with strategy levels`} />

          <div className="nifty-chart-level-strip">
            <LevelChip label="VWAP" value={snapshot?.market?.vwap} />
            <LevelChip label="ORH" value={snapshot?.market?.orh} />
            <LevelChip label="ORL" value={snapshot?.market?.orl} />
            <LevelChip label="PDH" value={snapshot?.market?.pdh} />
            <LevelChip label="PDL" value={snapshot?.market?.pdl} />
            <LevelChip label={position ? 'ENTRY' : 'TRIGGER'} value={position?.underlyingEntry ?? snapshot?.structure?.trigger} />
            <LevelChip label="STOP" value={position?.underlyingStop ?? snapshot?.structure?.underlyingStop} />
            <LevelChip label="TARGET" value={position?.underlyingTarget ?? snapshot?.structure?.underlyingTarget} />
          </div>
          <div className="nifty-chart-rule-note">{strategyNote || 'Mentor entry logic remains based on completed 5-minute candles. The 3-minute tab changes the visual view only.'}</div>
        </>
      ) : (
        <div className="nifty-chart-empty">Waiting for NIFTY chart data.</div>
      )}
    </section>
  );
}

function LevelChip({ label, value }) {
  const n = priceOrNull(value);
  return <div className="nifty-chart-level-chip"><span>{label}</span><strong>{n != null ? formatPrice(n) : '—'}</strong></div>;
}

function normaliseCandle(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [time, open, high, low, close, volume] = row.map(Number);
  if (![time, open, high, low, close].every(Number.isFinite) || close <= 0) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function mergeLiveCandle(rows, spot, timestampMs, timeframeSeconds, maxCandles) {
  if (!Number.isFinite(Number(spot)) || Number(spot) <= 0) return rows.slice(-maxCandles);
  const price = Number(spot);
  const epochSeconds = Math.floor((Number.isFinite(timestampMs) ? timestampMs : Date.now()) / 1000);
  const bucket = Math.floor(epochSeconds / timeframeSeconds) * timeframeSeconds;
  const next = rows.map(row => ({ ...row }));
  const last = next.at(-1);

  if (!last || last.time < bucket) {
    next.push({ time: bucket, open: price, high: price, low: price, close: price, volume: 0, live: true });
  } else if (last.time === bucket) {
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.close = price;
    last.live = true;
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
  }

  return next.slice(-maxCandles);
}

function strategyLevels(snapshot, position) {
  return [
    ['vwap', 'VWAP', snapshot?.market?.vwap],
    ['orh', 'ORH', snapshot?.market?.orh],
    ['orl', 'ORL', snapshot?.market?.orl],
    ['entry', position ? 'ENTRY' : 'TRIGGER', position?.underlyingEntry ?? snapshot?.structure?.trigger],
    ['stop', 'STOP', position?.underlyingStop ?? snapshot?.structure?.underlyingStop],
    ['target', 'TARGET', position?.underlyingTarget ?? snapshot?.structure?.underlyingTarget]
  ].map(([key, name, value]) => ({ key, name, value: priceOrNull(value) })).filter(level => level.value != null);
}

function daysBefore(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return dateKey;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function secondsToBoundary(nowMs, intervalSeconds) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const elapsed = nowSeconds % intervalSeconds;
  return elapsed === 0 ? intervalSeconds : intervalSeconds - elapsed;
}

function formatCountdown(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  const min = Math.floor(value / 60);
  const sec = String(value % 60).padStart(2, '0');
  return `${String(min).padStart(2, '0')}:${sec}`;
}

function formatPrice(value) {
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function priceOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function signed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
}
