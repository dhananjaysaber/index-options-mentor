import { useEffect, useMemo, useState } from 'react';

const MAX_CANDLES = 54;

export default function NiftyStrategyChart({ snapshot, position = null, compact = false }) {
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const sessionDate = snapshot?.market?.sessionDate || '';

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
          resolution: '5',
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
          .slice(-MAX_CANDLES);
        if (!cancelled) {
          setCandles(parsed);
          setError(parsed.length ? '' : 'No 5-minute candles are available yet.');
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Live chart data is unavailable.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(load, 60000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionDate]);

  const chart = useMemo(() => buildChartModel(candles, snapshot, position), [candles, snapshot, position]);
  const side = position?.side || snapshot?.decision?.side || '';
  const retest = snapshot?.setup?.retestStatus || 'WAIT';

  return (
    <section className={`nifty-strategy-chart ${compact ? 'compact' : ''}`} aria-label="Live NIFTY five-minute strategy chart">
      <div className="nifty-chart-head">
        <div>
          <span className="nifty-chart-eyebrow">LIVE NIFTY · 5 MIN</span>
          <strong>Strategy chart</strong>
          <small>Visual confirmation of structure, VWAP, breakout, retest and risk levels.</small>
        </div>
        <div className="nifty-chart-badges">
          <span className={`nifty-chart-bias ${side ? `side-${side.toLowerCase()}` : ''}`}>{side ? `${side} BIAS` : 'NO BIAS'}</span>
          <span className={`nifty-chart-retest retest-${String(retest).toLowerCase()}`}>RETEST {retest}</span>
        </div>
      </div>

      {loading && !candles.length ? (
        <div className="nifty-chart-empty">Loading 5-minute candles…</div>
      ) : error && !candles.length ? (
        <div className="nifty-chart-empty">{error}</div>
      ) : chart ? (
        <>
          <div className="nifty-chart-canvas-wrap">
            <svg className="nifty-chart-canvas" viewBox="0 0 900 360" role="img" aria-label="NIFTY five-minute candlestick chart with strategy levels">
              <rect x="0" y="0" width="900" height="360" className="nifty-chart-bg" />
              {chart.grid.map((y, index) => (
                <g key={`grid-${index}`}>
                  <line x1="54" x2="838" y1={y.y} y2={y.y} className="nifty-chart-grid" />
                  <text x="846" y={y.y + 4} className="nifty-chart-price-label">{formatPrice(y.value)}</text>
                </g>
              ))}

              {chart.levels.map(level => (
                <g key={level.key} className={`nifty-level nifty-level-${level.kind}`}>
                  <line x1="54" x2="838" y1={level.y} y2={level.y} className="nifty-level-line" />
                  <rect x="58" y={level.y - 10} width={level.labelWidth} height="18" rx="5" className="nifty-level-pill" />
                  <text x="64" y={level.y + 3} className="nifty-level-label">{level.label}</text>
                </g>
              ))}

              {chart.candles.map(candle => (
                <g key={candle.key} className={candle.close >= candle.open ? 'nifty-candle bullish' : 'nifty-candle bearish'}>
                  <line x1={candle.x} x2={candle.x} y1={candle.highY} y2={candle.lowY} className="nifty-candle-wick" />
                  <rect x={candle.x - candle.bodyWidth / 2} y={candle.bodyY} width={candle.bodyWidth} height={candle.bodyHeight} rx="1.5" className="nifty-candle-body" />
                </g>
              ))}

              {chart.timeLabels.map(label => (
                <text key={label.key} x={label.x} y="346" textAnchor="middle" className="nifty-chart-time-label">{label.label}</text>
              ))}

              {chart.current && (
                <g className="nifty-current-marker">
                  <circle cx={chart.current.x} cy={chart.current.y} r="4.5" />
                  <text x={Math.min(780, chart.current.x + 10)} y={chart.current.y - 9}>NIFTY {formatPrice(chart.current.value)}</text>
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
        </>
      ) : (
        <div className="nifty-chart-empty">Waiting for NIFTY chart data.</div>
      )}
    </section>
  );
}

function LevelChip({ label, value }) {
  const n = Number(value);
  return (
    <div className="nifty-chart-level-chip">
      <span>{label}</span>
      <strong>{Number.isFinite(n) && n > 0 ? formatPrice(n) : '—'}</strong>
    </div>
  );
}

function normaliseCandle(row) {
  if (!Array.isArray(row) || row.length < 5) return null;
  const [time, open, high, low, close, volume] = row.map(Number);
  if (![time, open, high, low, close].every(Number.isFinite)) return null;
  return { time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
}

function buildChartModel(rows, snapshot, position) {
  if (!rows.length) return null;

  const width = 784;
  const left = 54;
  const top = 22;
  const bottom = 324;
  const plotHeight = bottom - top;
  const lows = rows.map(row => row.low);
  const highs = rows.map(row => row.high);
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const rawRange = Math.max(1, max - min);
  min -= rawRange * 0.08;
  max += rawRange * 0.08;
  const range = Math.max(1, max - min);
  const yFor = value => top + ((max - value) / range) * plotHeight;
  const spacing = width / rows.length;
  const bodyWidth = Math.max(3, Math.min(11, spacing * 0.62));

  const candles = rows.map((row, index) => {
    const x = left + spacing * index + spacing / 2;
    const openY = yFor(row.open);
    const closeY = yFor(row.close);
    return {
      ...row,
      key: `${row.time}-${index}`,
      x,
      highY: yFor(row.high),
      lowY: yFor(row.low),
      bodyY: Math.min(openY, closeY),
      bodyHeight: Math.max(1.8, Math.abs(openY - closeY)),
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
    .map(([key, name, value, kind]) => ({ key, name, value: Number(value), kind }))
    .filter(level => Number.isFinite(level.value) && level.value >= min && level.value <= max)
    .map(level => {
      const label = `${level.name} ${formatPrice(level.value)}`;
      return { ...level, y: yFor(level.value), label, labelWidth: Math.max(72, Math.min(154, 11 + label.length * 6.1)) };
    });

  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - (range * index) / 4;
    return { value, y: yFor(value) };
  });

  const timeIndexes = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor(((rows.length - 1) * 2) / 3), rows.length - 1])];
  const timeLabels = timeIndexes.map(index => ({
    key: `time-${rows[index].time}-${index}`,
    x: left + spacing * index + spacing / 2,
    label: formatTime(rows[index].time)
  }));

  const last = candles[candles.length - 1];
  return {
    candles,
    levels,
    grid,
    timeLabels,
    current: { x: last.x, y: yFor(last.close), value: last.close }
  };
}

function formatTime(epochSeconds) {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(epochSeconds * 1000));
  } catch {
    return '';
  }
}

function formatPrice(value) {
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
