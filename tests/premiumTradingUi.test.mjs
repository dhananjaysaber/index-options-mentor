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
  assert.match(app, /className="app-shell mentor-v2-shell research-v41-shell premium-fintech-shell premium-design-shell"/);
  assert.doesNotMatch(app, /<StrategyModeBar|function StrategyModeBar|Select index strategy/);
  assert.match(app, /label="13-Point"/);
  assert.match(app, /label="Scalp"/);
  assert.match(app, /const \[mode, setMode\] = useState\('advanced'\)/);
  assert.match(app, /className="premium-mobile-bottom-nav"/);
  assert.match(app, /aria-label="Primary trading navigation"/);
  assert.match(app, /navigate\('position'\)/);
  assert.match(app, /navigate\('history'\)/);
  assert.match(app, /className="fyers-ref-data-warning" role="status"/);
  assert.match(app, /<FyersCoreTrade snapshot=\{snapshot\}/);
  assert.match(app, /<FyersScalpTrade snapshot=\{snapshot\}/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition|strategyMode === 'stock'/);
  assert.ok(main.indexOf("import './premium-trading-v51.css';") >
            main.indexOf("import './footer-clearance-v42.css';"),
            'Premium design stylesheet must load last');
  assert.match(sw, /index-options-mentor-pwa-v58-target-index-runner/);
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


// The approved v60 design is the final visual layer; protected handlers remain above.
test('approved mobile and desktop layer parses with safe-area action/nav clearance', () => {
  const css = read('src/premium-design-v60.css');
  assert.ok(postcss.parse(css).nodes.length > 30);
  assert.match(css, /grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(css, /bottom:calc\(64px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(css, /touch-action:pan-y pinch-zoom/);
  assert.match(read('src/main.jsx'), /import '\.\/premium-design-v60\.css';/);
});

// The v61 redesign composes the approved reference screens, not dummy trading data.
test('reference handoff layer has real chart, order handlers and narrow-screen layout', () => {
  const css = read('src/fyers-reference-v61.css');
  const screen = read('src/components/FyersReferenceViews.jsx');
  assert.ok(postcss.parse(css).nodes.length > 50);
  assert.match(css, /fyers-ref-trade-grid/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) 430px/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(screen, /<TraderMarketPanel snapshot=\{snapshot\}/);
  assert.match(screen, /<NiftyStrategyChart snapshot=\{snapshot\}/);
  assert.match(screen, /<CoreQuickActions snapshot=\{snapshot\}/);
  assert.match(screen, /buildScalpTicket\(snapshot, ev, settings, 'USER'/);
  assert.match(screen, /<History history=\{filtered\}/);
  assert.match(read('src/main.jsx'), /import '\.\/fyers-reference-v61\.css';/);
  assert.doesNotMatch(screen, /24,386\.35|₹1,462|25,539\.85/);
});

test('v62 design explicitly restores mobile hamburger, keeps seven workflow cards and removes 1m interval', () => {
  const app = read('src/AppV3.jsx');
  const workflow = read('src/components/MentorWorkflow.jsx');
  const chart = read('src/components/NiftyStrategyChart.jsx');
  const view = read('src/components/FyersReferenceViews.jsx');
  const css = read('src/fyers-reference-v62.css');
  assert.ok(postcss.parse(css).nodes.length > 10);
  assert.match(app, /className="fyers-ref-mobile-header"/);
  assert.match(app, /className="fyers-ref-mobile-menu"/);
  assert.match(css, /workflow-step:nth-child\(7\)/);
  assert.match(css, /grid-column:3 \/ span 2/);
  assert.match(workflow, /id: 'approval'/);
  assert.doesNotMatch(chart, /'1': \{ label: '1m'/);
  assert.doesNotMatch(view, /availableTimeframes=\{\['1'/);
  assert.match(read('src/main.jsx'), /import '\.\/fyers-reference-v62\.css';/);
});
