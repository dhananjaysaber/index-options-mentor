import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('restored pre-v54 trading components remain in place', () => {
  const mobile = read('src/components/MobileMentorDashboardV41.jsx');
  const chart = read('src/components/NiftyStrategyChart.jsx');
  const market = read('src/components/TraderMarketPanel.jsx');
  const scalp = read('src/components/ScalpMentorDashboard.jsx');
  assert.match(mobile, /mobile-live-path-block/);
  assert.match(mobile, /mobile-market-map-block/);
  assert.doesNotMatch(mobile, /premium-core-flow/);
  assert.doesNotMatch(market, /premium-context-grid|showLevelSummary=\{false\}/);
  assert.doesNotMatch(chart, /canDrawLiveCandle|viewportWidth/);
  assert.match(scalp, /3-minute scalp structure/);
  assert.doesNotMatch(scalp, /premium-scalp-chart-panel/);
});

test('top strategy toggle is truly removed; existing Home/Scalp navigation persists', () => {
  const app = read('src/AppV3.jsx');
  assert.doesNotMatch(app, /<StrategyModeBar|function StrategyModeBar|STRATEGY MODE/);
  assert.match(app, /className="premium-mobile-bottom-nav"/);
  assert.match(app, /label="13-Point"/);
  assert.match(app, /label="Scalp"/);
  assert.match(app, /setStrategyMode\('core'\); navigate\('dashboard'\)/);
  assert.match(app, /setStrategyMode\('scalp'\); navigate\('dashboard'\)/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition|strategyMode === 'stock'/);
});

test('Advanced is default and Basic/Advanced selector exists only in hamburger drawer', () => {
  const app = read('src/AppV3.jsx');
  assert.match(app, /const \[mode, setMode\] = useState\('advanced'\)/);
  assert.match(app, /className="segmented drawer-segmented" role="group" aria-label="Select Basic or Advanced view"/);
  assert.match(app, /setMode\('simple'\); onClose\(\); \}\}>Basic/);
  assert.match(app, /setMode\('advanced'\); onClose\(\); \}\}>Advanced/);
  assert.doesNotMatch(app, /<div className="segmented"><button className=\{mode === 'simple'/);
  assert.match(app, /mode === 'advanced' && <QuickChecklist/);
  assert.match(app, /mode=\{mode\}/);
});

test('desktop hamburger can expose the same controls, and v52 chart styles stay untouched', () => {
  const css = read('src/view-mode-menu-v55.css');
  postcss.parse(css, { from: 'src/view-mode-menu-v55.css' });
  assert.match(css, /@media \(min-width: 821px\)/);
  assert.match(css, /\.mentor-v2-menu-button/);
  assert.match(css, /\.mentor-drawer-backdrop/);
  assert.match(css, /\.drawer-segmented/);
  const main = read('src/main.jsx');
  assert.ok(main.indexOf("import './view-mode-menu-v55.css';") > main.indexOf("import './iphone-shell-v52.css';"));
  assert.doesNotMatch(main, /index-compact-v53|index-compact-v54/);
  assert.match(read('public/sw.js'), /index-options-mentor-pwa-v58-target-index-runner/);
});
