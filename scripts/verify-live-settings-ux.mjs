// Browser-only fake responses. No real server, account or order is used.
import { fakeSignedIn } from './lib/fake-signed-in.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],{stdio:'ignore',env:{...process.env,GITHUB_ACTIONS:'true'}});
let browser;
try{
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,'Preview unavailable');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const errors=[],actions=[],buys=[];let buyingOn=false, rejectBuy=false, rejectStatus=false, partSale=null;
  const shown={available:true,symbol:'NSE:NIFTY26D0126000PE',quantity:130,lots:2,buyPrice:230,premiumCost:29900,feeReserve:100,initialStop:220};
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.includes('/api/orders/')){
      const action=path.split('/').at(-1);actions.push(action);
      if(action==='status' && rejectStatus)return route.fulfill({status:503,contentType:'application/json',body:'{"error":"UNAVAILABLE"}'});
      if(action==='status'&&partSale)return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,realMoneyEnabled:true,exitsAllowed:true,actualBrokerAcceptanceVerified:false,attentionRequired:'OWNED_POSITION_REQUIRES_ATTENTION',positions:[{id:'t1',strategy:'SCALP',state:'MANAGING',symbol:shown.symbol}],partSales:[partSale],settings:{tradeAmount:30000}})});
      if(action==='status')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,realMoneyEnabled:buyingOn,actualBrokerAcceptanceVerified:false,attentionRequired:false,positions:[],settings:{tradeAmount:30000,mentorAutoOpen:false,scalpAutoOpen:false}})});
      if(action==='preview')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,preview:{trades:{CORE:{available:false,reason:'MENTOR_ENTRY_NOT_READY'},SCALP:shown}}})});
      if(action==='buy'){buys.push(route.request().postDataJSON());return new Promise(done=>setTimeout(done,700)).then(()=>route.fulfill({status:rejectBuy?409:200,contentType:'application/json',body:JSON.stringify(rejectBuy?{error:'ORDER_NOT_ACCEPTED_CHECK_STATUS',reason:'PRICE_MOVED_REFRESH_PLAN'}:{ok:true,order:{state:'MANAGING'}})}));}
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    }
    if(path.endsWith('/execution/check'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({realMoneyEnabled:false,checks:[{passed:true,journalRows:1,replayCreatedOrders:0},{passed:true,journalRows:1,replayCreatedOrders:0}]})});
    return route.fulfill({status:401,contentType:'application/json',body:'{"error":"Offline UI test"}'});
  });
  await fakeSignedIn(page);
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('.mentor-sidebar-v2').getByRole('button',{name:/Settings/}).first().click();
  await page.getByRole('button',{name:/Advanced connection and full settings/}).click();
  const card=page.getByRole('region',{name:'Real-money trading setup'});
  await card.waitFor({state:'visible'});
  await card.getByText('Buying is OFF',{exact:true}).waitFor();
  assert.match(await card.innerText(),/Not yet verified/);
  assert.ok(actions.includes('status'),'Opening Settings checks status automatically');
  assert.deepEqual(actions.filter(action=>!['status','preview'].includes(action)),[],'Automatic checks only read');
  const firstReads=actions.length;
  await page.locator('.mentor-sidebar-v2').getByRole('button',{name:/Scalp/}).first().click();
  await page.locator('.mentor-sidebar-v2').getByRole('button',{name:/Settings/}).first().click();
  await page.getByRole('button',{name:/Advanced connection and full settings/}).click();
  await card.getByText('Buying is OFF',{exact:true}).waitFor();
  assert.ok(actions.length>firstReads,'Returning to Settings checks again without a click');
  const beforeFocus=actions.length;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(()=>document.querySelector('.live-setup-badge')?.textContent==='Buying is OFF');
  assert.ok(actions.length>beforeFocus,'Returning to the browser refreshes server status');
  assert.deepEqual(actions.filter(action=>!['status','preview'].includes(action)),[],'Navigation/focus never sends orders or settings');
  rejectStatus=true;
  await card.getByRole('button',{name:'Refresh connection',exact:true}).click();
  await card.getByRole('alert').filter({hasText:'The trading connection could not be checked'}).waitFor();
  assert.equal(await card.getByRole('button',{name:'Buy Scalp · real money',exact:true}).isDisabled(),true,'A failed check cannot leave stale trading controls enabled');
  rejectStatus=false;
  await card.getByRole('button',{name:'Refresh connection',exact:true}).click();
  await card.getByText('Buying is OFF',{exact:true}).waitFor();


  const scalp=page.getByRole('region',{name:'Scalp real-money buy'});
  await scalp.getByText('NSE:NIFTY26D0126000PE').waitFor();
  assert.match(await scalp.innerText(),/REAL MONEY/);
  assert.match(await scalp.innerText(),/130 \(2 lots\)/);
  assert.match(await scalp.innerText(),/29,900 \+ charges/);
  const buyButton=scalp.getByRole('button',{name:'Buy Scalp · real money',exact:true});
  assert.equal(await buyButton.isDisabled(),true,'Buying off keeps Buy disabled');
  assert.equal(buys.length,0);
  const signOutCard=page.getByRole('region',{name:'App sign-in'});
  await signOutCard.getByRole('button',{name:'Sign out all devices',exact:true}).waitFor();
  await card.getByText('Automatic real-money entries',{exact:true}).click();
  assert.equal(await card.getByRole('checkbox').first().isDisabled(),true);
  assert.equal(await card.getByRole('checkbox').nth(1).isDisabled(),true);
  const paper=page.locator('.live-paper-check');
  assert.equal(await paper.getAttribute('open'),null,'Practice diagnostics start collapsed');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    const buttons=await card.locator('.live-setup-buy-list button').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}));
    assert.ok(buttons.every(b=>b.height>=44&&b.x>=0&&b.x+b.width<=width+1),'Buttons have readable sizes and stay inside the viewport');
    assert.ok(buttons[0].x+buttons[0].width<=buttons[1].x+1||buttons[0].y+buttons[0].height<=buttons[1].y+1,'Buttons do not overlap');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Settings must not overflow horizontally');
  }
  // Fake server with buying on: one tap sends one request with no second step.
  buyingOn=true;
  await card.getByRole('button',{name:'Refresh connection',exact:true}).click();
  await card.getByText('Buying is ON',{exact:true}).waitFor();
  await page.waitForFunction(()=>[...document.querySelectorAll('.live-setup-buy')].some(b=>!b.disabled));
  await buyButton.evaluate(node=>{node.click();node.click();node.click();});
  await scalp.getByText('Order waiting. Sending to your server…').waitFor();
  if(process.env.SCREENSHOTS)await scalp.screenshot({path:process.env.SCREENSHOTS+'/buy-waiting.png'});
  await scalp.getByText('Bought. Your stop is confirmed.').waitFor();
  assert.equal(buys.length,1,'Repeated taps send one request');
  assert.deepEqual({...buys[0],intentId:'x'},{intentId:'x',strategy:'SCALP',symbol:shown.symbol,quantity:130,maxPrice:230,tradeAmount:30000});
  rejectBuy=true;
  await page.waitForTimeout(3300);
  await buyButton.click();
  await scalp.getByText(/Buy refused: The price went up after you saw it/).waitFor();
  assert.equal(buys.length,2);
  if(process.env.SCREENSHOTS){await page.setViewportSize({width:390,height:844});await card.screenshot({path:process.env.SCREENSHOTS+'/panel-phone.png'});await signOutCard.screenshot({path:process.env.SCREENSHOTS+'/sign-out-phone.png'});}
  // Part of a trade sold by hand: a clear warning, and no app Exit for that trade.
  for(const [reduced,wanted] of [[true,/reduced its stop to 65 at the same stop price.*will not trail.*end of the day/],[false,/NOT confirmed a smaller stop: it may still be for quantity 130.*Check FYERS now/]]){
    partSale={id:'t1',symbol:shown.symbol,held:65,stopQuantity:reduced?65:130,stopReduced:reduced};
    await card.getByRole('button',{name:'Refresh connection',exact:true}).click();
    await card.getByRole('alert').filter({hasText:wanted}).waitFor();
    assert.match(await card.innerText(),/Locked after a part sale\. Your server is not managing this trade/);
    assert.doesNotMatch(await card.innerText(),/Position is being managed/);
    assert.equal(await card.getByRole('button',{name:'Exit this real position'}).isDisabled(),true);
    if(process.env.SCREENSHOTS)await card.screenshot({path:process.env.SCREENSHOTS+'/part-sale-'+reduced+'.png'});
  }
  partSale=null;
  buyingOn=false;
  await paper.locator('summary').click();
  await paper.getByRole('button',{name:'Run practice check'}).click();
  await paper.getByText(/Practice checks passed for 13-point and Scalp/).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS simple live settings: automatic status, one-tap buy with fake server, one request for repeated taps, refusal reason, disabled buying/auto-entry, practice check and desktop/mobile sizing');
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
