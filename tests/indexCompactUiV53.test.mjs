import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('13-Point mobile chart comes after decision, with position safety first', () => {
  const jsx = read('src/components/MobileMentorDashboardV41.jsx');
  const decision = jsx.indexOf('<TraderDecisionBanner');
  const position = jsx.indexOf('{position && (');
  const market = jsx.indexOf('<TraderMarketPanel');
  const plan = jsx.indexOf('<CoreResearchPanel');
  assert.ok(decision > 0 && position > decision && market > position && plan > market);
  assert.match(jsx, /<details className="mobile-flow-block premium-core-details">/);
  assert.match(jsx, /<LivePositionPanel/);
  assert.match(jsx, /<PositionAlertBanner/);
});

test('market map shows ONE VWAP/ORH/ORL/PDH/PDL/ATR summary', () => {
  const market = read('src/components/TraderMarketPanel.jsx');
  for (const key of ['market.vwap', 'market.orh', 'market.orl', 'market.pdh', 'market.pdl', 'market.atr5']) {
    assert.ok(market.includes(key), key);
  }
  assert.match(market, /showLevelSummary=\{false\}/);
  assert.match(market, /showRuleNote=\{false\}/);
  assert.doesNotMatch(market, /mentor-reasoning|putCallOiRatio|market.vix/);
  assert.doesNotMatch(read('src/components/CoreResearchPanel.jsx'), /Candidate monitoring is not a trade/);
});

test('SVG chart adapts visible candle count and horizontal model to mobile viewport', () => {
  const jsx = read('src/components/NiftyStrategyChart.jsx');
  assert.match(jsx, /ResizeObserver/);
  assert.match(jsx, /canvasWidth < 520/);
  assert.match(jsx, /viewBox=\{[^\n]*canvasWidth/);
  assert.match(jsx, /buildChartModel\(displayCandles, snapshot, position, visibleCount, futureSlots, canvasWidth\)/);
  assert.match(jsx, /plotRight: right/);
  assert.match(jsx, /showLevelSummary &&/);
  assert.match(jsx, /showRuleNote && strategyNote/);
});

test('premium CSS hides the extra mobile strategy toggle and enlarges chart', () => {
  const css = read('src/index-compact-v53.css');
  postcss.parse(css, { from: 'src/index-compact-v53.css' });
  assert.match(css, /@media\(max-width:820px\)/);
  assert.match(css, /\.premium-fintech-shell \.premium-strategy-bar,\s*\.premium-fintech-shell \.strategy-mode-bar \{display:none !important;\}/);
  assert.match(css, /height:410px !important/);
  assert.match(css, /grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.doesNotMatch(read('src/AppV3.jsx'), /StockScanner|StockPaperPosition/);
});

test('premium responsive CSS is last and PWA cache is versioned', () => {
  const main = read('src/main.jsx');
  const sw = read('public/sw.js');
  assert.ok(main.indexOf("import './index-compact-v53.css';") > main.indexOf("import './iphone-shell-v52.css';"));
  assert.match(sw, /index-options-mentor-pwa-v54-compact-chart-nav/);
});
