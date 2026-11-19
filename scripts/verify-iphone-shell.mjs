// Run separately in the GitHub verification workflow after installing Playwright.
// Mobile-browser geometry assertions catch regressions that static CSS tests miss.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:4173/index-options-mentor-pwa/';
const server = spawn(process.execPath,
  ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4173'],
  { env: { ...process.env, GITHUB_ACTIONS: 'true' }, stdio: 'ignore' }
);
let browser;
try {
  let available = false;
  for (let i = 0; i < 70; i++) {
    try { if ((await fetch(base)).ok) { available = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(available, 'Built PWA preview did not come online');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.route('**/api/**', route => route.fulfill({
    status: 401, contentType: 'application/json',
    body: JSON.stringify({ error: 'FYERS not connected in test session' })
  }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.premium-strategy-segment').waitFor({ state: 'visible' });

  const header = page.locator('.mentor-v2-topbar');
  const nav = page.locator('.premium-mobile-bottom-nav');
  const main = page.locator('.mentor-v2-content');
  const strategy = page.locator('.premium-strategy-bar');

  const headBox = await header.boundingBox();
  const strategyBox = await strategy.boundingBox();
  const navBox = await nav.boundingBox();
  assert.ok(headBox && strategyBox && navBox);
  assert.ok(Math.abs(headBox.y) < 2, 'Header must be pinned to top of viewport');
  assert.ok(headBox.height >= 64, 'Full header must be visible');
  assert.ok(strategyBox.y >= headBox.y + headBox.height - 2,
    'Initial launch must not crop first strategy card behind header');
  const visual = await header.evaluate(element => {
    const style = getComputedStyle(element);
    return { position: style.position, backdrop: style.backdropFilter,
      webkitBackdrop: style.webkitBackdropFilter, background: style.backgroundColor };
  });
  assert.equal(visual.position, 'fixed');
  assert.equal(visual.backdrop, 'none', 'Header must not blur its own text');
  assert.equal(visual.webkitBackdrop, 'none');
  assert.equal(visual.background, 'rgb(8, 26, 43)', 'Header must use opaque dark surface');
  assert.ok(navBox.y >= 740 && navBox.y + navBox.height <= 846,
    'Navigation must stay within bottom of 844px iPhone viewport');

  await page.locator('.premium-strategy-segment button').nth(1).click();
  await page.locator('.scalp-decision-card').waitFor({ state: 'visible' });
  const dock = page.locator('.scalp-quick-actions');
  const dockBox = await dock.boundingBox();
  const navBox2 = await nav.boundingBox();
  assert.ok(dockBox && navBox2);
  assert.ok(dockBox.y + dockBox.height <= navBox2.y + 2,
    'BUY/SELL dock must be entirely above bottom nav');
  assert.ok(dockBox.y >= 0);
  assert.ok((await main.boundingBox()).y >= headBox.height - 2);
  await page.evaluate(() => window.scrollTo(0, 450));
  await page.waitForTimeout(100);
  assert.ok(Math.abs((await header.boundingBox()).y) < 2,
    'Header must not move offscreen during chart scrolling');

  await page.locator('.premium-mobile-bottom-nav button').nth(3).click();
  await page.getByText('Trade journal', { exact: true }).first().waitFor();
  await page.waitForTimeout(80);
  const top = await page.evaluate(() => window.scrollY);
  assert.ok(top < 3, 'Navigating from Scalp to Journal must reset scroll position');
  const navBox3 = await nav.boundingBox();
  assert.ok(navBox3.y + navBox3.height <= 846);
  assert.equal(await page.locator('.scalp-quick-actions').count(), 0,
    'Trading dock should not overlay the journal');

  await page.locator('.premium-mobile-bottom-nav button').nth(0).click();
  await page.locator('.premium-strategy-segment').waitFor();
  await page.waitForTimeout(80);
  assert.ok(Math.abs((await header.boundingBox()).y) < 2);
  const refreshedStrategyBox = await strategy.boundingBox();
  assert.ok(refreshedStrategyBox.y >= (await header.boundingBox()).height - 2);
  console.log('PASS: iPhone header, Scalp dock, nav, Journal and startup scroll geometry');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
