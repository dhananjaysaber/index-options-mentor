// Synthetic, intercepted API responses only. No broker or journal writes escape.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4173/index-options-mentor-pwa/';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','preview','--host','127.0.0.1','--port','4173'],{stdio:'ignore',env:{...process.env,GITHUB_ACTIONS:'true'}});
let browser;
try{
  let ready=false;
  for(let i=0;i<70;i++){try{if((await fetch(base)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}
  assert.ok(ready,'Preview did not start');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:2048,height:1152},serviceWorkers:'block'});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>localStorage.setItem('index-options-mentor-settings-v2',JSON.stringify({mentorAutoOpen:false,scalpAutoOpen:false,mentorAutoClose:false,scalpAutoClose:false})));
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    let data={ok:true,trades:[],candles:[]};
    if(path.endsWith('/status'))data={configured:true,authenticated:true};
    if(path.endsWith('/mentor-snapshot'))data={ok:true,live:true,generatedAt:new Date().toISOString(),market:{phase:'LIVE',sessionDate:'2026-11-25',spot:25550,vwap:25540,orh:25580,orl:25520,pdh:25600,pdl:25400,atr5:25},decision:{state:'WAIT',side:'CE',score:50,rr:1,canSuggestTrade:false,reasons:['Synthetic layout fixture']},option:{symbol:'NSE:NIFTY26D0126000CE',optionType:'CE',strike:26000,ltp:150,lotSize:65},setup:{},structure:{underlyingStop:25520,underlyingTarget:25580,riskPoints:30},parameters:['chop','trend','vwap','risk','liquidity','orb','close','retest','pd','volume','momentum','htf','time'].map((id,i)=>({id,label:id,mandatory:i<5,value:50,status:'red',gatePassed:false}))};
    if(path.endsWith('/quote'))data={d:[{n:'NSE:NIFTY50-INDEX',v:{lp:25550}},{n:'NSE:NIFTY26D0126000CE',v:{lp:150}}]};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const layout=page.locator('.desktop-core-layout'),plan=layout.locator('.core-compact-plan'),checklist=layout.locator(':scope > .quick-checklist');
  await plan.waitFor({state:'visible'});
  for(const width of [2048,1440,1024]){
    await page.setViewportSize({width,height:1152});
    const feed=await page.locator('.premium-feed-status').boundingBox(),outer=await layout.boundingBox(),left=await plan.boundingBox(),right=await checklist.boundingBox();
    assert.ok(feed&&outer&&left&&right);
    assert.ok(feed.width>=outer.width-4,'Data banner must span available content width');
    assert.ok(left.width>=300,'Trade plan must not collapse into a narrow column');
    assert.ok(right.width>=300,'Checklist must stay readable');
    if(width>=1280){assert.ok(Math.abs(left.y-right.y)<3,'Plan and checklist share their top edge');assert.ok(right.x>=left.x+left.width+12,'Desktop columns have separation');}
    else assert.ok(right.y>=left.y+left.height+12,'Smaller desktop stacks full-width panels');
    const chipHeights=await checklist.locator('.quick-chip').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().height));
    assert.ok(chipHeights.every(h=>h>=40&&h<110),'Checklist tiles must not stretch into tall empty boxes');
    const side=await page.locator('.mentor-sidebar-v2').boundingBox(),dock=await page.locator('.strategy-quick-actions').boundingBox();
    assert.ok(dock.x>=side.x+side.width-1,'Action bar must not hide under the sidebar');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'No horizontal page overflow');
  }
  await page.setViewportSize({width:390,height:844});
  assert.equal(await layout.isVisible(),false,'Desktop wrapper must stay hidden on mobile');
  assert.equal(await page.locator('.mobile-mentor-flow').isVisible(),true,'Existing mobile dashboard remains visible');
  assert.deepEqual(errors,[]);
  console.log('PASS 13-point desktop geometry at 2048/1440/1024; banner, readable panels, compact tiles, sidebar-safe actions and mobile isolation');
}finally{if(browser)await browser.close();server.kill('SIGTERM');}
