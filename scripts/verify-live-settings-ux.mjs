// Browser-only fake responses: review must never submit a real order.
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
  const errors=[],actions=[];let rejectPlan=false;
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.includes('/api/orders/')){
      const action=path.split('/').at(-1);actions.push(action);
      if(action==='status')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,realMoneyEnabled:false,actualBrokerAcceptanceVerified:false,attentionRequired:false,positions:[],settings:{tradeAmount:30000,mentorAutoOpen:false,scalpAutoOpen:false}})});
      if(action==='prepare')return route.fulfill({status:rejectPlan?409:200,contentType:'application/json',body:JSON.stringify(rejectPlan?{error:'ORDER_NOT_ACCEPTED_CHECK_STATUS'}:{ok:true,plan:{intentId:'fake-review',expiresAt:Date.now()/1000+60,buyPrice:230,lots:2,premiumCost:29900,initialStop:220,payload:{symbol:'NSE:NIFTY26D0126000PE',qty:130}}})});
      return route.fulfill({status:200,contentType:'application/json',body:'{"ok":true}'});
    }
    if(path.endsWith('/execution/check'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({realMoneyEnabled:false,checks:[{passed:true,journalRows:1,replayCreatedOrders:0},{passed:true,journalRows:1,replayCreatedOrders:0}]})});
    return route.fulfill({status:401,contentType:'application/json',body:'{"error":"Offline UI test"}'});
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('.mentor-sidebar-v2').getByRole('button',{name:/Settings/}).first().click();
  const card=page.getByRole('region',{name:'Real-money trading setup'});
  await card.waitFor({state:'visible'});
  assert.match(await card.innerText(),/Connection not checked/);
  assert.equal(await card.getByRole('button',{name:'Review Scalp trade',exact:true}).isDisabled(),true);
  await card.getByRole('button',{name:'Check trading connection',exact:true}).click();
  await card.getByText('Buying is OFF',{exact:true}).waitFor();
  assert.match(await card.innerText(),/Not yet verified/);
  await card.getByRole('button',{name:'Review Scalp trade',exact:true}).click();
  const plan=page.getByRole('region',{name:'Trade plan review'});
  await plan.waitFor({state:'visible'});
  assert.match(await plan.innerText(),/29,900/);
  assert.match(await plan.innerText(),/2 lots \/ 130/);
  assert.equal(await plan.getByRole('button',{name:'Submit this real buy'}).isDisabled(),true);
  assert.equal(actions.includes('submit'),false);
  await card.getByText('Automatic real-money entries',{exact:true}).click();
  assert.equal(await card.getByRole('checkbox').first().isDisabled(),true);
  assert.equal(await card.getByRole('checkbox').nth(1).isDisabled(),true);
  const paper=page.locator('.live-paper-check');
  assert.equal(await paper.getAttribute('open'),null,'Practice diagnostics start collapsed');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    const buttons=await card.locator('.live-setup-actions button').evaluateAll(nodes=>nodes.map(node=>{const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};}));
    assert.ok(buttons.every(b=>b.height>=44&&b.x>=0&&b.x+b.width<=width+1),'Buttons have readable sizes and stay inside the viewport');
    assert.ok(buttons[0].x+buttons[0].width<=buttons[1].x+1||buttons[0].y+buttons[0].height<=buttons[1].y+1,'Plan buttons do not overlap');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'Settings must not overflow horizontally');
  }
  rejectPlan=true;
  await card.getByRole('button',{name:'Review 13-point trade',exact:true}).click();
  await card.getByRole('alert').filter({hasText:'A trade plan could not be prepared'}).waitFor();
  assert.match(await card.getByRole('alert').innerText(),/No buy request was sent/);
  assert.equal(actions.includes('submit'),false);
  await paper.locator('summary').click();
  await paper.getByRole('button',{name:'Run practice check'}).click();
  await paper.getByText(/Practice checks passed for 13-point and Scalp/).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS simple live settings: checked status, plan-only review, disabled buying/auto-entry, contextual error, practice check, desktop/mobile sizing and no submit request');
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
