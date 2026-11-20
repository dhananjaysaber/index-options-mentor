// Browser smoke: SELL from each strategy must close only that position,
// keep rendering all four mobile tabs, and write one journal record per ID.
// Usage after npm run build: node scripts/verify-sell-no-black.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4173/index-options-mentor-pwa/';
const server = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4173'],
  { env: { ...process.env, GITHUB_ACTIONS: 'true' }, stdio: 'ignore' });
let browser;
try {
  let ready = false;
  for (let i = 0; i < 70; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Vite preview did not start');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 3
  });
  const exceptions = [];
  page.on('pageerror', error => exceptions.push(error.message));
  await page.addInitScript(() => {
    const basePosition = {
      mode: 'SIMULATION', side: 'CE', lots: 10, quantity: 650,
      entry: 170, currentPrice: 184, underlyingEntry: 25550,
      underlyingCurrent: 25590, underlyingStop: 25475,
      underlyingTarget: 25625, rr: 1, bestR: .54, worstR: -.1,
      currentR: .54, peakUnrealizedPnl: 9500,
      currentUnrealizedPnl: 9100, openedAt: new Date().toISOString()
    };
    localStorage.setItem('index-options-mentor-core-position-v41', JSON.stringify({
      ...basePosition, id: 'sell-smoke-core', symbol: 'NSE:NIFTY26NOV25450CE',
      strategyFamily: 'CORE', initiatedBy: 'MENTOR', strategyTier: 'FULL'
    }));
    localStorage.setItem('index-options-mentor-scalp-position-v41', JSON.stringify({
      ...basePosition, id: 'sell-smoke-scalp', symbol: 'NSE:NIFTY26NOV25600CE',
      strategyFamily: 'SCALP', initiatedBy: 'USER', scalpMaxHoldMinutes: 60
    }));
    localStorage.setItem('index-options-mentor-settings-v2', JSON.stringify({
      mentorAutoOpen: false, scalpAutoOpen: false,
      mentorAutoClose: false, scalpAutoClose: false
    }));
  });
  await page.route('**/api/**', route => route.fulfill({
    status: 401, contentType: 'application/json',
    body: '{"error":"Offline smoke test"}'
  }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.premium-mobile-bottom-nav button').nth(1).click();
  await page.locator('.scalp-quick-sell').click();
  await page.locator('.premium-mobile-bottom-nav').waitFor({ state: 'visible' });
  await page.locator('.premium-mobile-bottom-nav button').nth(0).click();
  await page.locator('.strategy-quick-sell').click();
  await page.locator('.premium-mobile-bottom-nav button').nth(2).click();
  const positionText = await page.locator('.dual-position-page').innerText();
  assert.match(positionText, /No simulated positions|No simulated position/i);
  await page.locator('.premium-mobile-bottom-nav button').nth(3).click();
  const historyText = await page.locator('.history-panel').innerText();
  assert.match(historyText, /NIFTY26NOV25450CE/);
  assert.match(historyText, /NIFTY26NOV25600CE/);
  const records = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('index-options-mentor-history-v05') || '[]'));
  assert.equal(records.filter(row => row.id === 'sell-smoke-core').length, 1);
  assert.equal(records.filter(row => row.id === 'sell-smoke-scalp').length, 1);
  assert.deepEqual(exceptions, [], 'SELL or tab navigation triggered browser error');
  console.log('PASS: Scalp and Core SELL keep all tabs responsive and record one closure each');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
