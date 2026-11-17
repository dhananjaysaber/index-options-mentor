import { useEffect, useMemo, useState } from 'react';
import useLiveQuote from '../hooks/useLiveQuote.js';
import { FYERS_REFRESH, isNseMarketHours } from '../services/fyersRefreshPolicy.js';

const TIMEFRAMES = {
  '5': { label: '5 min', shortLabel: '5m', seconds: 300, maxCandles: 64, visibleCandles: 48, rightPaddingSlots: 6 },
  '3': { label: '3 min', shortLabel: '3m', seconds: 180, maxCandles: 84, visibleCandles: 56, rightPaddingSlots: 7 }
};

export default function NiftyStrategyChart({ snapshot, position = null, compact = false, defaultTimeframe = '5', strategyNote = '' }) {
  const liveQuote = useLiveQuote();
  const [timeframe, setTimeframe] = useState(TIMEFRAMES[defaultTimeframe] ? defaultTimeframe : '5');
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const sessionDate = snapshot?.market?.sessionDate || '';
  const timeframeConfig = TIMEFRAMES[timeframe] || TIMEFRAMES['5'];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!sessionDate) {
      setCandles([]);
      setError('');
      return undefined;
    }

    let cancelled = false;

    const load = async () => {
      setLoading(current => current || candles.length === 0);
      try {
        const params = new URLSearchParams({
          symbol: 'NSE:NIFTY50-INDEX',
          resolution: timeframe,
          from: sessionDate,
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
          setCandles(parsed);
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
  const displayCandles = useMemo(
    () => mergeLiveCandle(candles, liveSpot, liveTimestamp, timeframeConfig.seconds, timeframeConfig.maxCandles),
    [candles, liveSpot, liveTimestamp, timeframeConfig.seconds, timeframeConfig.maxCandles]
  );
  const chart = useMemo(
    () => buildChartModel(displayCandles, snapshot, position, timeframeConfig.visibleCandles, timeframeConfig.rightPaddingSlots),
    [displayCandles, snapshot, position, timeframeConfig.visibleCandles, timeframeConfig.rightPaddingSlots]
  );
  const side = position?.side || snapshot?.decision?.side || '';
  const retest = snapshot?.setup?.retestStatus || 'NOT_STARTED';
  const latest = displayCandles.at(-1) || null;
  const countdown = formatCountdown(secondsToBoundary(now, timeframeConfig.seconds));
  const change = latest ? latest.close - latest.open : null;
  const changePct = latest && latest.open ? (change / latest.open) * 100 : null;

  return (
    <section className={`nifty-strategy-chart live-trading-chart ${compact ? 'compact' : ''}`} aria-label={`Live NIFTY ${timeframeConfig.label} strategy chart`}>
      <div className="nifty-live-toolbar">
        <div className="nifty-live-title">
          <div className="nifty-live-symbol-row">
            <strong>NIFTY 50 · {timeframeConfig.shortLabel}</strong>
            <span className={`nifty-live-status ${snapshot?.live ? 'online' : ''}`}><i />{snapshot?.live ? 'LIVE' : 'SESSION'}</span>
          </div>
          <div className="nifty-live-quote-row">
            <span className="nifty-live-price">{liveSpot != null ? formatPrice(liveSpot) : '—'}</span>
            {change != null && <span className={change >= 0 ? 'nifty-live-change up' : 'nifty-live-change down'}>{signed(change)} {changePct != null ? `(${signed(changePct)}%)` : ''}</span>}
          </div>
        </div>

        <div className="nifty-chart-timeframe-tabs" role="group" aria-label="Chart timeframe">
          {Object.entries(TIMEFRAMES).map(([value, config]) => (
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

      {latest && (
        <div className="nifty-ohlc-strip">
          <span>O <strong>{formatPrice(latest.open)}</strong></span>
          <span>H <strong>{formatPrice(latest.high)}</strong></span>
          <span>L <strong>{formatPrice(latest.low)}</strong></span>
          <span>C <strong>{formatPrice(latest.close)}</strong></span>
        </div>
      )}

      {loading && !displayCandles.length ? (
        <div className="nifty-chart-empty">Loading {timeframeConfig.label} candles…</div>
      ) : error && !displayCandles.length ? (
        <div className="nifty-chart-empty">{error}</div>
      ) : chart ? (
        <>
          <div className="nifty-chart-canvas-wrap">
            <svg className="nifty-chart-canvas" viewBox="0 0 920 390" preserveAspectRatio="xMidYMid meet" role="img" aria-label={`NIFTY ${timeframeConfig.label} candlestick chart with strategy levels`}>
              <rect x="0" y="0" width="920" height="390" className="nifty-chart-bg" />

              {chart.grid.map((row, index) => (
                <g key={`grid-${index}`}>
                  <line x1="42" x2="824" y1={row.y} y2={row.y} className="nifty-chart-grid" />
                  <text x="840" y={row.y + 4} className="nifty-chart-price-label">{formatPrice(row.value)}</text>
                </g>
              ))}

              {chart.levels.map(level => (
                <g key={level.key} className={`nifty-level nifty-level-${level.kind}`}>
                  <line x1="42" x2="824" y1={level.y} y2={level.y} className="nifty-level-line" />
                  <rect x="48" y={level.y - 9} width={level.labelWidth} height="18" rx="5" className="nifty-level-pill" />
                  <text x="54" y={level.y + 3} className="nifty-level-label">{level.label}</text>
                </g>
              ))}

              {chart.candles.map(candle => (
                <g key={candle.key} className={candle.close >= candle.open ? 'nifty-candle bullish' : 'nifty-candle bearish'}>
                  <line x1={candle.x} x2={candle.x} y1={candle.highY} y2={candle.lowY} className="nifty-candle-wick" />
                  <rect x={candle.x - candle.bodyWidth / 2} y={candle.bodyY} width={candle.bodyWidth} height={candle.bodyHeight} rx="1" className="nifty-candle-body" />
                </g>
              ))}

              {chart.timeLabels.map(label => (
                <text key={label.key} x={label.x} y="374" textAnchor="middle" className="nifty-chart-time-label">{label.label}</text>
              ))}

              {chart.current && (
                <g className="nifty-current-price-line">
                  <line x1="42" x2="824" y1={chart.current.y} y2={chart.current.y} />
                  <rect x="824" y={chart.current.y - 22} width="92" height="44" rx="5" />
                  <text x="832" y={chart.current.y - 3} className="nifty-current-price-value">{formatPrice(chart.current.value)}</text>
                  <text x="832" y={chart.current.y + 14} className="nifty-current-countdown">{countdown}</text>
                </g>
              )}
            </svg>
          </div>

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

function buildChartModel(rows, snapshot, position, visibleCount = 52, rightPaddingSlots = 6) {
  if (!rows.length) return null;

  const visibleRows = rows.slice(-visibleCount);
  const width = 782;
  const left = 42;
  const right = 824;
  const top = 18;
  const bottom = 350;
  const plotHeight = bottom - top;
  const lows = visibleRows.map(row => row.low).filter(value => Number.isFinite(value) && value > 0);
  const highs = visibleRows.map(row => row.high).filter(value => Number.isFinite(value) && value > 0);
  if (!lows.length || !highs.length) return null;

  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const rawRange = Math.max(8, max - min);
  min -= rawRange * 0.1;
  max += rawRange * 0.1;
  const range = Math.max(1, max - min);
  const yFor = value => top + ((max - value) / range) * plotHeight;

  // Keep a small "future" area to the right, like a broker chart.
  // This keeps the newest candle clearly visible instead of pinning it
  // underneath the live-price marker / right-hand price scale.
  const dataSlots = visibleCount;
  const futureSlots = Math.max(4, Number(rightPaddingSlots) || 6);
  const totalSlots = dataSlots + futureSlots;
  const spacing = width / totalSlots;
  const offsetSlots = Math.max(0, dataSlots - visibleRows.length);
  const bodyWidth = Math.max(4, Math.min(10, spacing * 0.62));

  const candles = visibleRows.map((row, index) => {
    const x = left + spacing * (offsetSlots + index) + spacing / 2;
    const openY = yFor(row.open);
    const closeY = yFor(row.close);
    return {
      ...row,
      key: `${row.time}-${index}`,
      x,
      highY: yFor(row.high),
      lowY: yFor(row.low),
      bodyY: Math.min(openY, closeY),
      bodyHeight: Math.max(2.2, Math.abs(openY - closeY)),
      bodyWidth
    };
  });

  const levelSpecs = [
    ['vwap', 'VWAP', snapshot?.market?.vwap, 'context'],
    ['orh', 'ORH', snapshot?.market?.orh, 'range'],
    ['orl', 'ORL', snapshot?.market?.orl, 'range'],
    ['trigger', position ? 'ENTRY' : 'TRIGGER', position?.underlyingEntry ?? snapshot?.structure?.trigger, 'entry'],
    ['stop', 'INVALIDATION', position?.underlyingStop ?? snapshot?.structure?.underlyingStop, 'stop'],
    ['target', 'TARGET', position?.underlyingTarget ?? snapshot?.structure?.underlyingTarget, 'target']
  ];

  const levels = levelSpecs
    .map(([key, name, value, kind]) => ({ key, name, value: priceOrNull(value), kind }))
    .filter(level => level.value != null && level.value >= min && level.value <= max)
    .map(level => {
      const label = `${level.name} ${formatPrice(level.value)}`;
      return { ...level, y: yFor(level.value), label, labelWidth: Math.max(68, Math.min(148, 10 + label.length * 5.8)) };
    });

  const grid = Array.from({ length: 6 }, (_, index) => {
    const value = max - (range * index) / 5;
    return { value, y: yFor(value) };
  });

  const lastIndex = visibleRows.length - 1;
  const timeIndexes = [...new Set([0, Math.floor(lastIndex / 3), Math.floor((lastIndex * 2) / 3), lastIndex])].filter(index => index >= 0);
  const timeLabels = timeIndexes.map(index => ({
    key: `time-${visibleRows[index].time}-${index}`,
    x: left + spacing * (offsetSlots + index) + spacing / 2,
    label: formatTime(visibleRows[index].time)
  }));
  const last = candles.at(-1);

  return {
    candles,
    levels,
    grid,
    timeLabels,
    current: { x: last.x, y: yFor(last.close), value: last.close }
  };
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

function formatTime(epochSeconds) {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(epochSeconds * 1000));
  } catch { return ''; }
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
