import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('iPhone header uses a fixed opaque status-bar-safe surface without backdrop blur', () => {
  const css = read('src/iphone-shell-v52.css');
  const parsed = postcss.parse(css, { from: 'src/iphone-shell-v52.css' });
  assert.ok(parsed.nodes.length);
  assert.match(css, /--iom-v52-safe-top:\s*env\(safe-area-inset-top/);
  assert.match(css, /padding-top:\s*calc\(var\(--iom-v52-mobile-header\) \+ var\(--iom-v52-safe-top\)\)/);
  assert.match(css, /\.premium-fintech-shell \.mentor-v2-topbar\s*\{[\s\S]*?position:\s*fixed !important/);
  assert.match(css, /\.premium-fintech-shell \.mentor-v2-topbar\s*\{[\s\S]*?background:\s*#081a2b !important/);
  assert.match(css, /-webkit-backdrop-filter:\s*none !important/);
  assert.match(css, /filter:\s*none !important/);
  assert.match(css, /brand-title[\s\S]*?text-overflow:\s*ellipsis !important/);
  assert.match(css, /mentor-drawer-backdrop[\s\S]*?z-index:\s*1200 !important/);
});

test('one consistent mobile dock/nav stack reserves chart clearance and home indicator area', () => {
  const css = read('src/iphone-shell-v52.css');
  assert.match(css, /--iom-v52-mobile-nav:\s*66px/);
  assert.match(css, /--iom-v52-mobile-trade:\s*68px/);
  assert.match(css, /--iom-v52-safe-bottom:\s*env\(safe-area-inset-bottom/);
  assert.match(css, /\.premium-fintech-shell \.strategy-quick-actions,\s*\.premium-fintech-shell \.scalp-quick-actions/);
  assert.match(css, /bottom:\s*calc\(var\(--iom-v52-mobile-nav\) \+ var\(--iom-v52-safe-bottom\)\) !important/);
  assert.match(css, /height:\s*var\(--iom-v52-mobile-trade\) !important/);
  assert.match(css, /\.premium-fintech-shell \.premium-mobile-bottom-nav\s*\{/);
  assert.match(css, /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\) !important/);
  assert.match(css, /padding-bottom:\s*calc\(\s*var\(--iom-v52-mobile-nav\) \+ var\(--iom-v52-mobile-trade\)/);
  assert.match(css, /scroll-margin-top:/);
});

test('Index PWA resets scroll on initial load and when selecting strategy or page', () => {
  const app = read('src/AppV3.jsx');
  const main = read('src/main.jsx');
  const sw = read('public/sw.js');
  assert.match(main, /window\.history\.scrollRestoration\s*=\s*'manual'/);
  assert.match(app, /window\.scrollTo\(0, 0\)/);
  assert.match(app, /\[view, strategyMode\]/);
  assert.ok(main.indexOf("import './iphone-shell-v52.css'") >
            main.indexOf("import './premium-trading-v51.css'"));
  assert.match(sw, /index-options-mentor-pwa-v52-header-safearea/);
  assert.doesNotMatch(app, /StockScanner|StockPaperPosition|strategyMode === 'stock'/);
});

test('iPhone shell fix does not alter Prime or strategy engine modules', () => {
  const app = read('src/AppV3.jsx');
  const refresh = read('src/services/fyersRefreshPolicy.js');
  assert.match(app, /ScalpMentorDashboard/);
  assert.match(app, /MobileMentorDashboardV41/);
  assert.match(refresh, /quoteMs/);
  assert.match(app, /CoreQuickActions/);
});
