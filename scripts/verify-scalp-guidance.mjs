// Real mobile-browser smoke for the paper-only option-premium profit trail
// and formerly invisible "What matters now" on the Scalp position.
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
  let ready = false;
  for (let i = 0; i < 70; i++) {
    try {
      if ((await fetch(base)).ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, 'Vite preview not running');

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true
  });

  await page.addInitScript(() => {
    localStorage.setItem('index-options-mentor-scalp-position-v41', JSON.stringify({
      id: 'test-scalp-profit-trail-01',
      mode: 'SIMULATION',
      strategyFamily: 'SCALP',
      strategyTier: 'SCALP',
      side: 'CE',
      symbol: 'NSE:NIFTY26NOV25400CE',
      lots: 10, quantity: 650,
      entry: 168, currentPrice: 151,
      underlyingEntry: 25500.65,
      underlyingCurrent: 25475,
      underlyingStop: 25456.87,
      underlyingTarget: 25544.43,
      bestR: 0.41, worstR: -0.59, currentR: -0.59,
      currentUnrealizedPnl: -11050,
      peakUnrealizedPnl: 8000,
      optionTrailingActive: true,
      optionTrailingFloorPnl: 4000,
      lastOptionQuoteAt: null,
      openedAt: new Date().toISOString(),
      score: 100, rr: 1, scalpMaxHoldMinutes: 12
    }));
    // This is a visual fixture. Prevent this deliberately losing trade from
    // exiting while its contrast/scroll layout is being inspected.
    localStorage.setItem('index-options-mentor-settings-v2', JSON.stringify({
      scalpAutoClose: false
    }));
  });

  await page.route('**/api/**', route => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: '{"error":"No authenticated FYERS session in screenshot test"}'
  }));
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.premium-mobile-bottom-nav button').nth(1).click();
  const panel = page.locator('.position-essential-card').first();
  await panel.waitFor({ state: 'visible' });
  const trail = panel.locator('.scalp-option-trail-indicator');
  await trail.waitFor({ state: 'visible' });

  const trailText = await trail.innerText();
  assert.match(trailText, /OPTION PROFIT TRAIL/);
  assert.match(trailText, /ACTIVE · exit threshold/);
  assert.match(trailText, /4,000/);
  assert.match(trailText, /8,000/);

  const guidance = panel.locator('.position-guidance-compact');
  await guidance.waitFor({ state: 'visible' });
  assert.ok((await guidance.innerText()).includes('WHAT MATTERS NOW'),
    'Guidance contents must not be missing');

  const colors = await guidance.evaluate(el => {
    const styles = getComputedStyle(el);
    const strong = getComputedStyle(el.querySelector('strong'));
    const small = getComputedStyle(el.querySelector('small'));
    return {
      background: styles.backgroundColor,
      foreground: strong.color,
      secondary: small.color
    };
  });
  const luminance = color => {
    const channels = color.match(/[\d.]+/g).slice(0,3).map(Number).map(v => {
      const x=v/255; return x<=.04045 ? x/12.92 : ((x+.055)/1.055)**2.4;
    });
    return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
  };
  const contrast = (a,b) => (Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);
  assert.ok(contrast(colors.background,colors.foreground)>=4.5,'Guidance message retains readable contrast');
  assert.ok(contrast(colors.background,colors.secondary)>=4.5,'Guidance detail retains readable contrast');

  await guidance.evaluate(el => window.scrollTo({
    top: window.scrollY + el.getBoundingClientRect().top - 160
  }));
  await page.waitForTimeout(150);

  const guidanceBox = await guidance.boundingBox();
  const dockBox = await page.locator('.scalp-quick-actions').boundingBox();
  const navBox = await page.locator('.premium-mobile-bottom-nav').boundingBox();

  assert.ok(guidanceBox && dockBox && navBox);
  assert.ok(guidanceBox.y > 0 && guidanceBox.y + guidanceBox.height < dockBox.y,
    'What matters now must be fully scrollable ABOVE fixed trade dock');
  assert.ok(dockBox.y + dockBox.height <= navBox.y + 2,
    'BUY/SELL and bottom navigation must never overlap');

  console.log('PASS: Scalp paper profit trail floor and guidance contrast/scroll/exit dock in 390x844 mobile viewport');
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}

