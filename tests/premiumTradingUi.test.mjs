import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('premium trading CSS parses and has mobile-safe fixed action and nav clearance', () => {
  const css = read('src/premium-trading-v51.css');
  const parsed = postcss.parse(css, { from: 'premium-trading-v51.css' });
  assert.ok(parsed.nodes.length > 30);
  assert.match(css, /\.premium-mobile-bottom-nav/);
  assert.match(css, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(css, /bottom:calc\(65px \+ env\(safe-area-inset-bottom,0px\)\) !important/);
  assert.match(css, /overflow-x:hidden/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /Stock Options|stock-scanner/);
});

test('premium trading navigation uses only the 13-point and scalp strategies', () => {
  const app = read('src/AppV3.jsx');
  const main = read('src/main.jsx');
  const sw = read('public/sw.js');
  assert.match(app, /className="app-shell mentor-v2-shell research-v41-shell premium-fintech-shell"/);
  assert.match(app, /Select index strategy/);
  assert.match(app, /aria-pressed=\{!scalp\}/);
  assert.match(app, /aria-pressed=\{scalp\}/);
  assert.match(app, /className="premium-mobile-bottom-nav"/);
  assert.match(app, /aria-label="Primary trading navigation"/);
  assert.match(app, /navigate\('position'\)/);
  assert.match(app, /navigate\('history'\)/);
  assert.match(app, /marketDataReady \? 'LIVE MARKET DATA'/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition|strategyMode === 'stock'/);
  assert.ok(main.indexOf("import './premium-trading-v51.css';") >
            main.indexOf("import './footer-clearance-v42.css';"),
            'Premium design stylesheet must load last');
  assert.match(sw, /index-options-mentor-pwa-v53-compact-chart/);
});

test('premium design keeps real FYERS data and existing paper buy/sell actions', () => {
  const app = read('src/AppV3.jsx');
  const core = read('src/components/CoreQuickActions.jsx');
  const scalp = read('src/components/ScalpMentorDashboard.jsx');
  const quote = read('src/services/fyersRefreshPolicy.js');
  assert.match(app, /snapshot\?\.generatedAt/);
  assert.match(app, /role="status" aria-label="NIFTY data connection status"/);
  assert.match(core, /onTakeTrade/);
  assert.match(core, /onExit/);
  assert.match(scalp, /onClick=\{openManualScalp\}/);
  assert.match(scalp, /onClick=\{quickSellScalp\}/);
  assert.match(quote, /quoteMs/);
  assert.doesNotMatch(app, /25,450\.20|4,475\.00|12,380/);
});
