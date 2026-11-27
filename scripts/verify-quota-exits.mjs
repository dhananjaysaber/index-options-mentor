// Browser smoke: SELL from each strategy must close only that position,
// keep rendering all four mobile tabs, and write one journal record per ID.
// Usage after npm run build: node scripts/verify-sell-no-black.mjs
import { fakeSignedIn } from './lib/fake-signed-in.mjs';
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
    if(sessionStorage.getItem('quota-seeded')){Storage.prototype.setItem=function(){throw new DOMException('The quota has been exceeded.','QuotaExceededError');};return;}
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
    sessionStorage.setItem('quota-seeded','1');
    Storage.prototype.setItem=function(){throw new DOMException('The quota has been exceeded.','QuotaExceededError');};
  });
  await page.route('**/api/**', route => route.fulfill({
    status: 401, contentType: 'application/json',
    body: '{"error":"Offline smoke test"}'
  }));
  await fakeSignedIn(page);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.premium-mobile-bottom-nav button').nth(1).click();
  await page.locator('.fyers-ref-scalp-sell').click();
  await page.locator('.premium-mobile-bottom-nav').waitFor({ state: 'visible' });
  await page.locator('.premium-mobile-bottom-nav button').nth(0).click();
  await page.locator('.strategy-quick-sell').click();
  await page.locator('.premium-mobile-bottom-nav button').nth(2).click();
  const positionText = await page.locator('.fyers-ref-positions').innerText();
  assert.match(positionText, /No simulated positions|No simulated position/i);
  await page.locator('.premium-mobile-bottom-nav button').nth(3).click();
  const historyText = await page.locator('.history-panel').innerText();
  assert.match(historyText, /NIFTY26NOV25450CE/);
  assert.match(historyText, /NIFTY26NOV25600CE/);
  const records = await page.evaluate(async () => {
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('index-options-mentor-trading-state-v1');r.onsuccess=()=>resolve(r.result);r.onerror=reject;});
    const rows=await new Promise((resolve,reject)=>{const r=db.transaction('trades').objectStore('trades').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=reject;});db.close();return rows;
  });
  assert.equal(records.filter(row => row.id === 'sell-smoke-core').length,1);
  assert.equal(records.filter(row => row.id === 'sell-smoke-scalp').length,1);
  await page.reload();
  await page.locator('.premium-mobile-bottom-nav button').nth(3).click();
  assert.match(await page.locator('.history-panel').innerText(),/NIFTY26NOV25600CE/);
  await page.locator('.premium-mobile-bottom-nav button').nth(2).click();
  assert.match(await page.locator('.fyers-ref-positions').innerText(),/No simulated positions|No simulated position/i);
  assert.deepEqual(exceptions,[]);
  console.log('PASS quota-full iPhone: manual SELL for both strategies, one closure each and correct reopening');
  const auto=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  auto.on('pageerror',error=>exceptions.push(error.message));
  await auto.addInitScript(()=>{
    const RealDate=Date;const fixed=RealDate.parse('2026-11-25T05:30:00Z');
    window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
    if(!sessionStorage.getItem('quota-seeded')){
      localStorage.setItem('index-options-mentor-scalp-position-v41',JSON.stringify({id:'quota-auto',mode:'SIMULATION',strategyFamily:'SCALP',side:'CE',symbol:'NSE:NIFTY26NOV25400CE',lots:10,quantity:650,entry:170,currentPrice:174,underlyingEntry:25550,underlyingCurrent:25560,underlyingStop:25475,underlyingTarget:25625,rr:1,bestR:.5,worstR:0,currentR:.1,peakUnrealizedPnl:8000,currentUnrealizedPnl:2600,optionTrailingActive:true,optionTrailingFloorPnl:4000,lastOptionQuoteAt:new Date().toISOString(),openedAt:new Date().toISOString(),scalpMaxHoldMinutes:60}));
      localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({mentorAutoOpen:false,scalpAutoOpen:false,mentorAutoClose:false,scalpAutoClose:true}));
      sessionStorage.setItem('quota-seeded','1');
    }
    Storage.prototype.setItem=function(){throw new DOMException('The quota has been exceeded.','QuotaExceededError');};
  });
  await auto.route('**/api/**',route=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"Offline quota test"}'}));
  await fakeSignedIn(auto);
  await auto.goto(base,{waitUntil:'domcontentloaded'});
  await auto.locator('.premium-mobile-bottom-nav button').nth(3).click();
  await auto.locator('.history-panel').getByText('NIFTY26NOV25400CE',{exact:false}).first().waitFor();
  const automatic=await auto.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('index-options-mentor-trading-state-v1');r.onsuccess=()=>resolve(r.result);});
    const row=await new Promise(resolve=>{const r=db.transaction('trades').objectStore('trades').get('quota-auto');r.onsuccess=()=>resolve(r.result);});db.close();return row;
  });
  assert.equal(automatic.exit,174,'exit uses observed premium, not historical floor');
  assert.equal(automatic.exitReasonCode,'SCALP_OPTION_PROFIT_TRAIL');
  await auto.reload();
  await auto.locator('.premium-mobile-bottom-nav button').nth(3).click();
  await auto.locator('.history-panel').getByText('NIFTY26NOV25400CE',{exact:false}).first().waitFor();
  assert.deepEqual(exceptions,[]);
  console.log('PASS quota-full iPhone: automatic trailing exit saved at observed price and survives reopening');
} finally {
  if(browser)await browser.close();server.kill('SIGTERM');
}


