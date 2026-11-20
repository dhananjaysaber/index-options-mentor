import test from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readFileSync } from 'node:fs';
import {
  computeScalpOptionTrail,
  isFreshScalpOptionQuote,
  isScalpOptionTrailBreached
} from '../src/engine/scalpOptionTrail.js';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const entry = 168;
const quantity = 650; // 10 NIFTY lots x 65 at screenshot date

test('option P&L trailing arms on actual +₹8,000 gross profit even if NIFTY bestR is +0.41', () => {
  const trail = computeScalpOptionTrail({
    entryPrice: entry, quantity, peakGrossPnl: 8000
  });
  assert.equal(trail.active, true);
  assert.equal(trail.armAtGrossPnl, 3276);
  assert.equal(trail.floorPnl, 4000);
  const now = Date.now();
  const position = {
    strategyFamily: 'SCALP',
    bestR: 0.41,
    optionTrailingActive: trail.active,
    optionTrailingFloorPnl: trail.floorPnl,
    currentUnrealizedPnl: 3500,
    lastOptionQuoteAt: new Date(now).toISOString(),
    quantity
  };
  assert.equal(isScalpOptionTrailBreached(position, now), true);
  assert.equal(isScalpOptionTrailBreached({ ...position, currentUnrealizedPnl: 4100 }, now), false);
  assert.equal(isScalpOptionTrailBreached({ ...position, currentUnrealizedPnl: -11050 }, now), true,
    'A large gap must cause an exit at currently observed gross P&L, never fake a +₹4k fill');
});

test('option trailing floor never retreats after price falls', () => {
  const first = computeScalpOptionTrail({ entryPrice: entry, quantity, peakGrossPnl: 8000 });
  const second = computeScalpOptionTrail({
    entryPrice: entry, quantity, peakGrossPnl: 7000, previousFloorPnl: first.floorPnl
  });
  const third = computeScalpOptionTrail({
    entryPrice: entry, quantity, peakGrossPnl: 15000, previousFloorPnl: second.floorPnl
  });
  assert.equal(second.floorPnl, 4000);
  assert.equal(third.floorPnl, 7500);
  assert.equal(computeScalpOptionTrail({
    entryPrice: entry, quantity, peakGrossPnl: 500, previousFloorPnl: 4000
  }).floorPnl, 4000);
});

test('small option gains do not arm the trail before the 3% threshold', () => {
  assert.equal(computeScalpOptionTrail({ entryPrice: entry, quantity, peakGrossPnl: 3275 }).active, false);
  assert.equal(computeScalpOptionTrail({ entryPrice: entry, quantity, peakGrossPnl: 3276 }).floorPnl, 1638);
  assert.equal(computeScalpOptionTrail({ entryPrice: 0, quantity, peakGrossPnl: 8000 }).active, false);
  assert.equal(computeScalpOptionTrail({ entryPrice: entry, quantity: 0, peakGrossPnl: 8000 }).active, false);
});

test('never auto-exit an option position using stale, absent or index-only data', () => {
  const now = Date.parse('2026-11-20T04:20:00Z');
  const valid = {
    strategyFamily: 'SCALP',
    optionTrailingActive: true,
    optionTrailingFloorPnl: 4000,
    currentUnrealizedPnl: 2000,
    lastOptionQuoteAt: new Date(now - 2000).toISOString(),
    quantity: 650
  };
  assert.ok(isFreshScalpOptionQuote(valid, now));
  assert.ok(isScalpOptionTrailBreached(valid, now));
  assert.equal(isScalpOptionTrailBreached({ ...valid, lastOptionQuoteAt: null }, now), false);
  assert.equal(isScalpOptionTrailBreached({ ...valid, lastOptionQuoteAt: new Date(now - 15000).toISOString() }, now), false);
  assert.equal(isScalpOptionTrailBreached({ ...valid, optionTrailingActive: false }, now), false);
  assert.equal(isScalpOptionTrailBreached({ ...valid, strategyFamily: 'CORE' }, now), false);
  assert.equal(isScalpOptionTrailBreached({ ...valid, quantity: 0 }, now), false);
});

test('integration keeps the index-R trail, stop, target and 12m time limit independent', () => {
  const app = read('src/AppV3.jsx');
  assert.match(app, /const trail = scalpTrail\(bestR, current.scalpTrailingFloorR\)/);
  assert.match(app, /SCALP_TRAILING_STOP/);
  assert.match(app, /SCALP_OPTION_PROFIT_TRAIL/);
  assert.match(app, /SCALP_TIME_EXIT/);
  assert.match(app, /computeScalpOptionTrail/);
  assert.match(app, /lastOptionQuoteAt: hasCurrentOptionQuote/);
  assert.match(app, /isScalpOptionTrailBreached\(scalpPosition\)/);
  assert.match(app, /scalpPosition\?\.lastOptionQuoteAt/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition/);
});

test('What matters now remains readable and appears ahead of position-metric grid', () => {
  const panel = read('src/components/LivePositionPanel.jsx');
  const css = read('src/scalp-profit-protection-v56.css');
  postcss.parse(css, { from: 'src/scalp-profit-protection-v56.css' });
  assert.ok(panel.indexOf('position-guidance position-guidance-compact') <
    panel.indexOf('<div className="position-essential-grid">'));
  assert.match(panel, /scalp-option-trail-indicator/);
  assert.match(css, /\.position-guidance\.position-guidance-compact\.wait/);
  assert.match(css, /background: #392d1b !important/);
  assert.match(css, /color: #fff3d8 !important/);
  const main = read('src/main.jsx');
  assert.ok(main.indexOf('scalp-profit-protection-v56.css') >
    main.indexOf('view-mode-menu-v55.css'));
  assert.match(read('public/sw.js'), /index-options-mentor-pwa-v58-target-index-runner/);
});
