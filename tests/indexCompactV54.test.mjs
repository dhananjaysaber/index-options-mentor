import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('redundant strategy mode is absent from React and both strategies remain navigable', () => {
  const app = read('src/AppV3.jsx');
  assert.doesNotMatch(app, /<StrategyModeBar|function StrategyModeBar|STRATEGY MODE/);
  assert.match(app, /label="13-Point"/);
  assert.match(app, /label="Scalp"/);
  assert.match(app, /className="premium-mobile-bottom-nav"/);
  assert.match(app, /setStrategyMode\('core'\); navigate\('dashboard'\)/);
  assert.match(app, /setStrategyMode\('scalp'\); navigate\('dashboard'\)/);
});

test('Scalp chart renders no duplicate metrics or explanation block', () => {
  const scalp = read('src/components/ScalpMentorDashboard.jsx');
  assert.match(scalp, /premium-scalp-chart-panel/);
  assert.match(scalp, /showLevelSummary=\{false\}/);
  assert.match(scalp, /showRuleNote=\{false\}/);
  assert.doesNotMatch(scalp, /3-minute scalp structure|Scalp mode uses 5-minute directional context/);
  assert.match(scalp, /onClick=\{openManualScalp\}/);
  assert.match(scalp, /onClick=\{quickSellScalp\}/);
});

test('new premium chart extends the plot without increasing card chrome', () => {
  const css = read('src/index-compact-v54.css');
  postcss.parse(css, { from: 'src/index-compact-v54.css' });
  assert.match(css, /premium-scalp-chart-panel \.nifty-chart-canvas-wrap/);
  assert.match(css, /height: 430px !important/);
  assert.match(css, /grid-template-columns: repeat\(4,minmax\(0,1fr\)\) !important/);
  assert.match(css, /scalp-automation-strip small/);
  assert.match(css, /display: none !important/);
  assert.match(css, /scalp-decision-top h1/);
  assert.match(css, /scalp-decision-strip/);
  assert.match(css, /nifty-chart-level-strip/);
});

test('new v54 stylesheet is last and PWA cache invalidated', () => {
  const main = read('src/main.jsx');
  const sw = read('public/sw.js');
  assert.ok(main.indexOf("import './index-compact-v54.css';") > main.indexOf("import './index-compact-v53.css';"));
  assert.match(sw, /index-options-mentor-pwa-v54-compact-chart-nav/);
  assert.doesNotMatch(read('src/AppV3.jsx'), /StockScanner|StockPaperPosition/);
});
