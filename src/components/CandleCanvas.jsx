// Zoomable candlestick drawing (TradingView Lightweight Charts, Apache-2.0).
// It only draws the candles and price lines it is given. No strategy reads from it.
import { useEffect, useRef } from 'react';
import { CandlestickSeries, createChart, LineStyle } from 'lightweight-charts';

// The library labels time as UTC, so shift by +5:30 to label it in India time.
const IST_OFFSET_SECONDS = 19800;
const LEVEL_STYLE = {
  vwap: { color: '#F2B84B', lineStyle: LineStyle.Dashed },
  orh: { color: '#8A94A6', lineStyle: LineStyle.Dotted },
  orl: { color: '#8A94A6', lineStyle: LineStyle.Dotted },
  entry: { color: '#4C7DFF', lineStyle: LineStyle.Solid },
  stop: { color: '#F0616D', lineStyle: LineStyle.Dashed },
  target: { color: '#2ECC8F', lineStyle: LineStyle.Dashed }
};

export default function CandleCanvas({ candles, levels, viewKey, visibleCandles, onHover, label }) {
  const holder = useRef(null);
  const api = useRef(null);
  const fitted = useRef('');
  const hover = useRef(onHover);
  hover.current = onHover;
  const keep = useRef([]);
  keep.current = levels.filter(level => ['entry', 'stop', 'target'].includes(level.key)).map(level => level.value);

  useEffect(() => {
    const element = holder.current;
    const chart = createChart(element, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: getComputedStyle(element).color, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: 'rgba(138,148,166,.12)' }, horzLines: { color: 'rgba(138,148,166,.12)' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 5, minBarSpacing: 1 },
      localization: { locale: 'en-IN' },
      // A vertical swipe still scrolls the page; sideways drag and pinch move and zoom the chart.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true }
    });
    const series = chart.addSeries(CandlestickSeries, {
      // Keep the entry, stop and target lines on screen along with the candles.
      autoscaleInfoProvider: original => {
        const info = original();
        if (!info?.priceRange) return info;
        const prices = keep.current;
        return { ...info, priceRange: { minValue: Math.min(info.priceRange.minValue, ...prices), maxValue: Math.max(info.priceRange.maxValue, ...prices) } };
      },
      upColor: '#2ECC8F', downColor: '#F0616D', wickUpColor: '#2ECC8F', wickDownColor: '#F0616D', borderVisible: false
    });
    chart.subscribeCrosshairMove(event => {
      const bar = event.time ? event.seriesData.get(series) : null;
      hover.current?.(bar || null);
    });
    api.current = { chart, series, lines: [] };
    return () => {
      api.current = null;
      fitted.current = '';
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const current = api.current;
    if (!current) return;
    const byTime = new Map(candles.map(row => [row.time + IST_OFFSET_SECONDS, row]));
    current.series.setData([...byTime.entries()].sort((a, b) => a[0] - b[0])
      .map(([time, row]) => ({ time, open: row.open, high: row.high, low: row.low, close: row.close })));
    // Set the starting zoom once per day and timeframe; refreshes keep the user's own zoom.
    if (fitted.current !== viewKey && byTime.size) {
      fitted.current = viewKey;
      showLatest();
    }
  }, [candles, viewKey]);

  const levelKey = levels.map(level => `${level.key}:${level.name}:${level.value}`).join('|');
  useEffect(() => {
    const current = api.current;
    if (!current) return;
    current.lines.forEach(line => current.series.removePriceLine(line));
    current.lines = levels.map(level => current.series.createPriceLine({
      price: level.value, title: level.name, lineWidth: 1, axisLabelVisible: true, ...LEVEL_STYLE[level.key]
    }));
  }, [levelKey]);

  function showLatest() {
    const total = api.current?.series.data().length || 0;
    if (!total) return;
    api.current.chart.priceScale('right').applyOptions({ autoScale: true });
    api.current.chart.timeScale().setVisibleLogicalRange({ from: total - visibleCandles, to: total + 4 });
  }

  function zoom(factor) {
    const scale = api.current?.chart.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (!range) return;
    const width = Math.max(10, (range.to - range.from) * factor);
    scale.setVisibleLogicalRange({ from: range.to - width, to: range.to });
  }

  return (
    <div className="nifty-chart-canvas-wrap">
      <div className="nifty-chart-canvas" ref={holder} role="img" aria-label={label}
        data-candle-count={candles.length} data-levels={levels.map(level => level.name).join(',')} />
      <div className="nifty-chart-zoom" role="group" aria-label="Chart zoom">
        <button type="button" aria-label="Zoom out" onClick={() => zoom(1.4)}>−</button>
        <button type="button" aria-label="Zoom in" onClick={() => zoom(1 / 1.4)}>+</button>
        <button type="button" onClick={showLatest}>Latest</button>
      </div>
    </div>
  );
}
